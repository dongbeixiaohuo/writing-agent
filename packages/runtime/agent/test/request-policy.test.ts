import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openWorkspaceStorage } from "../../../storage/src/index.js";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../llm/src/index.js";
import { ToolRegistry, ToolExecutionFault } from "../../tools/src/index.js";
import { AgentRuntime } from "../src/index.js";
import { canonicalJson, contentHash } from "../../../writing-core/src/index.js";

it('restricts role fields in the offered schema and durable snapshot without changing the registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-schema-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const requests: ModelRequest[] = [];
  let writes = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('role-schema', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      assert.deepEqual(request.tools?.map(tool => tool.name), ['submit']);
      const schema = request.tools![0]!.inputSchema;
      assert.deepEqual(schema.required, writes ? ['content'] : ['content', 'findings']);
      assert.deepEqual(Object.keys(schema.properties as object).sort(), writes ? ['audit', 'content', 'findings'] : ['content', 'findings']);
      assert.equal(schema.additionalProperties, writes ? undefined : false);
      const properties = schema.properties as { content: { anyOf: unknown[] } };
      assert.deepEqual(properties.content.anyOf, writes ? [{ type: 'string', minLength: 1 }, { type: 'object' }] : [{ type: 'string', minLength: 1 }]);
      if (writes) { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; return; }
      if (requests.length === 2) assert.match(JSON.stringify(request.messages), /findings/);
      if (requests.length === 3) assert.match(JSON.stringify(request.messages), /audit/);
      yield { type: 'tool_call_delta', index: 0, id: `call-${requests.length}`, name: 'submit',
        argumentsDelta: JSON.stringify({ content: 'review', ...(requests.length > 1 ? { findings: [] } : {}),
          ...(requests.length === 2 ? { audit: {} } : {}) }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const registry = ToolRegistry.create([
      { name: 'submit', version: '1.0.0', description: 'submit', effect: 'local_idempotent', permissions: [],
        inputSchema: { type: 'object', properties: { content: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
          findings: { type: 'array' }, audit: { type: 'object' } }, required: ['content'] },
        execute() { writes++; return {}; } },
      { name: 'outside', version: '1.0.0', description: 'outside', effect: 'read_only', permissions: [],
        inputSchema: { type: 'object', properties: {} }, execute() { assert.fail('not authorized'); } },
    ]);
    const before = structuredClone(registry.schemaSnapshots());
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: registry,
      requestPolicy: () => ({ scopeId: writes ? 'next-role' : 'review', allowedTools: ['submit'], systemPrompt: 'review', userMessage: 'review',
        ...(!writes ? { roleToolFields: { submit: { allowed: ['content', 'findings'], required: ['findings'], stringFields: ['content'] } } } : {}) }) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
      grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(writes, 1, 'submissions with missing or unexpected fields must never execute');
    assert.equal(requests.length, 4);
    assert.deepEqual(registry.schemaSnapshots(), before, 'the next role must not inherit required fields');
    const dispatched = storage.listRunEvents(result.runId).filter(e => e.type === 'request.dispatch_attempted');
    assert.equal(dispatched.length, requests.length);
    for (const [index, event] of dispatched.entries()) {
      const snapshot = storage.getRequestSnapshot(event.payload.snapshotId as string)!;
      const schema = snapshot.toolSchemas[0]!;
      assert.deepEqual(snapshot.request.tools, requests[index]!.tools);
      assert.deepEqual(schema.inputSchema, requests[index]!.tools![0]!.inputSchema);
      assert.equal(schema.schemaHash, contentHash(canonicalJson({ name: schema.name, version: schema.version,
        description: schema.description, inputSchema: schema.inputSchema })));
    }
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const invalidFields of [{ allowed: ['invented'] }, { allowed: [] }, { stringFields: ['content'] }]) {
it(`rejects an invalid role schema before dispatch (${JSON.stringify(invalidFields)})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invalid-role-schema-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('invalid-schema', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { requests++; yield { type: 'completed', finishReason: 'stop' }; }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const registry = ToolRegistry.create([{ name: 'submit', version: '1.0.0', description: 'submit', effect: 'read_only', permissions: [],
      inputSchema: { type: 'object', properties: { content: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'string', maxLength: 2 }] } },
        required: ['content'] }, execute() { assert.fail('invalid schema must not execute'); } }]);
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: registry,
      requestPolicy: () => ({ scopeId: 'review', allowedTools: ['submit'], roleToolFields: { submit: invalidFields }, systemPrompt: 'review', userMessage: 'review' }) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'test', userMessage: 'test',
      grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, false);
    assert.equal(storage.getRun(result.runId)!.stopReason, 'TOOL_SCHEMA_POLICY_INVALID');
    assert.equal(requests, 0);
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});
}

it('specific tool validation feeds one correction back without weakening role authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-specific-validation-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let calls = 0, executed = 0, validations = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('validation', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      calls++;
      if (calls === 2) assert.match(request.messages.findLast(m => m.role === 'tool')!.content, /FACT_SUBMISSION_INCOMPLETE.*C002/);
      if (calls === 3) assert.match(request.messages.findLast(m => m.role === 'tool')!.content, /TOOL_PERMISSION_DENIED/);
      if (calls === 4) { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; return; }
      yield { type: 'tool_call_delta', index: 0, id: `call-${calls}`, name: calls === 2 ? 'outside' : 'submit', argumentsDelta: '{}' };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: 'Validation', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const tool = (name: string): any => ({ name, version: '1.0.0', description: name, effect: 'read_only', permissions: [], inputSchema: { type: 'object', properties: {} }, execute: () => { executed++; return {}; } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools: ToolRegistry.create([tool('submit'), tool('outside')]),
      requestPolicy: () => ({ scopeId: 'fact', systemPrompt: 'fact', userMessage: 'claims', allowedTools: ['submit', 'outside'], authorizeTool: call => call.name !== 'outside',
        toolValidationError: () => { validations++; return calls === 1 ? { code: 'FACT_SUBMISSION_INCOMPLETE', message: '补齐C002', retryable: false, details: { missingClaimIds: ['C002'] } } : null; } }) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'fact', userMessage: 'claims', grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(executed, 1, 'incomplete and forbidden calls must never execute');
    assert.equal(validations, 2, 'forbidden roles must not reach argument validation');
  } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

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

it('projects paired history only for requests, retaining raw durable results and accurate snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'request-history-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const requests: ModelRequest[] = [];
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
      tools: ToolRegistry.create([{ name: 'read', version: '1.0.0', description: 'read', effect: 'read_only', permissions: [], inputSchema: { type: 'object', properties: {} }, execute() { return { text: 'RAW_CONTENT' }; } }]),
      requestPolicy: () => ({ scopeId: 'fixed', systemPrompt: 'read', userMessage: 'read', allowedTools: ['read'],
        projectHistory: messages => requests.length < 2 ? messages : messages.filter(m =>
          !(m.role === 'assistant' && m.toolCalls?.some(c => c.id === 'c1')) && !(m.role === 'tool' && m.toolCallId === 'c1')) }),
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'read', userMessage: 'read', grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true);
    assert.equal(requests[2]!.messages.filter(m => m.role === 'tool').length, 1);
    assert.equal(requests[2]!.messages.find(m => m.role === 'tool')!.toolCallId, 'c2');
    assert.equal(storage.listRunEvents(result.runId).filter(e => e.type === 'tool.completed').length, 2);
    assert.match(JSON.stringify(storage.listRunEvents(result.runId)), /RAW_CONTENT/);
    const snapshot = storage.getRequestSnapshot(storage.listRunEvents(result.runId).findLast(e => e.type === 'request.dispatch_attempted')!.payload.snapshotId as string);
    assert.deepEqual(snapshot!.request.messages, requests[2]!.messages);
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

for (const repeatSameSource of [false, true]) {
it(`counts source read failures by target without weakening submission gates: same source=${repeatSameSource}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-failure-scope-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('source-fallback', '1', { protocol:'mock', streaming:'supported', tools:'supported', usage:'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests++;
      if (requests === 1) {
        for (let index = 0; index < 3; index++) yield { type:'tool_call_delta', index, id:`read-${index}`, name:'read_fact_source',
          argumentsDelta:JSON.stringify({ url: `https://source.example/${repeatSameSource ? 'same' : index}` }) };
        yield { type:'completed', finishReason:'tool_calls' };
      } else {
        assert.equal(request.messages.filter(m => m.role === 'tool').length, 3, 'all failed read receipts must reach the checker');
        yield { type:'tool_call_delta', index:0, id:'submit', name:'submit_fact_check', argumentsDelta:'{}' };
        yield { type:'completed', finishReason:'tool_calls' };
      }
    }
  }
  try {
    storage.createProject({operationId:'p',projectId:'p',name:'fixture',mode:'quick',actor:{kind:'user',id:'u'}});
    const tools = ToolRegistry.create([
      { name:'read_fact_source',version:'1.0.0',description:'read',effect:'read_only',permissions:[],
        inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url']},
        execute() { throw new ToolExecutionFault('WEB_REQUEST_FAILED','use the already saved search excerpt; original page unavailable'); } },
      { name:'submit_fact_check',version:'1.0.0',description:'submit',effect:'local_idempotent',permissions:[],
        inputSchema:{type:'object',properties:{}}, execute() { return { saved:true }; } },
    ]);
    const runtime = new AgentRuntime({provider:new Provider(),sessions:storage,tools,
      requestPolicy:()=>({scopeId:'fact',actor:'fact_check',systemPrompt:'check',userMessage:'saved search excerpts',allowedTools:['read_fact_source','submit_fact_check'],
        toolFailureLoopKey:(call: any, error: any)=>`${call.name}:${error.code}:${call.arguments.url ?? ''}`}),
      completeAfterTool:result=>result.ok && result.toolName === 'submit_fact_check' ? {artifactVersionId:'body',content:'checked using saved excerpts; original unread'} : null});
    const result = await runtime.run({projectId:'p',purpose:'test',model:'m',parameters:{},systemPrompt:'root',userMessage:'root',grantedPermissions:[],expectedBodyVersionId:null,
      budget:{maxModelRequests:4,maxToolCalls:8,maxRetriesPerRequest:0,maxMajorRevisions:0}});
    assert.equal(result.ok, !repeatSameSource, JSON.stringify(result));
    assert.equal(requests, repeatSameSource ? 1 : 2);
    assert.equal(storage.getRun(result.runId)!.status, repeatSameSource ? 'waiting_user' : 'completed');
    assert.equal(storage.getRun(result.runId)!.stopReason, repeatSameSource ? 'TOOL_FAILURE_LOOP' : null);
  } finally {storage.close(); rmSync(dir,{recursive:true,force:true});}
});
}

for (const [format, scenario] of [
  ['text', 'save'], ['text', 'cancel'], ['text', 'truncated'], ['text', 'timeout'], ['text', 'revoked'], ['text', 'permission'], ['text', 'empty'],
  ['json_object', 'save'], ['json_object', 'cancel'], ['json_object', 'revoked'], ['json_object', 'permission'],
] as const) {
it(`harness text save retains tool safety boundaries: ${format}/${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'text-save-policy-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const controller = new AbortController();
  let scope = 'outline'; let writes = 0; let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('text-save', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests++;
      assert.equal(request.tools, undefined, 'local save authority must not be offered to the model');
      const content = '# 提纲\n\n开篇，观察，收束。';
      yield { type: 'text_delta', delta: scenario === 'empty' ? '' : format === 'json_object' ? JSON.stringify({ stage: 'outline', content }) : content };
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
        textOutputTool: format === 'json_object' ? { name: 'save', arguments: { stage: 'outline' }, format }
          : { name: 'save', arguments: { stage: 'outline' }, contentArgument: 'content' } }),
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

const validReviewJson = JSON.stringify({ content: '原句把具体测量对象误写成总体信任。', findings: [] });
for (const [name, responses, succeeds] of [
  ['repairs invalid JSON', ['{"content":', validReviewJson], true],
  ['stops repeated malformed JSON', ['{"content":', '{"content":'], false],
  ['bounds invalid JSON objects', ['[]', 'null', '{"number":1e1000}'], false],
  ['rejects a conflicting fixed stage', ['{"stage":"draft","content":"wrong actor","findings":[]}', validReviewJson], true],
  ['applies local role field constraints', ['{"content":"missing findings"}', validReviewJson], true],
] as const) {
it(`JSON text output ${name}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-text-save-'));
  const storage = openWorkspaceStorage({ workspacePath: dir });
  const requests: ModelRequest[] = [];
  let saves = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('json-text-save', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      assert.equal(request.tools, undefined);
      const response = responses[requests.length]!;
      requests.push(request);
      yield { type: 'text_delta', delta: response };
      yield { type: 'completed', finishReason: 'stop' };
    }
  }
  try {
    storage.createProject({ operationId: 'p', projectId: 'p', name: 'test', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const tools = ToolRegistry.create([{ name: 'save', version: '1.0.0', description: 'save', effect: 'local_idempotent', permissions: [],
      inputSchema: { type: 'object', properties: { stage: { type: 'string' }, content: { type: 'string' }, findings: { type: 'array' } },
        required: ['stage', 'content'], additionalProperties: false },
      execute(args) { assert.deepEqual(args, { stage: 'review_editor', ...JSON.parse(validReviewJson) }); saves++; return {}; } }]);
    const previews: unknown[] = [];
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools,
      requestPolicy: () => ({ scopeId: 'review', actor: 'review_editor', allowedTools: ['save'], modelTools: [], systemPrompt: 'review', userMessage: 'review',
        outputPreview: { id: 'must-not-preview', stage: 'review_editor' }, textAudience: 'conversation',
        textOutputTool: { name: 'save', arguments: { stage: 'review_editor' }, format: 'json_object' },
        roleToolFields: { save: { allowed: ['stage', 'content', 'findings'], required: ['findings'] } },
        authorizeTool: call => (call.arguments as { stage?: string }).stage === 'review_editor' }),
      onModelStream: event => { if (event.textAudience || event.outputPreview) previews.push(event); },
      completeAfterTool: result => result.ok ? { artifactVersionId: 'saved', content: 'saved' } : null,
    });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'root', userMessage: 'root',
      grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 8, maxToolCalls: 8, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, succeeds, JSON.stringify(result));
    assert.equal(requests.length, responses.length);
    assert.equal(saves, succeeds ? 1 : 0);
    assert.deepEqual(previews, [], 'JSON text is never exposed as a conversation or stage preview');
    const localCalls = storage.listRunEvents(result.runId).filter(event => event.type === 'tool.requested');
    assert.equal(localCalls.length, name === 'applies local role field constraints' ? 2 : succeeds ? 1 : 0);
    assert.ok(localCalls.every(event => (event.payload.arguments as { stage?: string }).stage === 'review_editor' && event.payload.previewId === undefined));
    assert.match(JSON.stringify(requests[1]!.messages), /完整.*JSON/u);
    if (!succeeds) assert.equal(storage.getRun(result.runId)?.stopReason, 'STAGE_OUTPUT_NOT_SAVED');
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
