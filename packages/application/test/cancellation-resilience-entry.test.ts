import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../../runtime/agent/src/index.js';
import { ToolRegistry } from '../../runtime/tools/src/index.js';
import { WritingApplicationService } from '../src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import { ModelProviderBase, type ModelRequest, type ModelEvent, type JsonValue, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';

// This exact file is copied unchanged to RC102 for before/after evidence.
// All transitions are manually released barriers; no model network or user data.
function barrier() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const call = (id: string, name: string, args: Readonly<Record<string, JsonValue>>) => ({ id, name, arguments: args, rawArguments: JSON.stringify(args) });
const actor = { kind: 'user', id: 'cancellation-fixture' } as const;
const body = '# 合成正文\n\n这段正文必须保持原样。';
function seed(storage: ReturnType<typeof openWorkspaceStorage>) {
  storage.createProject({ projectId: 'p', operationId: 'project', name: '取消隔离合成项目', mode: 'quick', actor });
  storage.saveWritingBrief({ operationId: 'brief', projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静', genre: 'narrative_observation', audience: '普通读者',
      lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: [], interactionMode: 'co_creation',
      authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  storage.commitArtifactVersion({ operationId: 'body', projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
    kind: 'body', logicalKey: 'main', baseVersionId: null, content: body, reason: '合成基线', actor });
}

for (const late of ['never', 'text-and-tool', 'throw', 'error', 'inflight-tool', 'storage-cancel', 'other-service-cancel'] as const) test(`H6 real ApplicationBridge: stop then same-project send; late=${late}`, { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-h6-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const oldStarted = barrier(), oldRelease = barrier(), oldEnded = barrier(), newStarted = barrier(), newRelease = barrier();
  let substantiveRequests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('h6-ignores-abort', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { throw Error('Do not use the abort-aware base adapter'); }
    override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      let sequence = 0;
      const metadata = { provider: this.id, model: request.model, adapterVersion: this.adapterVersion };
      if (request.tools?.length === 1 && request.tools[0]?.name === 'interpret_author_reply') {
        yield { sequence: sequence++, type: 'tool_call_complete', index: 0, call: call(request.requestId, 'interpret_author_reply', { intent: 'discuss', selectionIndex: null, reason: '合成作者讨论' }) };
        yield { sequence: sequence++, ...metadata, type: 'completed', finishReason: 'tool_calls' }; return;
      }
      const ordinal = ++substantiveRequests;
      if (ordinal === 1) {
        if (late === 'inflight-tool') {
          yield { sequence: sequence++, type: 'tool_call_complete', index: 0,
            call: call(request.requestId, 'read_author_web', { url: 'https://93.184.216.34/article' }) };
          yield { sequence: sequence++, ...metadata, type: 'completed', finishReason: 'tool_calls' }; return;
        }
        try {
          yield { sequence: sequence++, type: 'text_delta', delta: '停止前未保存的片段' };
          oldStarted.release();
          await oldRelease.ready; // Deliberately ignores request.signal, including forever.
          if (late === 'throw') throw Error('迟到异常必须丢弃');
          if (late === 'error') { yield { sequence: sequence++, ...metadata, type: 'error', error: { code: 'UNKNOWN_PROVIDER_ERROR', message: '迟到错误必须丢弃', retryable: false } }; return; }
          yield { sequence: sequence++, type: 'text_delta', delta: '旧任务迟到污染' };
          yield { sequence: sequence++, type: 'tool_call_complete', index: 0, call: call('late-write', 'respond_author', { reply: '旧任务迟到污染' }) };
          yield { sequence: sequence++, ...metadata, type: 'completed', finishReason: 'tool_calls' };
        } finally { oldEnded.release(); }
      } else {
        yield { sequence: sequence++, type: 'text_delta', delta: '新任务独占的流' };
        newStarted.release();
        await newRelease.ready;
        yield { sequence: sequence++, type: 'tool_call_complete', index: 0, call: call(request.requestId, 'respond_author', { reply: '新任务完整且成功的回复' }) };
        yield { sequence: sequence++, ...metadata, type: 'completed', finishReason: 'tool_calls' };
      }
    }
  }
  seed(storage);
  const service = new WritingApplicationService({ storage, provider: new Provider(), authorWebFetcher: {
    async fetchText() {
      oldStarted.release();
      await oldRelease.ready; // An executing tool dependency also ignores cancellation.
      oldEnded.release();
      return { finalUrl: 'https://93.184.216.34/article', redirectCount: 0, contentType: 'text/html', bodyHash: 'a'.repeat(64),
        content: { text: '旧任务迟到污染', trustLabel: 'external_untrusted', instructionAuthority: 'none', activeContentRemoved: true,
          truncated: false, totalChars: 8 } };
    },
  } });
  const bridge = createApplicationBridge({ service, workspaceId: 'h6-fixture', initialProjectId: 'p',
    model: { model: 'synthetic', providerLabel: '合成提供方', credentialReference: 'NO_REAL_CREDENTIAL', parameters: {} } });
  try {
    await bridge.handshake();
    const first = await bridge.sendMessage(late === 'inflight-tool' ? '阅读 https://93.184.216.34/article 只讨论，不改正文' : '只讨论这篇稿子的感受');
    await oldStarted.ready;
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().activeRunId, first.runId);
    const firstBody = storage.inspectProject('p')!.latestBodyVersionId;
    if (late === 'storage-cancel') storage.cancelRun({ projectId: 'p', runId: first.runId, operationId: 'other-entry-stop', reason: 'user_stop' });
    else if (late === 'other-service-cancel') new WritingApplicationService({ storage }).cancelDraft({ projectId: 'p', runId: first.runId, operationId: 'other-service-stop' });
    else await bridge.cancelRun(first.runId);
    assert.equal(service.getLiveReply('p', storage.getRun(first.runId)!.sessionId, first.runId), null);
    await bridge.refresh();
    assert.equal(storage.getRun(first.runId)?.status, 'cancelled');
    assert.equal(bridge.getSnapshot().activeRunId, null);
    assert.equal(bridge.getSnapshot().connection, 'ready');
    const oldEvents = storage.listRunEvents(first.runId);
    t.diagnostic(JSON.stringify({ phase: 'local-stop', late, cancelledRun: first.runId, status: storage.getRun(first.runId)?.status,
      activeRun: bridge.getSnapshot().activeRunId, providerSettled: false }));
    const second = await bridge.sendMessage('仍然只讨论，不改正文');
    await newStarted.ready;
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().activeRunId, second.runId);
    if (late !== 'never') { oldRelease.release(); await oldEnded.ready; await flush(); }
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().activeRunId, second.runId, 'old finally must not release the newer run');
    assert.match(JSON.stringify(bridge.getSnapshot()), /新任务独占的流/);
    assert.doesNotMatch(JSON.stringify(bridge.getSnapshot()), /旧任务迟到污染|迟到异常必须丢弃|LATE_FAILURE/);
    assert.deepEqual(storage.listRunEvents(first.runId), oldEvents, 'old events and tool results stay frozen');
    assert.equal(storage.listMaterials('p').length, 0, 'late executing web tool must not import material');
    assert.equal(storage.inspectProject('p')!.latestBodyVersionId, firstBody);
    await assert.rejects(bridge.sendMessage('新任务执行中不允许第三个任务'), /RUN_ALREADY_ACTIVE/);
    newRelease.release(); await flush(); await bridge.refresh();
    assert.equal(storage.getRun(second.runId)?.status, 'completed');
    assert.equal(bridge.getSnapshot().activeRunId, null);
    assert.equal(bridge.getSnapshot().connection, 'ready');
    assert.match(JSON.stringify(bridge.getSnapshot()), /新任务完整且成功的回复/);
    assert.equal(storage.inspectProject('p')!.latestBodyVersionId, firstBody);
    assert.deepEqual(storage.listRunEvents(first.runId), oldEvents);
    assert.match(JSON.stringify(bridge.getSnapshot()), /本地已停止.*上游/);
    t.diagnostic(JSON.stringify({ phase: 'new-run-complete', late, newRun: second.runId, status: storage.getRun(second.runId)?.status,
      bodyUnchanged: true, oldEventsUnchanged: true, newStreamNotClearedByOldFinally: true }));
  } finally {
    oldRelease.release(); newRelease.release(); await flush();
    bridge.dispose(); storage.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('H6 durable run fence rejects a delayed tool body write even with current project revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-h6-write-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    seed(storage);
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'writing' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'stale', planVersion: 'test' });
    storage.cancelRun({ projectId: 'p', runId: 'stale', operationId: 'stop', reason: 'user_stop' });
    const before = storage.inspectProject('p')!;
    const beforeEvents = storage.listEvents('p');
    assert.throws(() => storage.recordRunEvent({ projectId: 'p', runId: 'stale', operationId: 'late-event',
      type: 'tool.completed', payload: { reply: '迟到事件' } }), { code: 'RUN_NOT_ACTIVE' });
    const result = storage.commitArtifactVersion({ operationId: 'late-body', projectId: 'p', expectedProjectRevision: before.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: before.latestBodyVersionId, content: '迟到工具覆盖正文', reason: '迟到工具',
      actor: { kind: 'agent', id: 'late-tool', runId: 'stale' } });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, 'RUN_CANCELLED');
    assert.deepEqual(storage.inspectProject('p'), before);
    assert.deepEqual(storage.listEvents('p'), beforeEvents);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});


