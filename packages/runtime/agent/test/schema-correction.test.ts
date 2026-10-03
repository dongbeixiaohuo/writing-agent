import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../llm/src/index.js";
import { ToolRegistry } from "../../tools/src/index.js";
import { openWorkspaceStorage } from "../../../storage/src/index.js";
import { AgentRuntime } from "../src/index.js";

it('never accepts apology prose as completion while a corrected tool submission is still required', async () => {
  const path = mkdtempSync(join(tmpdir(), 'missing-required-tool-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  let calls = 0, writes = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('required', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'bad', name: 'save', argumentsDelta: '{"wrong":1}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else { yield { type: 'text_delta', delta: '抱歉，已经完成。' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      tools: ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', effect: 'local_idempotent', permissions: [],
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        execute() { writes++; return {}; } }]) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'test', parameters: {}, systemPrompt: 'save', userMessage: 'ok',
      expectedBodyVersionId: null, grantedPermissions: [], budget: { maxModelRequests: 10, maxToolCalls: 4, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    assert.ok(calls <= 4);
    assert.notEqual(storage.getRun(result.runId)?.status, 'completed');
  } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
});

for (const mode of ['recover', 'persistent', 'one-request', 'cancel'] as const) {
  it(`mixed schema and JSON syntax failures recover atomically with a shared bound: ${mode}`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'mixed-format-correction-'));
    const storage = openWorkspaceStorage({ workspacePath: path });
    const requests: ModelRequest[] = [];
    const controller = new AbortController();
    const writes: unknown[] = [];
    class Provider extends ModelProviderBase {
      constructor() { super('mixed-format', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        // A valid sibling must also remain unexecuted when another call is invalid.
        yield { type: 'tool_call_delta', index: 0, id: `valid-${requests.length}`, name: 'save', argumentsDelta: '{"summary":"valid sibling"}' };
        const args = requests.length === 1 ? '{"proposal":{"summary":"wrong level"}}'
          : mode === 'recover' && requests.length === 3 ? '{"summary":"corrected"}' : '{"summary":"PRIVATE_UNSAVED",}';
        yield { type: 'tool_call_delta', index: 1, id: `invalid-${requests.length}`, name: 'save', argumentsDelta: args };
        if (mode === 'cancel' && requests.length === 2) controller.abort();
        yield { type: 'completed', finishReason: 'tool_calls' };
      }
    }
    try {
      storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
      const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
        tools: ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', effect: 'local_idempotent', permissions: [],
          inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
          execute(args) { writes.push(args); return {}; } }]),
        completeAfterTool: () => writes.length === 2 ? { content: 'saved', artifactVersionId: 'v' } : null,
      });
      const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'test', systemPrompt: 'save', userMessage: 'chosen title', parameters: {},
        grantedPermissions: [], expectedBodyVersionId: null, signal: controller.signal,
        budget: { maxModelRequests: mode === 'one-request' ? 1 : 8, maxToolCalls: 4, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
      assert.equal(result.ok, mode === 'recover', JSON.stringify(result));
      assert.equal(requests.length, mode === 'one-request' ? 1 : mode === 'cancel' ? 2 : 3);
      assert.deepEqual(writes, mode === 'recover' ? [{ summary: 'valid sibling' }, { summary: 'corrected' }] : []);
      assert.equal(storage.listRuns('p').length, 1);
      if (mode === 'recover' || mode === 'persistent') {
        assert.match(JSON.stringify(requests[2]?.messages), /json_syntax/);
        assert.doesNotMatch(JSON.stringify(requests[2]?.messages), /PRIVATE_UNSAVED/);
        assert.equal(requests[2]?.parameters.toolChoice, 'required');
      }
      if (mode === 'persistent' && !result.ok) assert.equal(result.error.code, 'MODEL_RESPONSE_INVALID');
    } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
  });
}

