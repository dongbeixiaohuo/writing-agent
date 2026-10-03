/** Isolated public-fact smoke test. Uses the existing MiniMax profile, never user manuscripts. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createFactSearchTools, type FactSearchConfiguration } from '../../packages/application/src/fact-search.js';
import { SearchSettingsStore } from '../../apps/desktop/src/search-settings.js';

// Never put a live credential in arguments, fixtures or the persisted workspace.
const tavilyOnly = process.argv.includes('--tavily-only');
const credentials = createDefaultCredentialBroker();
const searchStore = new SearchSettingsStore(join(process.env.APPDATA!, 'Writing Agent', 'search-settings.json'), credentials);
const tavilyKey = process.env.WA_TAVILY_TEST_KEY ?? (tavilyOnly ? await searchStore.configuration().getTavilyKey?.() : undefined);
delete process.env.WA_TAVILY_TEST_KEY;
if (process.argv.includes('--verify-connections')) {
  for (const service of ['tavily', 'parallel'] as const) {
    const status = await searchStore.verify(service);
    console.log(JSON.stringify({ phase: 'connection_verification', service, result: status.verification?.[service] }));
  }
  if (process.argv.includes('--probe-only')) process.exit(0);
}
if (tavilyOnly) {
  assert.ok(tavilyKey, 'Set WA_TAVILY_TEST_KEY in the test process environment');
  const requests: Array<{ status: number; elapsedMs: number }> = [];
  const probe = createFactSearchTools({
    configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, authorizeQuery: async ({ query }) => /国庆|中华人民共和国|成立/.test(query), getTavilyKey: async () => tavilyKey }),
    fetch: async (url, init) => {
      const start = Date.now();
      const response = await fetch(url, init);
      requests.push({ status: response.status, elapsedMs: Date.now() - start });
      return response;
    },
  });
  const query = '中华人民共和国成立于哪一年 国庆节 10月1日 site.gov.cn';
  const result = await probe.search(query);
  const again = await probe.search(query);
  assert.equal(result.mode, 'external', 'Tavily must return actual evidence');
  assert.equal(result.provider, 'tavily');
  assert.ok(!JSON.stringify(result).includes(tavilyKey));
  const sources = JSON.parse(result.evidenceText) as Array<{ title: string; url: string; excerpt: string }>;
  assert.ok(sources.length > 0, 'Live search must not be empty');
  assert.ok(sources.some(source => source.excerpt.includes('1949')), 'Search must return relevant excerpts');
  assert.deepEqual(again, { ...result, cacheHit: true });
  assert.equal(requests.length, 1, 'Repeated query must reuse cached evidence');
  console.log(JSON.stringify({ phase: 'tavily_search_probe', ok: true, requests,
    resultCount: sources.length, sources: sources.map(({ title, url }) => ({ title, url })),
    repeatedQueryUsedCache: true, credentialInResult: false }, null, 2));
}

const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const profile = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model))
  ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(profile, 'MiniMax profile required');
const provider = createConfiguredProvider(profile.config, createDefaultCredentialBroker());
for (const parallelEnabled of tavilyOnly ? [false] : process.argv.includes('--parallel-only') ? [true] : [false, true]) {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-search-live-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const actor = { kind: 'user', id: 'isolated-search-test' } as const;
  storage.createProject({ projectId: 'p', name: '公开事实搜索测试', operationId: 'create', mode: 'quick', actor });
  for (const [kind, content] of [
    ['body', '# 国庆的随想\n\n中华人民共和国的国庆节是每年的10月1日。\n\n中华人民共和国成立于1959年10月1日。\n\n对我来说，假期像一阵温柔的风。'],
    ['evidence', '{"claims":[],"notes":"公开事实测试，无用户私有信息。请核查日期；比喻不是事实错误。"}'],
  ] as const) {
    const committed = storage.commitArtifactVersion({ projectId: 'p', operationId: kind, expectedProjectRevision: storage.inspectProject('p')!.revision,
      kind, logicalKey: 'main', baseVersionId: null, content, reason: 'isolated smoke test', actor });
    assert.equal(committed.ok, true);
  }
  const searchConfiguration: FactSearchConfiguration = { parallelEnabled, tavilyEnabled: tavilyOnly,
    // Explicit test-harness approval, synthetic public topic only; no private materials are loaded.
    authorizeQuery: async ({ query }) => /国庆|中华人民共和国|成立/.test(query),
    ...(tavilyOnly ? { getTavilyKey: async () => tavilyKey } : {}) };
  const app = new WritingApplicationService({ storage, provider, factSearchConfiguration: () => searchConfiguration });
  try {
    const start = Date.now();
    const result = await app.runFactCheck({ projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
      model: profile.config.model, parameters: { temperature: 0, toolChoice: 'auto' },
      budget: { maxModelRequests: 12, maxToolCalls: 20, maxRetriesPerRequest: 1, maxMajorRevisions: 0 },
      signal: AbortSignal.timeout(180_000) });
    const events = storage.listRunEvents(result.runId);
    const tools = events.filter(e => e.type === 'tool.completed' || e.type === 'tool.failed').map(e => {
      const envelope = e.payload.result as any;
      return { name: envelope?.toolName, ok: envelope?.ok, searchMode: envelope?.result?.mode, provider: envelope?.result?.provider, attempts: envelope?.result?.attempts, cacheHit: envelope?.result?.cacheHit, error: envelope?.error?.code };
    });
    const assessment = storage.getFactCheckStatus('p');
    assert.ok(!tavilyKey || !JSON.stringify(events).includes(tavilyKey), 'Credential must not enter persistent events');
    console.log(JSON.stringify({ mode: tavilyOnly ? 'tavily' : parallelEnabled ? 'parallel' : 'model_only', model: profile.config.model, elapsedMs: Date.now() - start,
      modelRequests: events.filter(e => e.type === 'request.dispatch_attempted').length,
      workspacePath, ok: result.ok, tools, status: assessment.status, claims: assessment.assessment?.payload.claims }, null, 2));
    assert.equal(result.ok, true, 'The model must finish and save its factual assessment');
    assert.ok(assessment.assessment?.payload.claims.some(c => c.claimText.includes('1959') && c.status === 'CONTRADICTED'));
    assert.ok(!assessment.assessment?.payload.claims.some(c => c.claimText.includes('温柔的风')));
    assert.equal(tools.some(t => t.name === 'search_fact_sources'), parallelEnabled || tavilyOnly);
    if (tavilyOnly) {
      assert.ok(events.some(e => e.type === 'search.progress' && String(e.payload.message).includes('Tavily 已发出')), 'Real provider dispatch must be observable');
      assert.ok(tools.filter(t => t.name === 'search_fact_sources' && !t.cacheHit).length <= 6);
      assert.ok(tools.some(t => t.name === 'search_fact_sources' && t.ok && t.searchMode === 'external' && t.provider === 'tavily'));
      assert.ok(assessment.assessment?.payload.claims.some(c => /https:\/\//.test(JSON.stringify(c))), 'Saved assessment must cite an external source');
    }
  } finally { storage.close(); }
}
