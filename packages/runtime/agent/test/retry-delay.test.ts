import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { openWorkspaceStorage } from '../../../storage/src/index.js';
import { ModelProviderBase, type ProviderStreamEvent } from '../../llm/src/index.js';
import { ToolRegistry } from '../../tools/src/index.js';
import { AgentRuntime } from '../src/index.js';

it('defers an hour-long provider retry without sleeping or requesting the provider early', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-retry-delay-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const waited: number[] = [];
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('delay', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++;
      if (requests === 1) yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'try later', retryable: true, retryAfterMs: 3_600_000 } };
      else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: 'delay', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([]),
      waitBeforeRetry: async milliseconds => { waited.push(milliseconds); } });
    const input = { projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
      grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 5, maxToolCalls: 0, maxRetriesPerRequest: 2, maxMajorRevisions: 0 } };
    const result = await runtime.run(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'PROVIDER_RETRY_DEFERRED');
    assert.equal(storage.getRun(result.runId)?.status, 'waiting_user');
    assert.deepEqual(waited, []);
    assert.equal(requests, 1);
    const wait = storage.listRunEvents(result.runId).findLast(event => event.type === 'run.waiting_user')!;
    assert.equal(wait.payload.retryAfterMs, 3_600_000);
    assert.ok(Number(wait.payload.retryNotBefore) > Date.now() + 3_500_000);
    storage.resumeRun({ projectId: 'p', runId: result.runId, operationId: 'explicit-resume', decision: 'resume' });
    const resumed = await runtime.resume(input, result.runId).result;
    assert.equal(resumed.ok, false, 'an immediate author retry cannot bypass the server cooldown');
    assert.equal(requests, 1);
    assert.equal(storage.getRun(result.runId)?.stopReason, 'PROVIDER_RETRY_DEFERRED');
    t.mock.method(Date, 'now', () => Number(wait.payload.retryNotBefore) + 1);
    storage.resumeRun({ projectId: 'p', runId: result.runId, operationId: 'resume-after-cooldown', decision: 'resume' });
    assert.equal((await runtime.resume(input, result.runId).result).ok, true);
    assert.equal(requests, 2, 'the author may resume normally after the server cooldown');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const delay of [NaN, Infinity, -1, 2_147_483_648, 1e300]) {
  it(`pauses an unsafe retry delay without passing it to a timer: ${String(delay)}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-invalid-delay-'));
    const storage = openWorkspaceStorage({ workspacePath: directory });
    const waited: number[] = [];
    let requests = 0;
    class Provider extends ModelProviderBase {
      constructor() { super('invalid-delay', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
        requests++;
        yield { type: 'error', error: { code: 'PROVIDER_UNAVAILABLE', message: 'retry later', retryable: true, retryAfterMs: delay } };
      }
    }
    try {
      storage.createProject({ projectId: 'p', operationId: 'p', name: 'delay', mode: 'quick', actor: { kind: 'user', id: 'u' } });
      const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([]),
        waitBeforeRetry: async milliseconds => { waited.push(milliseconds); } });
      const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
        grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 5, maxToolCalls: 0, maxRetriesPerRequest: 2, maxMajorRevisions: 0 } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'PROVIDER_RETRY_DEFERRED');
      assert.equal(storage.getRun(result.runId)?.status, 'waiting_user');
      assert.equal(requests, 1);
      assert.deepEqual(waited, []);
      const wait = storage.listRunEvents(result.runId).findLast(event => event.type === 'run.waiting_user')!;
      assert.equal(wait.payload.invalidRetryAfter === true, delay !== 2_147_483_648);
      if (wait.payload.invalidRetryAfter) assert.match(String(wait.payload.reason), /重试时间无效/);
      assert.doesNotThrow(() => JSON.stringify(wait.payload));
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const delay of [0, 30_000]) {
  it(`retains bounded automatic provider retry at the interactive boundary: ${delay}ms`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-short-delay-'));
    const storage = openWorkspaceStorage({ workspacePath: directory });
    const waited: number[] = [];
    let requests = 0;
    class Provider extends ModelProviderBase {
      constructor() { super('short-delay', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
        requests++;
        if (requests === 1) yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'retry', retryable: true, retryAfterMs: delay } };
        else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
      }
    }
    try {
      storage.createProject({ projectId: 'p', operationId: 'p', name: 'delay', mode: 'quick', actor: { kind: 'user', id: 'u' } });
      const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([]),
        waitBeforeRetry: async milliseconds => { waited.push(milliseconds); } });
      const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
        grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 2, maxToolCalls: 0, maxRetriesPerRequest: 1, maxMajorRevisions: 0 } });
      assert.equal(result.ok, true);
      assert.equal(requests, 2);
      assert.deepEqual(waited, [delay]);
      assert.equal(storage.getRun(result.runId)?.usage.retries, 1);
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

it('cancels a bounded retry wait immediately without another provider request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-cancel-delay-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  let requests = 0;
  let beganWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { beganWaiting = resolve; });
  class Provider extends ModelProviderBase {
    constructor() { super('cancel-delay', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++;
      yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'retry', retryable: true, retryAfterMs: 30_000 } };
    }
  }
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: 'delay', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([]),
      waitBeforeRetry: async (_milliseconds, signal) => {
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); beganWaiting(); });
      } });
    const handle = runtime.start({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
      grantedPermissions: [], expectedBodyVersionId: null });
    await waiting;
    handle.cancel();
    const result = await handle.result;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'CANCELLED');
    assert.equal(storage.getRun(handle.runId)?.status, 'cancelled');
    assert.equal(requests, 1);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
