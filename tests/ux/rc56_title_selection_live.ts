/** Replays title selection with real MiniMax in online-backup workspaces only.
 * Restores the old candidate batch to reproduce the pre-incident mismatch.
 * Fact-check dispatch is observed, then stopped at a test boundary: no fake pass.
 */
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';

const [source, oldRunId, selectionText] = process.argv.slice(2);
assert.ok(source && oldRunId && selectionText && !selectionText.startsWith('--'), 'Pass source SQLite path, pending writing run ID, and the candidate title to select');
const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const entry = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model)) ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(entry);
const provider = createConfiguredProvider(entry.config, createDefaultCredentialBroker());
const root = mkdtempSync(join(tmpdir(), 'wa-rc56-title-'));
const currentOnly = process.argv.includes('--current-only');
const cases = currentOnly ? [{ text: selectionText, expected: 'select_title', advance: true }] : [
  { text: selectionText, expected: 'select_title', advance: true },
  { text: '这个标题不要用，换三个更简洁的，正文不要改', expected: 'generate_titles', advance: false },
  { text: '都挺好，ok', expected: 'clarify_title_selection', advance: false },
];
const results: unknown[] = [];
try {
  for (const [index, sample] of cases.entries()) {
    const workspace = join(root, String(index)); mkdirSync(join(workspace, '.writing-agent'), { recursive: true });
    const original = new DatabaseSync(source, { readOnly: true });
    const before = original.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=(SELECT project_id FROM runs WHERE id=?)').get(oldRunId);
    await backup(original, join(workspace, '.writing-agent/workspace.sqlite3')); original.close();
    const storage = openWorkspaceStorage({ workspacePath: workspace });
    const run = storage.getRun(oldRunId)!; assert.equal(run.status, 'waiting_user');
    const projectId = run.projectId;
    const currentBody = storage.inspectProject(projectId)!.latestBodyVersionId!;
    const oldBatch = storage.listArtifactVersions(projectId, 'report', 'author-publication-candidates')
      .map(v => JSON.parse(v.content)).find(v => v.bodyVersionId !== currentBody && v.candidates?.length === 5);
    assert.ok(oldBatch, 'Need the incident old batch of five');
    // Test-only restoration of the pre-incident persisted batch, not a production save.
    const batches = storage.listArtifactVersions(projectId, 'report', 'author-publication-candidates');
    const restored = currentOnly ? { ok: true } : storage.commitArtifactVersion({ projectId, operationId: `rc56-restore-batch-${index}`,
      expectedProjectRevision: storage.inspectProject(projectId)!.revision, kind: 'report', logicalKey: 'author-publication-candidates',
      baseVersionId: batches.at(-1)!.id, content: JSON.stringify(oldBatch), reason: 'rc56-test-restore-old-batch', actor: { kind: 'user', id: 'isolated-test' } });
    assert.equal(restored.ok, true);
    const titleCount = storage.listArtifactVersions(projectId, 'title', 'main').length;
    const batchCount = storage.listArtifactVersions(projectId, 'report', 'author-publication-candidates').length;
    const requests: { tools: string[]; ms: number }[] = [];
    let factDispatched = false;
    class ProbeProvider extends ModelProviderBase {
      constructor() { super(provider.id, provider.adapterVersion, provider.capabilitiesFor(entry!.config.model)); }
      protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        const names = request.tools?.map(t => t.name) ?? [];
        if (names.includes('submit_fact_check')) {
          factDispatched = true;
          assert.ok(JSON.stringify(request.messages).includes(currentBody), 'Check must bind current body');
        }
        if (factDispatched || (!sample.advance && !names.includes('interpret_author_reply'))) {
          yield { type: 'error', error: { code: 'PROVIDER_UNAVAILABLE', message: 'TEST_BOUNDARY: dispatch observed; intentionally not calling model further', retryable: false } }; return;
        }
        assert.ok(requests.length < 4, 'Bounded replay, no blind retries');
        const row = { tools: names, ms: 0 }; requests.push(row); const start = Date.now();
        for await (const event of provider.stream(request)) {
          if (event.type !== 'tool_call_complete') yield event;
          row.ms = Date.now() - start;
        }
        console.log(JSON.stringify({ case: index, ...row }));
      }
    }
    const app = new WritingApplicationService({ storage, provider: new ProbeProvider() });
    const bridge = createApplicationBridge({ service: app, workspaceId: workspace, initialProjectId: projectId,
      model: { model: entry.config.model, parameters: { maxOutputTokens: 2048 }, providerLabel: 'MiniMax', credentialReference: null } });
    try {
      await bridge.selectSession(projectId, run.sessionId);
      const sent = await bridge.sendMessage(sample.text);
      const deadline = Date.now() + 180_000;
      while (true) {
        const state = storage.getRun(sent.runId)!;
        if (!['running', 'pending'].includes(state.status) && (!sample.advance || factDispatched)) break;
        assert.ok(Date.now() < deadline, 'Title selection/handoff did not finish');
        await new Promise(r => setTimeout(r, 50));
      }
      const intent = JSON.parse(storage.listArtifactVersions(projectId, 'report', `author-intent:${sent.runId}`).at(-1)!.content);
      assert.equal(intent.intent, sample.expected);
      assert.equal(storage.inspectProject(projectId)!.latestBodyVersionId, currentBody);
      assert.equal(storage.listArtifactVersions(projectId, 'report', 'author-publication-candidates').length, batchCount);
      assert.equal(storage.listArtifactVersions(projectId, 'title', 'main').length, titleCount + Number(sample.advance));
      if (sample.advance) {
        assert.equal(intent.selectionIndex, currentOnly ? 1 : 4);
        assert.equal(storage.getRun(oldRunId)?.status, 'cancelled');
        const title = storage.getArtifactVersion(storage.inspectProject(projectId)!.currentTitleVersionId!)!;
        assert.ok(title.content.includes(sample.text));
        assert.ok(title.content.includes(currentBody));
        const reply = JSON.parse(storage.listArtifactVersions(projectId, 'report', `author-turn:${sent.runId}`).at(-1)!.content).reply;
        assert.match(reply, /已选定标题/u); assert.ok(reply.length < 180);
      } else assert.equal(factDispatched, false);
      assert.notEqual(storage.getFactCheckStatus(projectId).status, 'passed', 'No bypass of fact checking');
      const check = new DatabaseSync(source, { readOnly: true });
      const after = check.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=?').get(projectId); check.close();
      assert.deepEqual(after, before);
      const row = { text: sample.text, expected: sample.expected, actual: intent.intent, index: intent.selectionIndex,
        passed: true, factDispatched, requests, bodyUnchanged: true, originalWrites: 0 };
      results.push(row); console.log(JSON.stringify(row));
    } finally { bridge.dispose(); storage.close(); }
  }
} finally {
  mkdirSync(resolve('output/rc56-title-selection'), { recursive: true });
  writeFileSync(resolve(`output/rc56-title-selection/${currentOnly ? 'live-current-batch' : 'live'}.json`), JSON.stringify({ model: entry.config.model, root, results,
    passed: results.length === cases.length, boundary: 'Fact-check dispatch only; no completed fact-check claim' }, null, 2));
}
