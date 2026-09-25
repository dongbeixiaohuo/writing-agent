import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WritingApplicationService } from '../../application/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import type { ModelRequest, ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { createApplicationBridge } from '../src/application-bridge.js';
import { ImmediateWorkflowProvider } from './helpers/workflow-provider.js';

const proposal = {
  reply: '可以写成关于夜跑的个人观察。建议面向初学者、约 1200 字，不编造经历；你觉得这个方向怎样？',
  summary: '夜跑的个人观察；建议面向初学者、约 1200 字。不编造经历。', questions: [],
  proposal: {
    brief: { topic: '夜跑的个人观察', genre: 'practical_experience', audience: '初学者',
      targetCharacters: 1200, constraints: ['不编造经历'], voice: null, styleReference: null, platform: null, publicationGoal: 'not_applicable' },
    assumptions: ['读者与篇幅为建议值'], sourceQuotes: [],
  },
};

class ConversationalProvider extends ImmediateWorkflowProvider {
  next: Record<string, unknown> = { reply: '可以一起想想。你想从个人感受聊起，还是先找一个观察角度？', summary: '夜跑，角度还未确定', questions: ['你想从个人感受聊起，还是先找一个观察角度？'] };
  readonly requests: ModelRequest[] = [];
  protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    if (request.tools.some(tool => tool.name === 'respond_writing_intake')) {
      if (request.messages.some(message => message.role === 'tool')) {
        yield { type: 'text_delta', delta: '这轮交流已保存。' };
        yield { type: 'completed', finishReason: 'stop' };
        return;
      }
      yield { type: 'tool_call_delta', index: 0, id: `intake-${request.requestId}`, name: 'respond_writing_intake', argumentsDelta: JSON.stringify(this.next) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    } else yield* super.providerStream(request);
  }
}

