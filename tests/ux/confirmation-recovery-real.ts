/** Real MiniMax intent interpretation + deterministic specialist bodies, in a fresh workspace only. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { ImmediateWorkflowProvider } from '../../packages/client-bridge/test/helpers/workflow-provider.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';

const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const profile = catalog.profiles.find(p => /minimax/i.test(p.config.providerId) && p.models.some(m => /MiniMax-M3/i.test(m)));
assert.ok(profile, 'A previously configured MiniMax-M3 profile is required; never create credentials or change defaults.');
const config = { ...profile.config, model: profile.models.find(m => m === 'MiniMax-M3') ?? profile.models.find(m => /MiniMax-M3/i.test(m))! };
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
const fixture = new ImmediateWorkflowProvider();
let liveCalls = 0;
class Hybrid extends ModelProviderBase {
  constructor() { super(real.id, real.adapterVersion, real.capabilitiesFor(config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    if (request.tools[0]?.name === 'interpret_author_reply') {
      assert.ok(++liveCalls <= 12, 'Stop the test if requests unexpectedly loop.');
      console.log(JSON.stringify({ liveCalls, phase: 'real-intent', at: new Date().toISOString() }));
      for await (const event of real.stream(request)) if (event.type !== 'tool_call_complete') yield event;
    } else if (request.tools.some(t => t.name === 'respond_author')) {
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'respond_author', argumentsDelta: JSON.stringify({ reply: '我们先讨论这一点，暂不推进。' }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    } else for await (const event of fixture.stream(request)) if (event.type !== 'tool_call_complete') yield event;
  }
}
const root = mkdtempSync(join(tmpdir(), 'wa-confirmation-live-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const provider = new Hybrid();
let service = new WritingApplicationService({ storage, provider });
let bridge: ReturnType<typeof createApplicationBridge> | undefined;
const report: Record<string, unknown> = { workspace: root, model: config.model, scope: 'real intent; synthetic stage output; no production project changes', samples: [] };
const actor = { kind: 'user', id: 'isolated-test' } as const;
try {
  service.createProject({ projectId: 'test', operationId: 'create', name: '确认与重启隔离回归', mode: 'quick', actor });
  const brief = service.saveWritingBrief({ projectId: 'test', operationId: 'brief', expectedProjectRevision: storage.inspectProject('test')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静的片刻', genre: 'narrative_observation', audience: '普通读者',
      lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: ['不虚构亲历'], interactionMode: 'co_creation',
      authorAuthorization: { voice: '克制', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  assert.ok(brief.ok);
  const budget = { maxModelRequests: 40, maxToolCalls: 60, maxRetriesPerRequest: 1, maxMajorRevisions: 1 };
  const first = await service.runDraft({ projectId: 'test', expectedProjectRevision: storage.inspectProject('test')!.revision,
    expectedBriefVersionId: storage.inspectProject('test')!.currentBriefVersionId!, model: config.model, parameters: {}, budget });
  const stage = () => storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage;
  assert.equal(stage(), 'outline');
  const samples = [['可以，顺便把这句存为参考材料：我每晚都会在窗边看十分钟夜景。先记下来再继续。', false],
    ['不同意', false], ['认可第一点，但第二点为什么要改？', false], ['先别交给下一位，解释一下', false],
    ['认同', true], ['认可；', true], ['我觉得你说的这些都挺对的，往下做吧', true]] as const;
  for (const [message, advance] of samples) {
    const before = stage();
    const author = service.startAuthorTurn({ projectId: 'test', sessionId: first.sessionId, model: config.model, parameters: { temperature: 0 }, userInstruction: message });
    const result = await author.result;
    assert.ok(result.ok, JSON.stringify(result));
    // Deliberately replace service/page after durable author reply, before any handoff callback.
    bridge?.dispose(); service = new WritingApplicationService({ storage, provider });
    bridge = createApplicationBridge({ service, model: { model: config.model, providerLabel: real.id, credentialReference: null, parameters: {}, budget }, workspaceId: 'isolated' });
    const deadline = Date.now() + 30000;
    while (storage.listRuns('test').some(r => r.status === 'running')) {
      assert.ok(Date.now() < deadline, 'Synthetic continuation must settle promptly');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await bridge.refresh();
    const intentArtifact = storage.listArtifactVersions('test', 'report', `author-intent:${author.runId}`).at(-1)!;
    const intent = JSON.parse(intentArtifact.content).intent;
    const sample = { message, intent, before, after: stage(), expectedAdvance: advance };
    (report.samples as unknown[]).push(sample); console.log(JSON.stringify(sample));
    assert.equal(stage() !== before, advance);
    assert.equal(storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
  }
  report.ok = true;
} catch (error) { report.error = String(error); process.exitCode = 1;
} finally {
  bridge?.dispose(); report.liveCalls = liveCalls;
  report.requests = storage.listEvents('test').filter(e => ['request.completed', 'request.failed', 'request.outcome_unknown'].includes(e.type))
    .map(e => ({ type: e.type, runId: e.runId,
      code: (e.payload.error as { code?: string } | undefined)?.code ?? e.payload.code,
      providerHttpStatus: e.payload.providerHttpStatus, stream: e.payload.stream, usage: e.payload.tokenUsage }));
  mkdirSync('output/desktop', { recursive: true });
  writeFileSync('output/desktop/confirmation-recovery-real.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok ?? false, error: report.error, liveCalls, root }));
  storage.close();
}
