import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openWorkspaceStorage } from "../../../storage/src/index.js";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../llm/src/index.js";
import { ToolRegistry, ToolExecutionFault } from "../../tools/src/index.js";
import { AgentRuntime } from "../src/index.js";

it('provides raw history and the result position for request-only read projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-history-projection-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const requests: ModelRequest[] = [];
  const projectionContexts: { index: number; messages: ModelRequest['messages'] }[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('history', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      if (requests.length < 3) {
        yield { type: 'tool_call_delta', index: 0, id: `c${requests.length}`, name: 'read', argumentsDelta: '{}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      tools: ToolRegistry.create([{ name: 'read', version: '1.0.0', description: 'read', effect: 'read_only', permissions: [], inputSchema: { type: 'object', properties: {} }, execute() { return { content: 'FULL_PAGE' }; } }]),
      requestPolicy: () => ({ scopeId: 'fixed', systemPrompt: 'read', userMessage: 'read', allowedTools: ['read'],
        projectToolResult: (message: any, context: any) => {
          assert.ok(context, 'a projection must know which batch has just completed');
          projectionContexts.push(structuredClone(context));
          return context.index < context.messages.length - 1 ? 'old read receipt' : message.content;
        } }),
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'read', userMessage: 'read', grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true);
    assert.match(requests[1]!.messages.find(m => m.role === 'tool')!.content, /FULL_PAGE/);
    const reads = requests[2]!.messages.filter(m => m.role === 'tool');
    assert.equal(reads[0]!.content, 'old read receipt');
    assert.match(reads[1]!.content, /FULL_PAGE/);
    assert.match(projectionContexts.at(-1)!.messages.find(m => m.role === 'tool')!.content, /FULL_PAGE/, 'later projections see raw history, not earlier projections');
    assert.match(JSON.stringify(storage.listRunEvents(result.runId).filter(e => e.type === 'tool.completed')), /FULL_PAGE/);
    const snapshot = storage.getRequestSnapshot(storage.listRunEvents(result.runId).findLast(e => e.type === 'request.dispatch_attempted')!.payload.snapshotId as string);
    assert.equal(snapshot!.request.messages.find(m => m.role === 'tool')!.content, 'old read receipt', 'diagnostics must reflect what was actually sent');
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('projects duplicate read results for a request without losing original history or persisted tool results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-context-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const requests: ModelRequest[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('context', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      if (requests.length < 3) {
        yield { type: 'tool_call_delta', index: 0, id: `c${requests.length}`, name: 'read', argumentsDelta: '{}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      tools: ToolRegistry.create([{ name: 'read', version: '1.0.0', description: 'read', effect: 'read_only', permissions: [], inputSchema: { type: 'object', properties: {} }, execute() { return { content: 'complete original' }; } }]),
      requestPolicy: () => ({ scopeId: 'fixed', systemPrompt: 'read', userMessage: 'complete original', allowedTools: ['read'],
        ...(requests.length === 1 ? { projectToolResult: () => '{"contentFrom":"current input"}' } : {}) }),
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'read', userMessage: 'read', grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true);
    assert.equal(requests[1]!.messages.find(m => m.role === 'tool')!.content, '{"contentFrom":"current input"}');
    assert.match(requests[2]!.messages.find(m => m.role === 'tool')!.content, /complete original/);
    assert.match(JSON.stringify(storage.listRunEvents(result.runId).filter(e => e.type === 'tool.completed')), /complete original/);
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const scenario of ['repeated', 'changing', 'corrected'] as const) {
it(`bounds local text-save corrections without replaying a stage indefinitely: ${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'text-save-loop-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let requests = 0; let saves = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('loop', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++;
      yield {type:'text_delta', delta: scenario === 'corrected' && requests > 1 ? '# Correct article' : scenario === 'changing' ? `invalid ${requests}` : 'same invalid article'};
      yield {type:'completed', finishReason:'stop'};
    }
  }
  try {
    storage.createProject({operationId:'p',projectId:'p',name:'fixture',mode:'quick',actor:{kind:'user',id:'u'}});
    const tools = ToolRegistry.create([{ name:'save',version:'1.0.0',description:'save',effect:'local_idempotent',permissions:[],
      inputSchema:{type:'object',properties:{content:{type:'string'}},required:['content']},
      execute(args:any) { if (!args.content.startsWith('#')) throw new ToolExecutionFault('BODY_STAGE_STRUCTURE_MISMATCH','missing title',false,{requiredHeadings:['# Correct article']}); saves++; return {}; } }]);
    const runtime = new AgentRuntime({provider:new Provider(),sessions:storage,tools,
      requestPolicy:()=>({scopeId:'language',actor:'language_review',systemPrompt:'write',userMessage:'write',allowedTools:['save'],modelTools:[],textOutputTool:{name:'save',arguments:{},contentArgument:'content'}}),
      completeAfterTool:result=>result.ok ? {artifactVersionId:'saved',content:'done'} : null});
    const result = await runtime.run({projectId:'p',purpose:'test',model:'m',parameters:{},systemPrompt:'root',userMessage:'root',grantedPermissions:[],expectedBodyVersionId:null,budget:{maxModelRequests:12,maxToolCalls:12,maxRetriesPerRequest:0,maxMajorRevisions:0}});
    assert.equal(requests, scenario === 'changing' ? 3 : 2);
    assert.equal(saves, scenario === 'corrected' ? 1 : 0);
    assert.equal(result.ok, scenario === 'corrected');
    if (!result.ok) {
      assert.equal(storage.getRun(result.runId)!.stopReason, 'STAGE_OUTPUT_NOT_SAVED');
      assert.equal(storage.getRun(result.runId)!.status, 'waiting_user');
      assert.equal(storage.listRunEvents(result.runId).at(-1)?.payload.rejectedAttempts, requests);
    }
  } finally {storage.close(); rmSync(dir,{recursive:true,force:true});}
});
}

it('stops resubmitting after the same tool gate rejection repeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-failure-loop-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let requests = 0; let submissions = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('gate-loop', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++;
      yield { type:'tool_call_delta', index:0, id:`call-${requests}`, name:'submit_fact_check', argumentsDelta:'{"claims":[]}' };
      yield { type:'completed', finishReason:'tool_calls' };
    }
  }
  try {
    storage.createProject({operationId:'p',projectId:'p',name:'fixture',mode:'quick',actor:{kind:'user',id:'u'}});
    const tools = ToolRegistry.create([{ name:'submit_fact_check',version:'1.0.0',description:'submit',effect:'local_idempotent',permissions:[],
      inputSchema:{type:'object',properties:{claims:{type:'array'}},required:['claims']},
      execute() { submissions++; throw new ToolExecutionFault('FACT_EVIDENCE_INVALID','saved ledger violates the gate contract',false,{}); } }]);
    const runtime = new AgentRuntime({provider:new Provider(),sessions:storage,tools,
      requestPolicy:()=>({scopeId:'fact',actor:'fact_check',systemPrompt:'check',userMessage:'check',allowedTools:['submit_fact_check']})});
    const result = await runtime.run({projectId:'p',purpose:'test',model:'m',parameters:{},systemPrompt:'root',userMessage:'root',grantedPermissions:[],expectedBodyVersionId:null,budget:{maxModelRequests:12,maxToolCalls:12,maxRetriesPerRequest:0,maxMajorRevisions:0}});
    assert.equal(result.ok, false);
    assert.equal(requests, 3);
    assert.equal(submissions, 3);
    assert.equal(storage.getRun(result.runId)!.stopReason, 'TOOL_FAILURE_LOOP');
    assert.equal(storage.getRun(result.runId)!.status, 'waiting_user');
    assert.equal(storage.listRunEvents(result.runId).at(-1)?.payload.attempts, 3);
  } finally {storage.close(); rmSync(dir,{recursive:true,force:true});}
});

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
