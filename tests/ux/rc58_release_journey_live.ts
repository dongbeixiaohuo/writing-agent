/** Opt-in paid real-model acceptance, synthetic project only. No production workspace writes. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';

assert.ok(process.argv.includes('--live'), 'Pass --live to authorize use of the existing MiniMax configuration');
const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const profile = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model))
  ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(profile, 'An existing MiniMax profile is required');
const real = createConfiguredProvider(profile.config, createDefaultCredentialBroker());
const requests: Array<{ actor: string; firstTextMs: number | null; textChunks: number; ms: number }> = [];
class ObservedProvider extends ModelProviderBase {
  constructor() { super(real.id, real.adapterVersion, real.capabilitiesFor(profile!.config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    assert.ok(requests.length < 90, 'Acceptance boundary: investigate instead of unbounded retries');
    const stateMessage = request.messages.find(m => m.content.includes('\nCOLLABORATION_STATE='));
    const state = stateMessage ? JSON.parse(stateMessage.content.split('\nCOLLABORATION_STATE=')[1]!) : null;
    const row = { actor: state?.actor ?? 'author', firstTextMs: null as number | null, textChunks: 0, ms: 0 };
    requests.push(row); const started = Date.now();
    try {
      for await (const event of real.stream(request)) {
        if (event.type === 'text_delta') { row.firstTextMs ??= Date.now() - started; row.textChunks++; }
        if (event.type !== 'tool_call_complete') yield event;
      }
    } finally {
      row.ms = Date.now() - started;
      console.log(JSON.stringify({ request: requests.length, ...row }));
    }
  }
}
const root = mkdtempSync(join(tmpdir(), 'wa-rc58-live-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const app = new WritingApplicationService({ storage, provider: new ObservedProvider() });
const bridge = createApplicationBridge({ service: app, workspaceId: root,
  model: { model: profile.config.model, parameters: { maxOutputTokens: 8192 }, providerLabel: 'MiniMax', credentialReference: null } });
const actor = { kind: 'user', id: 'release-synthetic-author' } as const;
const checkpoints: string[] = [];
const report: Record<string, unknown> = { status: 'FAIL', root, model: profile.config.model, requests, checkpoints,
  scope: 'Real director and all experts, seeded confirmed brief, natural confirmation via bridge, title, model-only fact check and export; not visual desktop acceptance' };
try {
  app.createProject({ projectId: 'p', operationId: 'create', name: '把周末留一点空白', mode: 'deep', actor });
  const brief = app.saveWritingBrief({ projectId: 'p', operationId: 'brief', expectedProjectRevision: storage.inspectProject('p')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '把周末留一点空白：允许自己不把休息变成另一项任务',
      genre: 'narrative_observation', audience: '普通成年人', lengthTarget: { targetCharacters: 300 }, materialIds: [],
      constraints: ['本次是独立验收的通用第二人称感受短文；不虚构亲历，不引名人、不写数字研究、不作医学建议；约300字，克制温和，非说教。'],
      interactionMode: 'co_creation', authorAuthorization: { voice: '克制温和的第二人称', styleReference: null,
        styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  assert.ok(brief.ok);
  const first = await app.runDraft({ projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
    expectedBriefVersionId: storage.inspectProject('p')!.currentBriefVersionId!, model: profile.config.model,
    parameters: { maxOutputTokens: 8192 }, budget: { maxModelRequests: 24, maxToolCalls: 32, maxRetriesPerRequest: 1, maxMajorRevisions: 1 },
    signal: AbortSignal.timeout(1_800_000) });
  await bridge.selectSession('p', first.sessionId);
  for (let turn = 0; turn < 12; turn++) {
    const snapshot = bridge.getSnapshot();
    if (snapshot.factCheckWorkspace.status === 'passed') break;
    const waiting = snapshot.recoverableRuns.find(r => r.sessionId === first.sessionId && r.status === 'waiting_user');
    assert.ok(waiting, `No author checkpoint: ${JSON.stringify(snapshot.recoverableRuns)}`);
    const label = waiting.inputRequest?.kind === 'publication_selection' ? 'title' : waiting.checkpointStage ?? waiting.stopReason;
    assert.ok(label && !checkpoints.includes(label), `Repeated checkpoint: ${label}`);
    checkpoints.push(label);
    assert.ok(['CO_CREATION_CHECKPOINT', 'WRITING_INPUT_REQUIRED'].includes(waiting.stopReason ?? ''), JSON.stringify(waiting));
    const candidates = waiting.inputRequest?.candidates;
    const reply = candidates?.length ? `就用「${candidates[0]!.title}」，标题确定了，继续核查，正文不要改。`
      : '认可这一阶段的结果，按这个版本继续下一位。';
    console.log(JSON.stringify({ checkpoint: label, reply }));
    await bridge.sendMessage(reply);
    const deadline = Date.now() + 300_000;
    for (;;) {
      const current = bridge.getSnapshot();
      if (current.connection !== 'running' && current.activeRunId === null) break;
      assert.ok(Date.now() < deadline, 'Turn timeout; inspect persisted events');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  assert.equal(bridge.getSnapshot().factCheckWorkspace.status, 'passed');
  for (const stage of ['outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review']) {
    assert.ok(checkpoints.includes(stage), `Missing separate confirmation: ${stage}`);
  }
  const exported = await bridge.exportPublication('html', { layoutPreset: 'clean' });
  report.exportPath = exported.relativePath;
  report.status = 'PASS';
} finally {
  report.finalGate = storage.getFactCheckStatus('p').status;
  bridge.dispose(); storage.close();
  mkdirSync('output/rc58', { recursive: true });
  writeFileSync(`output/rc58/live-journey-${Date.now()}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
