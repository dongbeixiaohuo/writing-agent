/** Opt-in real MiniMax regression. Uses an isolated workspace; never edits provider settings or the author's projects. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const profile = catalog.profiles.find(p => /minimax/i.test(p.config.providerId) && p.models.some(m => /MiniMax-M3/i.test(m)));
assert.ok(profile, 'An existing MiniMax-M3 profile is required.');
const config = { ...profile.config, model: profile.models.find(m => m === 'MiniMax-M3') ?? profile.models.find(m => /MiniMax-M3/i.test(m))! };
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
let liveCalls = 0; let realReply = false;
class Provider extends ModelProviderBase {
  constructor() { super(real.id, real.adapterVersion, real.capabilitiesFor(config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    if (realReply || request.tools[0]?.name === 'interpret_author_reply') {
      assert.ok(++liveCalls <= 10, 'Unexpected request loop');
      console.log(JSON.stringify({ phase: 'real-request', liveCalls, at: new Date().toISOString() }));
      for await (const event of real.stream(request)) if (event.type !== 'tool_call_complete') yield event;
    } else {
      // Negative control: only intent is real; do not execute a real fact check.
      const name = request.tools.some(t => t.name === 'request_author_fact_check') ? 'request_author_fact_check' : 'respond_author';
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name,
        argumentsDelta: JSON.stringify(name === 'respond_author' ? { reply: '这里只讨论，不把稿件算作核查通过。' } : {}) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
}
const root = mkdtempSync(join(tmpdir(), 'wa-process-controls-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const service = new WritingApplicationService({ storage, provider: new Provider() });
const actor = { kind: 'user', id: 'isolated-test' } as const;
const report: Record<string, unknown> = { workspace: root, model: config.model, samples: [] };
try {
  storage.createProject({ projectId: 'test', operationId: 'create', name: '隔离测试', mode: 'quick', actor });
  storage.saveWritingBrief({ projectId: 'test', operationId: 'brief', expectedProjectRevision: storage.inspectProject('test')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静的片刻', genre: 'narrative_observation', audience: '普通读者',
      lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: [], interactionMode: 'co_creation',
      authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  storage.commitArtifactVersion({ projectId: 'test', operationId: 'body', expectedProjectRevision: storage.inspectProject('test')!.revision,
    kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 安静的片刻\n\n我喜欢给一天留一点安静。', reason: 'synthetic test body', actor });
  const body = storage.inspectProject('test')!.latestBodyVersionId;
  for (const [index, message, expected] of [[0, '核查的部分跳过吧', 'defer_fact_check'],
    [1, '不用联网，还是核查一下', 'fact_check'], [2, '可以跳过核查吗？先解释一下', 'discuss']] as const) {
    const before = liveCalls; const start = Date.now();
    const handle = service.startAuthorTurn({ projectId: 'test', sessionId: `session-${index}`, model: config.model, parameters: { temperature: 0 }, userInstruction: message });
    const result = await handle.result;
    assert.ok(result.ok, JSON.stringify(result));
    const intent = JSON.parse(storage.listArtifactVersions('test', 'report', `author-intent:${handle.runId}`).at(-1)!.content).intent;
    assert.equal(intent, expected);
    assert.equal(liveCalls - before, 1);
    const saved = JSON.parse(storage.listArtifactVersions('test', 'report', `author-turn:${handle.runId}`).at(-1)!.content);
    if (expected === 'defer_fact_check') { assert.equal(saved.requestedAction, null); assert.match(saved.reply, /未核查/); }
    const sample = { message, intent, durationMs: Date.now() - start, realRequests: liveCalls - before, scope: 'real intent; synthetic follow-up where needed' };
    (report.samples as unknown[]).push(sample); console.log(JSON.stringify(sample));
  }
  realReply = true;
  const before = liveCalls; const start = Date.now(); const lengths = new Set<number>();
  const handle = service.startAuthorTurn({ projectId: 'test', sessionId: 'reply-session', model: config.model, parameters: { temperature: 0 },
    userInstruction: '解释一下为什么工作稿仍可查看，但不能说已经通过核查。只需两句话，不改稿、不执行核查。' });
  let firstPreviewMs: number | null = null;
  const timer = setInterval(() => {
    const reply = service.getLiveReply('test', handle.sessionId, handle.runId);
    if (reply?.text) { firstPreviewMs ??= Date.now() - start; lengths.add(reply.text.length); }
  }, 40);
  let result;
  try { result = await handle.result; } finally { clearInterval(timer); }
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(lengths.size > 1, 'Must observe a growing reply before completion');
  const saved = JSON.parse(storage.listArtifactVersions('test', 'report', `author-turn:${handle.runId}`).at(-1)!.content);
  assert.ok(saved.reply.length > 0);
  assert.equal(liveCalls - before, 2, 'One interpretation + one streamed reply; no copy-to-save request');
  report.streaming = { scope: 'real intent and real public reply', durationMs: Date.now() - start, firstPreviewMs, distinctPreviewLengths: lengths.size,
    realRequests: liveCalls - before, saved: true };
  assert.equal(storage.inspectProject('test')!.latestBodyVersionId, body);
  assert.notEqual(storage.getFactCheckStatus('test').status, 'passed');
  report.ok = true;
} catch (error) { report.error = String(error); process.exitCode = 1;
} finally {
  report.liveCalls = liveCalls;
  report.requests = storage.listEvents('test').filter(e => ['request.completed', 'request.failed'].includes(e.type)).map(e => ({ type: e.type, stream: e.payload.stream, usage: e.payload.usage }));
  mkdirSync('output/desktop', { recursive: true });
  writeFileSync('output/desktop/process-controls-real.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok ?? false, error: report.error, liveCalls, root }));
  storage.close();
}