async function settled(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const model = { model: 'synthetic', providerLabel: 'test', credentialReference: 'TEST_ONLY', parameters: {} };

for (const mode of ['tool', 'text'] as const) test(`desktop snapshot exposes a partial ${mode} reply before model completion, then only the saved reply`, async () => {
  let release!: () => void;
  let emitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { emitted = resolve; });
  class StreamingProvider extends ConversationalProvider {
    protected override async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      if (mode === 'text') yield { type: 'text_delta', delta: '我们先从一个' };
      else yield { type: 'tool_call_delta', index: 0, id: 'live', name: 'respond_writing_intake', argumentsDelta: '{"reply":"我们先从一个' };
      emitted(); await gate;
      if (mode === 'text') {
        yield { type: 'text_delta', delta: '小问题聊起。' };
        yield { type: 'tool_call_delta', index: 0, id: 'live', name: 'respond_writing_intake', argumentsDelta: '{"reply":"我们先从一个小问题聊起。","summary":"待明确方向","questions":[]}' };
      } else yield { type: 'tool_call_delta', index: 0, id: 'live', argumentsDelta: '小问题聊起。","summary":"待明确方向","questions":[]}' };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-live-chat-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage, provider: new StreamingProvider() });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'live-test' });
  try {
    await bridge.startConversation('不知道写什么');
    await first; await bridge.refresh();
    const partial = bridge.getSnapshot();
    assert.equal(partial.liveReply?.text, '我们先从一个');
    assert.notEqual(partial.activeRunId, null);
    assert.ok(!JSON.stringify(partial.timelineBySession).includes('我们先从一个'));
    release();
    await settled(() => storage.getRun(partial.activeRunId!)?.status === 'completed');
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().liveReply, null);
    assert.ok(JSON.stringify(bridge.getSnapshot().timelineBySession).includes('我们先从一个小问题聊起。'));
  } finally { release(); bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

for (const mode of ['text', 'tool'] as const) for (const outcome of ['cancel', 'error'] as const) test(`partial ${mode} reply is discarded after ${outcome}, never committed as a saved response`, async () => {
  let release!: () => void;
  let emitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { emitted = resolve; });
  class FailingProvider extends ConversationalProvider {
    protected override async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      if (mode === 'text') yield { type: 'text_delta', delta: '尚未保存的半截' };
      else yield { type: 'tool_call_delta', index: 0, id: 'partial', name: 'respond_writing_intake', argumentsDelta: '{"reply":"尚未保存的半截' };
      emitted(); await gate;
      yield { type: 'error', error: { code: 'AUTH_FAILED', message: 'fixture', retryable: false } };
    }
  }
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-live-stop-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage, provider: new FailingProvider() });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'live-stop' });
  try {
    await bridge.startConversation('想聊聊'); await first; await bridge.refresh();
    const runId = bridge.getSnapshot().activeRunId!;
    assert.equal(bridge.getSnapshot().liveReply?.text, '尚未保存的半截');
    if (outcome === 'cancel') await bridge.cancelRun(runId);
    release(); await settled(() => ['failed', 'cancelled'].includes(storage.getRun(runId)!.status));
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().liveReply, null);
    assert.ok(!JSON.stringify(bridge.getSnapshot().timelineBySession).includes('尚未保存的半截'));
  } finally { release(); bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('shows the actual intake rejection cause at a historical protection stop instead of a generic writing failure', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-rejection-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage });
  service.createProject({ projectId: 'project', operationId: 'create', name: '测试', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'project', sessionId: 'session', purpose: 'writing-pack:intake' });
  storage.startRun({ projectId: 'project', sessionId: 'session', runId: 'run', purpose: 'writing-pack:intake', planVersion: 'old', displayInstruction: '1000字，具体案例切入' });
  storage.recordRunEvent({ projectId: 'project', runId: 'run', operationId: 'tool', type: 'tool.requested', payload: { toolName: 'respond_writing_intake' } });
  storage.recordRunEvent({ projectId: 'project', runId: 'run', operationId: 'tool', type: 'tool.failed', payload: {
    result: { ok: false, toolName: 'respond_writing_intake', error: { code: 'INTAKE_SOURCE_QUOTE_INVALID', message: 'private data must not leak' } },
  } });
  storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'stop', status: 'budget_exhausted', stopReason: 'BUDGET_EXHAUSTED' });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    await bridge.selectSession('project', 'session');
    const items = bridge.getSnapshot().timelineBySession.session;
    assert.ok(items.some(item => item.kind === 'tool' && item.label === '整理本轮回复'));
    const stop = items.find(item => item.kind === 'tool' && item.label === '已触发运行保护');
    assert.ok(stop?.kind === 'tool');
    assert.match(stop.detail, /原话.*不一致/u);
    assert.doesNotMatch(JSON.stringify(items), /使用写作工具|写作工具执行失败|private data/u);
    assert.equal(storage.getRun('run')!.status, 'budget_exhausted');
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

