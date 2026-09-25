import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openWorkspaceStorage } from "../../../storage/src/index.js";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../llm/src/index.js";
import { ToolRegistry } from "../../tools/src/index.js";
import { AgentRuntime } from "../src/index.js";

for (const scenario of ['save', 'cancel', 'truncated', 'timeout', 'revoked', 'permission', 'empty'] as const) {
it(`harness text save retains tool safety boundaries: ${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'text-save-policy-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const controller = new AbortController();
  let scope = 'outline'; let writes = 0; let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('text-save', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests++;
      assert.equal(request.tools, undefined, 'local save authority must not be offered to the model');
      yield { type: 'text_delta', delta: scenario === 'empty' ? '' : '# 提纲\n\n开篇，观察，收束。' };
      if (scenario === 'cancel') controller.abort();
      if (scenario === 'revoked') scope = 'changed';
      if (scenario === 'timeout') { yield { type: 'error', error: { code: 'TIMEOUT', message: 'test', retryable: true } }; return; }
      yield { type: 'completed', finishReason: scenario === 'truncated' ? 'max_tokens' : 'stop' };
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const tools = ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', effect: 'local_idempotent', permissions: ['write'],
      inputSchema: { type: 'object', properties: { stage: { const: 'outline' }, content: { type: 'string', minLength: 1 } }, required: ['stage', 'content'], additionalProperties: false },
      execute(args: any) { assert.equal(args.stage, 'outline'); assert.equal(args.content, '# 提纲\n\n开篇，观察，收束。'); writes++; return { id: 'saved' }; } }]);
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools,
      requestPolicy: () => ({ scopeId: scope, actor: 'outline', systemPrompt: 'write', userMessage: 'outline', allowedTools: ['save'], modelTools: [],
        textOutputTool: { name: 'save', arguments: { stage: 'outline' }, contentArgument: 'content' } }),
      completeAfterTool: result => result.ok ? { artifactVersionId: 'saved', content: 'saved' } : null,
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'root', userMessage: 'root',
      grantedPermissions: scenario === 'permission' ? [] : ['write'], expectedBodyVersionId: null, signal: controller.signal,
      budget: { maxModelRequests: 1, maxToolCalls: 1, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(writes, scenario === 'save' ? 1 : 0);
    assert.equal(result.ok, scenario === 'save');
    assert.equal(requests, 1);
    if (scenario === 'save') {
      const events = storage.listRunEvents(result.runId);
      assert.deepEqual(events.find(e => e.type === 'request.completed')?.payload.toolCallIds, []);
      assert.equal(events.find(e => e.type === 'tool.requested')?.payload.origin, 'harness_text_output');
    }
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

it('refreshes policy state within an actor without losing its tool history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-policy-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let ready = false;
  const requests: ModelRequest[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('live-policy', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'ready', name: 'ready', argumentsDelta: '{}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const tools = ToolRegistry.create([{ name: 'ready', version: '1.0.0', description: 'ready', effect: 'read_only', permissions: [], inputSchema: { type: 'object', properties: {} }, execute() { ready = true; return { ready }; } }]);
    await new AgentRuntime({ provider: new Provider(), sessions: storage, tools,
      requestPolicy: () => ({ scopeId: 'director', actor: 'director', systemPrompt: 'director', userMessage: JSON.stringify({ ready }), allowedTools: ['ready'] }),
    }).run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'root', userMessage: 'root', grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(requests[1]!.messages[1]!.content, '{"ready":true}');
    assert.ok(requests[1]!.messages.some(message => message.role === 'tool' && message.name === 'ready'));
    assert.equal(storage.listRunEvents(storage.listRuns('p')[0]!.id).find(event => event.type === 'tool.requested')?.payload.actor, 'director');
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("request policies isolate actor histories and reject tools outside the issued request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-policy-"));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let actor = "director";
  let forbiddenWrites = 0;
  const requests: ModelRequest[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super("policy-test", "1", { protocol: "mock", streaming: "supported", tools: "supported", usage: "unknown" }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: "text_delta", delta: "director-private-history" };
        for (const [index, name] of ["dispatch", "write"].entries()) yield { type: "tool_call_delta", index, id: `c${index}`, name, argumentsDelta: "{}" };
        yield { type: "completed", finishReason: "tool_calls" };
      } else { yield { type: "text_delta", delta: "done" }; yield { type: "completed", finishReason: "stop" }; }
    }
  }
  try {
    storage.createProject({ operationId: "p", projectId: "p", name: "test", mode: "quick", actor: { kind: "user", id: "u" } });
    const tools = ToolRegistry.create(["dispatch", "write"].map((name) => ({ name, version: "1.0.0", description: name, effect: "local_idempotent" as const, permissions: [], inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute() { if (name === "dispatch") actor = "reviewer"; else forbiddenWrites++; return {}; } })));
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools,
      requestPolicy: () => ({ scopeId: actor, systemPrompt: actor, userMessage: "assigned task", allowedTools: actor === "director" ? ["dispatch", "write"] : [] }),
    });
    const result = await runtime.run({ projectId: "p", purpose: "test", model: "m", parameters: {}, systemPrompt: "root", userMessage: "root", grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(forbiddenWrites, 0);
    assert.deepEqual(requests[0]?.tools?.map((tool) => tool.name), ["dispatch", "write"]);
    assert.equal(JSON.stringify(requests[1]?.messages).includes("director-private-history"), false);
    assert.equal(storage.listRunEvents(storage.listRuns("p")[0]!.id).some((event) => event.type === "tool.failed"), true);
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
