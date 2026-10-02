import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WritingApplicationService } from '../../application/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createApplicationBridge } from '../src/application-bridge.js';
import { DesktopClientBridge } from '../src/desktop-bridge.js';
import { dispatchDesktopRpc } from '../../../apps/desktop/src/rpc-host.js';
import { UI_BRIDGE_PROTOCOL_VERSION } from '../src/protocol.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-trace-detail-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  storage.createProject({ projectId: 'p', operationId: 'create', name: '轨迹测试', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'draft' });
  storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', planVersion: 'test' });
  const schema = { name: 'read_material', description: '读取授权原文', inputSchema: { type: 'object', properties: { materialId: { type: 'string' } } }, version: 'v1', schemaHash: 'test-hash' };
  storage.saveRequestSnapshot({ projectId: 'p', sessionId: 's', runId: 'r', snapshotId: 'snap',
    request: { requestId: 'req', model: 'test-model', messages: [{ role: 'user', content: '请核查假期天数，不修改正文。' }], parameters: {}, tools: [schema] },
    provider: { id: 'test-provider', adapterVersion: 'v1', serializationVersion: 'v1', normalizedPayload: {}, redactions: [], unreconstructableFields: [] },
    assemblyVersion: 'v1', toolSchemas: [schema], contentReferences: [] });
  const event = (type: string, operationId: string, payload: Record<string, unknown>) => storage.recordRunEvent({ projectId: 'p', runId: 'r', type, operationId, payload });
  const model = event('request.dispatch_attempted', 'model-op', { requestId: 'req', snapshotId: 'snap' });
  event('request.completed', 'model-op', { requestId: 'req', responseText: '先读取授权材料，再核对假期天数。', toolCallIds: ['call-1'], finishReason: 'tool_calls' });
  const tool = event('tool.requested', 'tool-op', { requestId: 'req', callId: 'call-1', toolName: 'read_material', arguments: { materialId: 'material-1' } });
  event('tool.completed', 'tool-op', { result: { ok: true, result: { content: '材料原文：假期安排需要核实。', api_key: 'never-display-this', nested: { authorization: 'Bearer hidden-value' }, reasoning_content: 'private-reasoning', example: 'tvly-syntheticsecret12345', link: 'https://example.test/?api_key=hide-query' } } });
  const bridge = createApplicationBridge({ service: new WritingApplicationService({ storage }), workspaceId: 'test', initialProjectId: 'p', initialSessionId: 's',
    model: { model: 'different-current-model', providerLabel: 'current', credentialReference: 'TEST_ONLY', parameters: {} } });
  return { storage, bridge, event, model, tool, input: { projectId: 'p', sessionId: 's', runId: 'r' }, close() { bridge.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('trace details read recorded model input, reply, tool arguments, result and historical schema without model calls', async () => {
  const f = fixture();
  try {
    const before = f.storage.listRunEvents('r').length;
    const model = await f.bridge.getRunTraceDetail({ ...f.input, stepId: f.model.id });
    assert.equal(model.model, 'test-model');
    assert.match(model.sections.find(s => s.id === 'input')!.text, /请核查假期天数/);
    assert.match(model.sections.find(s => s.id === 'output')!.text, /先读取授权材料/);
    assert.match(model.sections.find(s => s.id === 'output')!.text, /read_material/);
    const tool = await f.bridge.getRunTraceDetail({ ...f.input, stepId: f.tool.id });
    assert.equal(tool.callId, 'call-1');
    assert.match(tool.sections.find(s => s.id === 'input')!.text, /material-1/);
    assert.match(tool.sections.find(s => s.id === 'output')!.text, /材料原文：假期安排需要核实/);
    assert.match(tool.sections.find(s => s.id === 'schema')!.text, /读取授权原文/);
    assert.doesNotMatch(JSON.stringify(tool), /never-display-this|hidden-value|private-reasoning|syntheticsecret|hide-query/);
    assert.equal(f.storage.listRunEvents('r').length, before, 'inspection must not write events or consume model calls');
  } finally { f.close(); }
});

test('trace details reject cross-session, cross-project, unrelated event and malformed selections', async () => {
  const f = fixture();
  try {
    for (const input of [{ ...f.input, stepId: f.model.id, sessionId: 'other' }, { ...f.input, stepId: f.model.id, projectId: 'other' },
      { ...f.input, stepId: f.model.id, runId: 'other' }, { ...f.input, stepId: 'not-recorded' }, { ...f.input, stepId: null }]) {
      await assert.rejects(() => f.bridge.getRunTraceDetail(input as never));
    }
  } finally { f.close(); }
});

test('old missing records and oversized results are explicit rather than invented or unbounded', async () => {
  const f = fixture();
  try {
    const old = f.event('tool.requested', 'old', { toolName: 'legacy_tool', arguments: { text: '历史调用' } });
    const missing = await f.bridge.getRunTraceDetail({ ...f.input, stepId: old.id });
    assert.ok(missing.notes.some(note => /未记录/.test(note)));
    f.event('tool.completed', 'old', { result: { ok: true, result: { content: '长'.repeat(160_000) } } });
    const large = await f.bridge.getRunTraceDetail({ ...f.input, stepId: old.id });
    const output = large.sections.find(s => s.id === 'output')!;
    assert.equal(output.truncated, true);
    assert.ok(output.text.length <= 64_000);
    assert.ok(output.totalCharacters > output.text.length);
  } finally { f.close(); }
});

test('desktop inspection travels through the real RPC allowlist without resending or replacing the chat snapshot', async () => {
  const f = fixture();
  const renderer = new DesktopClientBridge({ invoke: request => dispatchDesktopRpc(f.bridge, request), subscribe: () => () => undefined });
  try {
    await renderer.handshake();
    const before = renderer.getSnapshot();
    const input = { ...f.input, stepId: f.tool.id };
    const response = await dispatchDesktopRpc(f.bridge, { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'getRunTraceDetail', args: [input] });
    assert.equal(response.ok, true);
    assert.equal('snapshot' in response, false, 'detail is a lazy payload, never a whole project snapshot');
    const detail = await renderer.getRunTraceDetail(input);
    assert.match(detail.sections.find(section => section.id === 'output')!.text, /材料原文/);
    assert.equal(renderer.getSnapshot(), before);
  } finally { renderer.dispose(); f.close(); }
});

test('retries sharing a request ID cannot borrow another attempt\'s tool calls', async () => {
  const f = fixture();
  try {
    const failed = f.event('request.dispatch_attempted', 'retry-failed', { requestId: 'req' });
    f.event('request.failed', 'retry-failed', { requestId: 'req', error: { code: 'TIMEOUT' } });
    const success = f.event('request.dispatch_attempted', 'retry-success', { requestId: 'req' });
    f.event('request.completed', 'retry-success', { requestId: 'req', responseText: '新请求回复', toolCallIds: ['call-2'] });
    f.event('tool.requested', 'tool-2', { requestId: 'req', callId: 'call-2', toolName: 'different_tool', arguments: {} });
    const failedDetail = await f.bridge.getRunTraceDetail({ ...f.input, stepId: failed.id });
    assert.doesNotMatch(failedDetail.sections.find(section => section.id === 'output')!.text, /read_material|different_tool/);
    const successDetail = await f.bridge.getRunTraceDetail({ ...f.input, stepId: success.id });
    assert.match(successDetail.sections.find(section => section.id === 'output')!.text, /different_tool/);
    assert.doesNotMatch(successDetail.sections.find(section => section.id === 'output')!.text, /read_material/);
  } finally { f.close(); }
});