for (const origin of ['handle', 'storage', 'external-signal'] as const) test(`H6 ${origin} cancel releases the project synchronously and settles without provider completion`, { timeout: 1000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-h6-handle-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  class ForeverProvider extends ModelProviderBase {
    constructor() { super('h6-never-settles', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { await new Promise<void>(() => {}); }
    override async *stream(): AsyncIterable<ModelEvent> { await new Promise<void>(() => {}); }
  }
  try {
    seed(storage);
    const service = new WritingApplicationService({ storage, provider: new ForeverProvider() });
    const input = { projectId: 'p', model: 'synthetic', parameters: {}, userInstruction: '只讨论，不改正文' };
    const controller = new AbortController();
    const first = service.startAuthorTurn({ ...input, signal: controller.signal });
    const otherService = new WritingApplicationService({ storage, provider: new ForeverProvider() });
    assert.throws(() => otherService.startAuthorTurn(input), { code: 'RUN_ALREADY_ACTIVE' }, 'persisted execution blocks a service with no local handle');
    if (origin === 'storage') storage.cancelRun({ projectId: 'p', runId: first.runId, operationId: 'persisted-stop', reason: 'user_stop' });
    else if (origin === 'external-signal') controller.abort();
    else first.cancel();
    // No await between cancel and start: this proves synchronous ownership release.
    const second = service.startAuthorTurn(input);
    second.cancel();
    const results = await Promise.all([first.result, second.result]);
    assert.ok(results.every(result => !result.ok && result.error.code === 'CANCELLED'));
    assert.ok(storage.listRuns('p').every(run => run.status === 'cancelled'));
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('H6 runtime rejects persisted-cancelled stream events even before another application command reconciles its handle', { timeout: 1000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-h6-persisted-stream-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const started = barrier(), release = barrier();
  const seen: unknown[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('h6-persisted-cancel', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { throw Error('Use raw stream'); }
    override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      started.release(); await release.ready;
      assert.equal(request.signal?.aborted, false, 'no provider abort was used');
      yield { sequence: 0, type: 'text_delta', delta: '已取消任务的迟到流' };
      yield { sequence: 1, type: 'completed', finishReason: 'stop', provider: this.id, adapterVersion: this.adapterVersion, model: request.model };
    }
  }
  try {
    seed(storage);
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([]),
      onModelStream: input => { if (input.event || input.lifecycle) seen.push(input); } });
    const handle = runtime.start({ projectId: 'p', purpose: 'test', model: 'synthetic', parameters: {},
      systemPrompt: 'synthetic', userMessage: 'synthetic', grantedPermissions: [], expectedBodyVersionId: storage.inspectProject('p')!.latestBodyVersionId });
    await started.ready;
    storage.cancelRun({ projectId: 'p', runId: handle.runId, operationId: 'outside-stop', reason: 'user_stop' });
    const count = seen.length;
    release.release();
    const result = await handle.result;
    assert.equal(result.ok, false);
    assert.equal(seen.length, count, 'cancelled run cannot publish even an ephemeral lifecycle/event');
  } finally { release.release(); await flush(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
