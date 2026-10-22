import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { openWorkspaceStorage } from '../../../storage/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../llm/src/index.js';
import { ToolRegistry } from '../../tools/src/index.js';
import { AgentRuntime } from '../src/index.js';

it('corrects a repeated successful read before pausing without spending the full model allowance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-progress-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const requests: ModelRequest[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('progress', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'read_material', argumentsDelta: '{"materialId":"same"}' };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: 'progress', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      tools: ToolRegistry.create([{ name: 'read_material', version: '1.0.0', description: 'read', effect: 'read_only', permissions: [],
        inputSchema: { type: 'object', properties: { materialId: { type: 'string' } }, required: ['materialId'] },
        execute: () => ({ contentVersionId: 'v1', content: 'complete material' }) }]),
      requestPolicy: () => ({ scopeId: 'research', systemPrompt: 'research', userMessage: 'save the research', allowedTools: ['read_material'] }) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'research', userMessage: 'research',
      grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 12, maxToolCalls: 12, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'TOOL_NO_PROGRESS');
    assert.equal(storage.getRun(result.runId)?.status, 'waiting_user');
    assert.equal(requests.length, 3);
    assert.ok(requests[2]!.messages.some(message => message.role === 'user' && message.content.includes('重复') && message.content.includes('下一步')),
      'the model gets one actionable correction before the recoverable pause');
    assert.equal(storage.listRunEvents(result.runId).filter(event => event.type === 'tool.completed').length, 3,
      'successful reads remain successful durable receipts');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const scenario of ['ready-loop', 'pages', 'results', 'scope', 'inputs', 'body-binding', 'saved-artifact', 'harness-artifact', 'corrected', 'volatile-catalog', 'progress-key', 'system-with-key'] as const) {
  it(`recognizes useful progress without confusing it with repeated readiness: ${scenario}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-progress-boundary-'));
    const storage = openWorkspaceStorage({ workspacePath: directory });
    let requests = 0;
    let reads = 0;
    class Provider extends ModelProviderBase {
      constructor() { super('progress-boundary', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests++;
        if (requests === 7 || (scenario === 'corrected' && requests === 3) || (scenario === 'harness-artifact' && requests % 3 === 0)) {
          yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; return;
        }
        const name = scenario === 'ready-loop' ? 'assess_writing_readiness'
          : scenario === 'saved-artifact' && requests % 3 === 0 ? 'save_artifact' : 'read_material';
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name,
          argumentsDelta: JSON.stringify({ page: scenario === 'pages' ? requests : 1 }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
      }
    }
    try {
      storage.createProject({ projectId: 'p', operationId: 'p', name: 'progress', mode: 'quick', actor: { kind: 'user', id: 'u' } });
      const tools = ToolRegistry.create(['read_material', 'assess_writing_readiness', 'save_artifact'].map(name => ({
        name, version: '1.0.0', description: name, effect: name === 'read_material' ? 'read_only' as const : 'local_idempotent' as const,
        permissions: [], inputSchema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
        execute() { reads++; return name === 'assess_writing_readiness' ? { status: 'ready' }
          : { content: 'read or saved content', contentVersionId: scenario === 'results' ? `v${reads}` : 'v1' }; },
      })));
      const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage, tools,
        requestPolicy: () => ({ scopeId: scenario === 'scope' ? `stage-${requests}` : 'fixed',
          systemPrompt: scenario === 'system-with-key' ? `Updated system requirement ${requests}` : 'task',
          userMessage: scenario === 'inputs' || scenario === 'volatile-catalog' ? `Current input or receipt catalog ${requests}` : 'save the stage',
          ...(['volatile-catalog', 'progress-key', 'system-with-key'].includes(scenario)
            ? { progressKey: scenario === 'progress-key' ? `Updated author task ${requests}` : 'unchanged author task' } : {}),
          expectedBodyVersionId: scenario === 'body-binding' ? `body-${requests}` : null,
          allowedTools: ['read_material', 'assess_writing_readiness', 'save_artifact'],
          ...(scenario === 'harness-artifact' ? { textOutputTool: { name: 'save_artifact', arguments: { page: 1 }, contentArgument: 'content' } } : {}) }),
        ...(scenario === 'harness-artifact' ? { completeAfterTool: () => requests >= 7 ? { artifactVersionId: 'saved', content: 'done' } : null } : {}) });
      const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'task', userMessage: 'task',
        grantedPermissions: [], expectedBodyVersionId: null, budget: { maxModelRequests: 12, maxToolCalls: 12, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
      const shouldPause = scenario === 'ready-loop' || scenario === 'volatile-catalog';
      assert.equal(result.ok, !shouldPause, JSON.stringify(result));
      if (shouldPause) {
        assert.equal(requests, 3);
        assert.equal(storage.getRun(result.runId)?.stopReason, 'TOOL_NO_PROGRESS');
      } else assert.equal(requests, scenario === 'corrected' ? 3 : 7);
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

it('does not mistake duplicate reads in one submitted batch for ignoring a correction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-read-batch-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  let requests = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('batch', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      requests++;
      if (requests === 1) {
        for (let index = 0; index < 3; index++) yield { type: 'tool_call_delta', index, id: `read-${index}`, name: 'read_material', argumentsDelta: '{}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else { yield { type: 'text_delta', delta: 'done' }; yield { type: 'completed', finishReason: 'stop' }; }
    }
  }
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: 'batch', mode: 'quick', actor: { kind: 'user', id: 'u' } });
    const runtime = new AgentRuntime({ provider: new Provider(), sessions: storage,
      tools: ToolRegistry.create([{ name: 'read_material', version: '1.0.0', description: 'read', effect: 'read_only', permissions: [],
        inputSchema: { type: 'object', properties: {} }, execute: () => ({ content: 'same content' }) }]) });
    const result = await runtime.run({ projectId: 'p', purpose: 'test', model: 'm', parameters: {}, systemPrompt: 'read', userMessage: 'read',
      grantedPermissions: [], expectedBodyVersionId: null });
    assert.equal(result.ok, true, 'a pre-submitted batch has not yet seen or ignored any corrective feedback');
    assert.equal(requests, 2);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
