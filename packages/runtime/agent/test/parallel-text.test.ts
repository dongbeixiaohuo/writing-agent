import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { openWorkspaceStorage } from '../../../storage/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../llm/src/index.js';
import { ToolRegistry } from '../../tools/src/index.js';
import { AgentRuntime, type AgentRequestPolicy } from '../src/index.js';

function fixture(provider: ModelProviderBase, timeoutMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-reader-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  storage.createProject({ projectId: 'p', operationId: 'p', name: 'readers', mode: 'quick', actor: { kind: 'user', id: 'u' } });
  let saves = 0;
  const policy: AgentRequestPolicy = {
    scopeId: 'reader-body-v1', actor: 'review_reader', systemPrompt: 'parent only', userMessage: 'NEVER_SEND_OTHER_REVIEWS',
    allowedTools: ['save'], modelTools: [], textOutputTool: { name: 'save', arguments: {}, contentArgument: 'content' },
    parallelTextTasks: {
      timeoutMs,
      tasks: ['a', 'b', 'c'].map(id => ({ id, actor: `review_reader_${id}`, messages: [
        { role: 'system' as const, content: `persona-${id}` }, { role: 'user' as const, content: 'COMPLETE_ARTICLE' },
      ] })),
      validate: text => text.startsWith('reaction-'),
      combine: results => results.map(r => `${r.id}: ${r.ok ? r.text : `missing ${r.code}`}`).join('\n'),
    },
  };
  const runtime = () => new AgentRuntime({ provider, sessions: storage,
    tools: ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', effect: 'local_idempotent', permissions: [],
      inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      execute() { saves++; return {}; } }]),
    requestPolicy: () => policy,
    pauseAfterTool: result => result.ok ? { reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'review_reader' } } : null,
  });
  const input = { projectId: 'p', purpose: 'reader-test', model: 'mock', parameters: {}, systemPrompt: 'root', userMessage: 'root',
    grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests:3, maxToolCalls:1, maxRetriesPerRequest:0, maxMajorRevisions:0 } };
  return { storage, policy, runtime, input, get saves() { return saves; }, close() { storage.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it('fans out isolated requests concurrently, persists all inputs/usage, saves and pauses exactly once', async () => {
  let active = 0, peak = 0;
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'reported' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request); active++; peak = Math.max(peak, active);
      if (active === 3) release();
      await Promise.race([barrier, new Promise(r => setTimeout(r, 100))]);
      yield { type:'text_delta', delta:`reaction-${request.messages[0]!.content}` };
      yield { type:'usage', usage: { inputTokens:10, outputTokens:2, totalTokens:12, cacheReadTokens:null, reasoningTokens:null } };
      yield { type:'completed', finishReason:'stop' }; active--;
    }
  }
  const f = fixture(new Provider());
  try {
    const result = await f.runtime().run(f.input);
    assert.equal(peak, 3);
    assert.equal(f.saves, 1);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.messages.length, 2);
      assert.equal(request.messages[1]!.content, 'COMPLETE_ARTICLE');
      assert.equal(request.tools?.length ?? 0, 0);
      assert.doesNotMatch(JSON.stringify(request), /NEVER_SEND_OTHER_REVIEWS|reaction-/);
    }
    assert.equal(f.storage.listRequestSnapshots(result.runId).length, 3);
    const run = f.storage.getRun(result.runId)!;
    assert.equal(run.usage.modelRequests, 3); assert.equal(run.usage.totalTokens, 36);
    assert.equal(run.status, 'waiting_user');
    assert.equal(f.storage.listRunEvents(result.runId).filter(e => e.type === 'run.waiting_user').length, 1);
  } finally { f.close(); }
});

it('one timeout is visibly missing without retries or holding back the two successful readers', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests++;
      if (request.messages[0]!.content === 'persona-c') {
        await new Promise<void>(r => request.signal!.addEventListener('abort', () => r(), { once:true })); return;
      }
      yield { type:'text_delta', delta:'reaction-good' }; yield { type:'completed', finishReason:'stop' };
    }
  }
  const f = fixture(new Provider(), 30);
  try {
    const result = await f.runtime().run(f.input);
    assert.equal(f.saves, 1); assert.equal(requests, 3);
    const save = f.storage.listRunEvents(result.runId).find(e => e.type === 'tool.requested')!;
    assert.match(JSON.stringify(save.payload.arguments), /c: missing PARALLEL_TASK_TIMEOUT/);
    assert.equal(f.storage.getRun(result.runId)!.usage.retries, 0);
  } finally { f.close(); }
});

it('stopping cancels all three requests and cannot commit a late response', { timeout: 2000 }, async () => {
  let started = 0, aborted = 0, ready!: () => void;
  const allStarted = new Promise<void>(r => { ready = r; });
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (++started === 3) ready();
      await new Promise<void>(r => request.signal!.addEventListener('abort', () => { aborted++; r(); }, { once:true }));
      yield { type:'text_delta', delta:'reaction-late' }; yield { type:'completed', finishReason:'stop' };
    }
  }
  const f = fixture(new Provider());
  try {
    const handle = f.runtime().start(f.input);
    await allStarted;
    handle.cancel(); await handle.result;
    assert.equal(aborted, 3); assert.equal(f.saves, 0);
    assert.equal(f.storage.getRun(handle.runId)!.status, 'cancelled');
  } finally { f.close(); }
});