for (const savedReply of [false, true]) test(`historical intake protection explains saved state without rewriting the run (saved: ${savedReply})`, async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-protection-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage });
  service.createProject({ projectId: 'project', operationId: 'create', name: '测试', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'project', sessionId: 'session', purpose: 'writing-pack:intake' });
  storage.startRun({ projectId: 'project', sessionId: 'session', runId: 'run', purpose: 'writing-pack:intake', planVersion: 'old', displayInstruction: '想聊聊夜跑' });
  if (savedReply) storage.recordRunEvent({ projectId: 'project', runId: 'run', operationId: 'reply', type: 'tool.completed',
    payload: { result: { ok: true, toolName: 'respond_writing_intake', result: { reply: '你想从什么角度聊起？' } } } });
  storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'stop', status: 'budget_exhausted', stopReason: 'BUDGET_EXHAUSTED' });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    await bridge.selectSession('project', 'session');
    const items = bridge.getSnapshot().timelineBySession.session;
    const stop = items.find(item => item.kind === 'tool' && item.label === '已触发运行保护');
    assert.ok(stop?.kind === 'tool');
    assert.match(stop.detail, /不是.*账户额度/u);
    assert.doesNotMatch(JSON.stringify(items), /预算已用完|缩小任务/u);
    if (savedReply) {
      assert.match(stop.detail, /回复已保存.*继续对话/u);
      assert.ok(items.some(item => item.kind === 'message' && item.body === '你想从什么角度聊起？'));
    } else assert.match(stop.detail, /未能保存.*回复/u);
    assert.equal(storage.getRun('run')?.status, 'budget_exhausted');
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('one idea creates a conversation without a brief; replies and unknown information survive reload', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-bridge-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const provider = new ConversationalProvider();
  const service = new WritingApplicationService({ storage, provider });
  let bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    const result = await bridge.startConversation('我想写夜跑，但是没想好怎么写', { operationId: 'first' });
    const first = bridge.getSnapshot();
    assert.ok(first.selectedProjectId);
    assert.ok(first.selectedSessionId);
    assert.equal(first.brief, null);
    assert.equal(first.previewDocument.id, null);
    assert.equal(first.timelineBySession[first.selectedSessionId]?.some(item => item.kind === 'message' && item.body === '我想写夜跑，但是没想好怎么写'), true);
    await settled(() => storage.getRun(result.runId)?.status === 'completed');
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().runRecords[0]?.purpose, 'writing-pack:intake');
    assert.equal(bridge.getSnapshot().runRecords[0]?.totalStages, 0);
    const items = bridge.getSnapshot().timelineBySession[first.selectedSessionId]!;
    assert.ok(items.some(item => item.kind === 'message' && item.role === 'assistant' && item.body.includes('一起想想')));
    assert.ok(!JSON.stringify(items).includes('交付待处理'));
    assert.equal(service.listProjects().length, 1);
    assert.deepEqual(await bridge.startConversation('我想写夜跑，但是没想好怎么写', { operationId: 'first' }), result);
    assert.equal(service.listProjects().length, 1);
    bridge.dispose();
    bridge = createApplicationBridge({ service: new WritingApplicationService({ storage, provider }), model, workspaceId: 'test' });
    assert.equal(bridge.getSnapshot().conversationIntake?.phase, 'collecting');
    assert.equal(bridge.getSnapshot().brief, null);
    provider.next = proposal;
    await bridge.sendMessage('我更想写个人观察，你帮我建议读者和篇幅', { operationId: 'second' });
    await settled(() => bridge.getSnapshot().conversationIntake?.phase === 'proposal');
    assert.equal(bridge.getSnapshot().selectedSessionId, first.selectedSessionId);
    assert.equal(bridge.getSnapshot().brief?.confirmationStatus, 'tentative');
    assert.equal(service.getProjectProjection(first.selectedProjectId).currentBody, null);
    assert.equal(storage.listMaterials(first.selectedProjectId).length, 2);
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('inline confirmation is version bound and hands off to writing in the same conversation', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-confirm-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const provider = new ConversationalProvider(); provider.next = proposal;
  const service = new WritingApplicationService({ storage, provider });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    await bridge.startConversation('想写夜跑观察，先帮我想方向', { operationId: 'first' });
    await settled(() => bridge.getSnapshot().conversationIntake?.phase === 'proposal' && bridge.getSnapshot().connection === 'ready');
    const snapshot = bridge.getSnapshot();
    const version = snapshot.conversationIntake!.proposalVersionId!;
    await assert.rejects(bridge.confirmConversation('outdated', { operationId: 'wrong' }), /INTAKE_PROPOSAL_CONFLICT|proposal/iu);
    assert.equal(service.getProjectProjection(snapshot.selectedProjectId).runs.length, 1);
    const run = await bridge.confirmConversation(version, { operationId: 'confirm' });
    await settled(() => storage.getRun(run.runId)?.status === 'waiting_user');
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().selectedSessionId, snapshot.selectedSessionId);
    assert.equal(bridge.getSnapshot().brief?.confirmationStatus, 'confirmed');
    assert.equal(bridge.getSnapshot().conversationIntake?.phase, 'confirmed');
    assert.equal(bridge.getSnapshot().recoverableRuns.at(-1)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(bridge.getSnapshot().runRecords.at(-1)?.purpose, 'writing-pack:draft');
    assert.equal(service.getProjectProjection(snapshot.selectedProjectId).sessions.length, 1);
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('a natural short confirmation starts writing once in the same session', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-natural-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const provider = new ConversationalProvider(); provider.next = proposal;
  const service = new WritingApplicationService({ storage, provider });
  const bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    await bridge.startConversation('想写夜跑观察，先帮我想方向', { operationId: 'first' });
    await settled(() => bridge.getSnapshot().conversationIntake?.phase === 'proposal' && bridge.getSnapshot().connection === 'ready');
    const { selectedProjectId, selectedSessionId, conversationIntake } = bridge.getSnapshot();
    provider.next = { reply: '好的，我们按已确认的方向开始研究，并一起确认提纲。', summary: '已确认当前方向', questions: [],
      confirmation: { proposalVersionId: conversationIntake!.proposalVersionId, sourceQuote: '好的' } };
    await bridge.sendMessage('好的', { operationId: 'yes' });
    await settled(() => service.getProjectProjection(selectedProjectId).runs.some(run => run.status === 'waiting_user'));
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().selectedSessionId, selectedSessionId);
    const runs = service.getProjectProjection(selectedProjectId).runs;
    assert.equal(runs.length, 3); // two intake turns and one writing run
    assert.equal(runs.filter(run => run.status === 'waiting_user').length, 1);
    assert.equal(service.getProjectProjection(selectedProjectId).sessions.length, 1);
    assert.equal(bridge.getSnapshot().lastError, null);
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

for (const unknown of [false, true]) test(`intake recovery without a brief preserves the conversation (unknown outcome: ${unknown})`, async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-chat-interrupted-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage, provider: new ConversationalProvider() });
  service.createProject({ projectId: 'interrupted-project', operationId: 'project', name: '聊聊夜跑', mode: 'deep', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'interrupted-project', sessionId: 'conversation', purpose: 'writing-pack:intake' });
  storage.startRun({ projectId: 'interrupted-project', sessionId: 'conversation', runId: 'lost-run', purpose: 'writing-pack:intake',
    displayInstruction: '我想写夜跑，但是没想好怎么写', planVersion: 'test' });
  if (unknown) storage.pauseRun({ projectId: 'interrupted-project', runId: 'lost-run', operationId: 'pause', reason: 'UNKNOWN_EXTERNAL_OUTCOME' });
  service.recoverWorkspace();
  const bridge = createApplicationBridge({ service, model, workspaceId: 'test' });
  try {
    assert.equal(bridge.getSnapshot().brief, null);
    assert.equal(bridge.getSnapshot().recoverableRuns[0]?.runId, 'lost-run');
    if (unknown) {
      await assert.rejects(bridge.resumeRun('lost-run', 'resume', { operationId: 'not-authorized' }), /UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION/u);
      assert.equal(service.getProjectProjection('interrupted-project').runs.length, 1);
    }
    await bridge.resumeRun('lost-run', unknown ? 'retry_unknown' : 'resume', { operationId: 'retry' });
    await settled(() => service.getProjectProjection('interrupted-project').runs.some(run => run.id !== 'lost-run' && run.status === 'completed'));
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().brief, null);
    assert.equal(bridge.getSnapshot().selectedSessionId, 'conversation');
    assert.equal(bridge.getSnapshot().recoverableRuns.length, 0);
    assert.equal(storage.getRun('lost-run')?.status, 'cancelled');
    assert.equal(service.getProjectProjection('interrupted-project').sessions.length, 1);
  } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});