for (const missingTool of [false, true]) for (const corrects of [true, false]) it(`schema errors are non-executable and bounded in the original run (corrects=${corrects}, missingTool=${missingTool})`, async () => {
  const path = mkdtempSync(join(tmpdir(), "schema-correction-"));
  const storage = openWorkspaceStorage({ workspacePath: path });
  const requests: ModelRequest[] = []; let writes = 0;
  class Provider extends ModelProviderBase {
    constructor() { super("schema-correction", "1.0.0", { protocol: "mock", streaming: "supported", tools: "supported", usage: "unknown" }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      if (corrects && requests.length === 3) { yield { type: "text_delta", delta: "done" }; yield { type: "completed", finishReason: "stop" }; return; }
      yield { type: "tool_call_delta", index: 0, id: `c${requests.length}`, name: missingTool && (!corrects || requests.length === 1) ? 'director_decide' : "save", argumentsDelta: JSON.stringify({ risk: corrects && requests.length > 1 ? "red" : "high" }) };
      yield { type: "completed", finishReason: "tool_calls" };
    }
  }
  try {
    storage.createProject({ operationId: "p", projectId: "p", name: "test", mode: "quick", actor: { kind: "user", id: "u" } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([{ name: "save", version: "1.0.0", description: "save", permissions: [], effect: "local_idempotent", inputSchema: { type: "object", properties: { risk: { type: "string", enum: ["red", "yellow", "green"] } }, required: ["risk"], additionalProperties: false }, execute() { writes++; return {}; } }]) });
    const result = await runtime.run({ projectId: "p", purpose: "test", systemPrompt: "test", userMessage: "test", model: "mock", parameters: {}, grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 10, maxToolCalls: 10, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, corrects, JSON.stringify(result));
    assert.equal(writes, corrects ? 1 : 0);
    assert.equal(result.modelRequestCount, 3);
    assert.equal(storage.listRuns("p").length, 1);
    assert.match(JSON.stringify(requests[1]?.messages), missingTool ? /allowedTools.*save/u : /red.*yellow.*green/u);
    if (!missingTool) assert.match(JSON.stringify(requests[1]?.messages), /不是差异补丁/);
    assert.equal(storage.listRunEvents(result.runId).filter((e) => e.type === "request.failed").length, corrects ? 1 : 3);
  } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
});

it('schema repair allowance belongs to each independent expert scope', async () => {
  const path = mkdtempSync(join(tmpdir(), 'schema-scopes-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  let actor = 0; const attempts = new Map<number, number>();
  class Provider extends ModelProviderBase {
    constructor() { super('schema-scopes', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      const attempt = (attempts.get(actor) ?? 0) + 1; attempts.set(actor, attempt);
      yield { type: 'tool_call_delta', index: 0, id: `${actor}-${attempt}`, name: 'save', argumentsDelta: JSON.stringify({ status: attempt <= 2 ? 'unverifiable' : 'UNSUPPORTED' }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      requestPolicy: () => ({ scopeId: `expert-${actor}`, systemPrompt: 'test', userMessage: 'test', allowedTools: ['save'] }),
      tools: ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', permissions: [], effect: 'local_idempotent', inputSchema: { type: 'object', properties: { status: { enum: ['UNSUPPORTED'] } }, required: ['status'] }, execute() { actor++; return {}; } }]),
      completeAfterTool: () => actor === 2 ? { content: 'done', artifactVersionId: 'test' } : null,
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'mock', systemPrompt: 'test', userMessage: 'test', parameters: {}, grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 10, maxToolCalls: 5, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(actor, 2);
    assert.deepEqual([...attempts.values()], [3, 3]);
  } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
});

for (const scenario of ['recovers', 'always-truncates', 'request-limit', 'configured-limit', 'no-retries', 'one-request', 'cancel', 'scope-switch', 'mixed-retries'] as const) {
  it(`output truncation recovery is complete, bounded and isolated: ${scenario}`, async () => {
    const path = mkdtempSync(join(tmpdir(), 'output-recovery-'));
    const storage = openWorkspaceStorage({ workspacePath: path });
    const requests: ModelRequest[] = [];
    const controller = new AbortController();
    let writes = 0; let actor = 'research';
    class Provider extends ModelProviderBase {
      constructor() { super('output-recovery', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      override snapshotRequest(request: ModelRequest) {
        return { ...super.snapshotRequest(request), outputTokenLimit: {
          value: request.parameters.maxOutputTokens ?? 4096,
          source: request.parameters.maxOutputTokens !== undefined ? 'request' as const : scenario === 'configured-limit' ? 'configuration' as const : 'model_default' as const,
        } };
      }
      protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        if (scenario === 'mixed-retries' && requests.length !== 2) {
          yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'test limit', retryable: true } }; return;
        }
        if (scenario === 'cancel') controller.abort();
        const completes = ['recovers', 'scope-switch'].includes(scenario) && requests.length % 2 === 0;
        yield { type: 'tool_call_delta', index: 0, id: `save-${requests.length}`, name: 'save', argumentsDelta: completes ? '{"content":"complete"}' : '{"content":"DO_NOT_REUSE_PARTIAL' };
        yield { type: 'completed', finishReason: completes ? 'tool_calls' : 'max_tokens' };
      }
    }
    try {
      storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
      const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
        requestPolicy: () => ({ scopeId: actor, systemPrompt: actor, userMessage: 'assigned task', allowedTools: ['save'] }),
        tools: ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', permissions: [], effect: 'local_idempotent',
          inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
          execute() { writes++; actor = 'outline'; return {}; } }]),
        completeAfterTool: () => scenario === 'scope-switch' && writes < 2 ? null : { content: 'done', artifactVersionId: 'saved-test-artifact' },
      });
      const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'mock', systemPrompt: 'root', userMessage: 'task',
        parameters: scenario === 'request-limit' ? { maxOutputTokens: 2048 } : {}, signal: controller.signal,
        grantedPermissions: [], expectedBodyVersionId: null,
        budget: { maxModelRequests: scenario === 'one-request' ? 1 : 10, maxToolCalls: 10, maxRetriesPerRequest: scenario === 'no-retries' ? 0 : 2, maxMajorRevisions: 0 },
      });
      const expected = scenario === 'mixed-retries' ? [4096,4096,8192] : scenario === 'scope-switch' ? [4096,8192,4096,8192] : scenario === 'request-limit' ? [2048,4096] : ['recovers', 'always-truncates', 'configured-limit'].includes(scenario) ? [4096,8192] : [4096];
      assert.deepEqual(requests.map(request => request.parameters.maxOutputTokens ?? 4096), expected,
        `a truncation recovery must escalate the output cap once (x2, capped), not retry with the same exhausted budget (${scenario})`);
      assert.equal(result.ok, ['recovers', 'scope-switch'].includes(scenario));
      assert.equal(writes, scenario === 'scope-switch' ? 2 : scenario === 'recovers' ? 1 : 0);
      assert.equal(storage.listRuns('p').length, 1);
      assert.equal(JSON.stringify(requests).includes('DO_NOT_REUSE_PARTIAL'), false);
      if (requests.length > 1 && scenario !== 'mixed-retries') assert.match(JSON.stringify(requests[1]?.messages), /截断/u);
      if (scenario === 'mixed-retries') assert.equal(storage.getRun(result.runId)?.usage.retries, 2);
      if (scenario === 'scope-switch') assert.doesNotMatch(JSON.stringify(requests[2]?.messages), /截断|research/u);
      if (scenario === 'always-truncates' && !result.ok) assert.equal(result.error.code, 'MODEL_OUTPUT_TRUNCATED');
      if (scenario === 'cancel' && !result.ok) assert.equal(result.error.code, 'CANCELLED');
      const failed = storage.listRunEvents(result.runId).filter(event => event.type === 'request.failed');
      if (scenario === 'recovers') {
        assert.equal((failed[0]?.payload.recovery as any)?.nextOutputTokenLimit, 8192,
          'the recorded next limit must be the escalated one, not the exhausted budget');
        assert.equal(storage.getRun(result.runId)?.usage.retries, 1);
      }
    } finally { storage.close(); }
  });
}