it('reuses persisted completed children after process replacement, without spending three requests again', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++; yield { type:'text_delta', delta:'reaction-saved' }; yield { type:'completed', finishReason:'stop' };
    }
  }
  const f = fixture(new Provider());
  try {
    const settle = f.storage.settleRuntimeOperation.bind(f.storage);
    let complete = 0;
    f.storage.settleRuntimeOperation = input => {
      const value = settle(input);
      if (input.eventType === 'request.completed' && ++complete === 3) throw new Error('crash after durable child completion');
      return value;
    };
    const handle = f.runtime().start(f.input);
    await assert.rejects(handle.result, /crash/);
    assert.equal(f.saves, 0);
    f.storage.settleRuntimeOperation = settle;
    f.storage.recoverProjectRuns('p');
    f.storage.resumeRun({ projectId:'p', runId:handle.runId, operationId:'resume', decision:'resume' });
    await f.runtime().resume(f.input, handle.runId).result;
    assert.equal(requests, 3); assert.equal(f.saves, 1);
    assert.equal(f.storage.getRun(handle.runId)!.usage.modelRequests, 3);
  } finally { f.close(); }
});

it('admits the entire batch before dispatch; insufficient budget sends no paid requests', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { requests++; yield { type:'completed', finishReason:'stop' }; }
  }
  const f = fixture(new Provider());
  try {
    const result = await f.runtime().run({ ...f.input, budget:{ ...f.input.budget, maxModelRequests:2 } });
    assert.equal(result.ok, false);
    assert.equal(f.storage.getRun(result.runId)!.status, 'budget_exhausted');
    assert.equal(requests, 0); assert.equal(f.saves, 0);
  } finally { f.close(); }
});

it('all failed readers fail the stage, not a fake empty report or automatic retry', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++; yield { type:'error', error:{ code:'NETWORK_ERROR', message:'network unavailable', retryable:true } };
    }
  }
  const f = fixture(new Provider());
  try {
    const result = await f.runtime().run(f.input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'PARALLEL_TEXT_ALL_FAILED');
    assert.equal(requests, 3); assert.equal(f.saves, 0);
    assert.equal(f.storage.getRun(result.runId)!.status, 'waiting_user', 'stage failure keeps an explicit retry entry');
  } finally { f.close(); }
});

it('recovery only repeats unfinished children, retaining the completed sibling and its budget record', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', {protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown'}); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++; yield {type:'text_delta', delta:'reaction-saved'}; yield {type:'completed', finishReason:'stop'};
    }
  }
  const f = fixture(new Provider());
  try {
    const settle = f.storage.settleRuntimeOperation.bind(f.storage);
    f.storage.settleRuntimeOperation = input => {
      if (input.eventType === 'request.completed' && input.eventPayload?.parallelTaskId !== 'a') throw new Error('crash before sibling settlement');
      return settle(input);
    };
    const h = f.runtime().start(f.input);
    await assert.rejects(h.result, /crash/);
    f.storage.settleRuntimeOperation = settle;
    f.storage.recoverProjectRuns('p');
    f.storage.resumeRun({projectId:'p', runId:h.runId, operationId:'explicit-retry', decision:'retry_unknown', refreshLoopAllowance:true});
    await f.runtime().resume(f.input, h.runId).result;
    assert.equal(requests, 5, 'only the two unsettled readers are requested again');
    assert.equal(f.saves, 1);
    assert.equal(f.storage.getRun(h.runId)!.usage.modelRequests, 5);
  } finally { f.close(); }
});

it('changing the article prevents reuse of responses from the old reader batch', async () => {
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', {protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown'}); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++; yield {type:'text_delta', delta:'reaction-saved'}; yield {type:'completed', finishReason:'stop'};
    }
  }
  const f = fixture(new Provider());
  try {
    const settle = f.storage.settleRuntimeOperation.bind(f.storage);
    let completed = 0;
    f.storage.settleRuntimeOperation = input => {
      const value = settle(input);
      if (input.eventType === 'request.completed' && ++completed === 3) throw new Error('crash after all children');
      return value;
    };
    const h = f.runtime().start(f.input);
    await assert.rejects(h.result, /crash/);
    f.storage.settleRuntimeOperation = settle;
    const batch = f.policy.parallelTextTasks!;
    Object.assign(f.policy, {parallelTextTasks:{...batch, tasks:batch.tasks.map(t=>({...t, messages:[t.messages[0]!, {role:'user', content:'NEW_COMPLETE_ARTICLE'}]}))}});
    f.storage.recoverProjectRuns('p');
    f.storage.resumeRun({projectId:'p', runId:h.runId, operationId:'resume-new-body', decision:'resume', refreshLoopAllowance:true});
    await f.runtime().resume(f.input, h.runId).result;
    assert.equal(requests, 6); assert.equal(f.saves, 1);
  } finally { f.close(); }
});

it('a provider ignoring abort cannot hold the reader parent beyond the batch deadline', {timeout:2000}, async () => {
  class Provider extends ModelProviderBase {
    constructor() { super('parallel', '1', {protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown'}); }
    protected async *providerStream(request:ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (request.messages[0]!.content === 'persona-c') await new Promise<void>(()=>{});
      yield {type:'text_delta', delta:'reaction-done'}; yield {type:'completed', finishReason:'stop'};
    }
  }
  const f = fixture(new Provider(), 30);
  try {
    const result = await f.runtime().run(f.input);
    assert.equal(f.saves, 1);
    assert.equal(f.storage.getRun(result.runId)?.status, 'waiting_user');
    assert.equal(f.storage.listRunEvents(result.runId).find(e=>e.type==='request.failed')?.payload.error &&
      (f.storage.listRunEvents(result.runId).find(e=>e.type==='request.failed')!.payload.error as any).code, 'PARALLEL_TASK_TIMEOUT');
  } finally { f.close(); }
});
