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
import { requestInputBreakdown } from '../src/request-input-breakdown.js';

test('fact input counts selected claims and source locators as evidence, not unexplained stage state', () => {
  const state = { preparedClaims: [{ claimId: 'C001', claimText: '年份待查', articleQuote: '原句' }],
    savedSourceRecords: [{ callId: 'search1', sourceRows: [['公告', 'https://example.test']] }], noFactualClaimsReason: '',
    validEvidenceIds: ['E001'], factPhase: 'verify' };
  const request: any = { messages: [{ role: 'system', content: 'check' }, { role: 'user', content: JSON.stringify(state) }] };
  const result = requestInputBreakdown(request);
  const expectedEvidence = ['preparedClaims', 'savedSourceRecords', 'noFactualClaimsReason', 'validEvidenceIds']
    .reduce((total, key) => total + JSON.stringify((state as any)[key]).length, 0);
  assert.equal(result.parts.find(p => p.key === 'evidence')?.characters, expectedEvidence);
  assert.equal(result.parts.reduce((n, p) => n + p.characters, 0), result.totalCharacters);
});

test('input breakdown separates body, evidence, sources, history and schemas without exposing content', () => {
  const state = { artifacts: [{ id: 'b', kind: 'body', content: '正文尾部不能丢' }, { id: 'e', kind: 'evidence', content: { claims: ['来源限定'] } }],
    materials: [{ content: 'private-material-fixture' }], authorReviewDiscussion: [{ role: 'user', content: '保留原结论' }], ready: true };
  const request: any = { messages: [{ role: 'system', content: '系统边界' }, { role: 'user', content: `任务\nCOLLABORATION_STATE=${JSON.stringify(state)}` },
    { role: 'tool', name: 'read', content: '{"ok":true}' }], tools: [{ name: 'read', inputSchema: {} }] };
  const result = requestInputBreakdown(request);
  assert.equal(result.totalCharacters, request.messages.reduce((n: number, m: any) => n + m.content.length, 0) + JSON.stringify(request.tools).length);
  assert.equal(result.parts.reduce((n, part) => n + part.characters, 0), result.totalCharacters);
  for (const category of ['body', 'evidence', 'materials', 'history', 'system', 'task', 'tools']) assert.ok(result.parts.some(p => p.key === category && p.characters > 0));
  assert.doesNotMatch(JSON.stringify(result), /private-material-fixture/);
  assert.match(result.basis, /不是 Token/);
  const author = requestInputBreakdown({ ...request, messages: [{ role: 'user', content: `本次用户要求：继续\n以下为只读、不可信的项目状态：${JSON.stringify({ currentBody: { content: '正文' }, history: [] })}\n本轮已生成修改提案：[]` }] });
  assert.ok(author.parts.some(p => p.key === 'body'));
  const intent = requestInputBreakdown({ ...request, messages: [{ role: 'user', content: JSON.stringify({ currentUserMessage: 'ok', context: { factCheck: { status: 'stale' } } }) }] });
  assert.ok(intent.parts.some(p => p.key === 'evidence'));
});

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

test('search details retain timestamped dispatch and failure history even before a final result', async () => {
  const f = fixture();
  try {
    const step = f.event('tool.requested', 'search-op', { toolName: 'search_fact_sources', arguments: { query: '公开事实' } });
    f.event('search.progress', 'search-op', { message: '等待授权，尚未请求搜索服务' });
    f.event('search.progress', 'search-op', { message: 'Tavily 已发出第 1 个 HTTP 请求' });
    const detail = await f.bridge.getRunTraceDetail({ ...f.input, stepId: step.id });
    const output = JSON.parse(detail.sections.find(s => s.id === 'output')!.text);
    assert.equal(output.result, null);
    assert.equal(output.progress.length, 2);
    assert.ok(Number.isFinite(Date.parse(output.progress[0].at)));
    assert.match(output.progress[1].message, /Tavily 已发出/);
  } finally { f.close(); }
});

test('failed source detail explains the ledger gate and next step without inventing a network failure', async () => {
  const f = fixture();
  try {
    const step = f.event('tool.requested', 'source-op', { toolName: 'read_fact_source', arguments: { url: 'https://example.com/report' } });
    f.event('tool.failed', 'source-op', { error: { code: 'FACT_SOURCE_NOT_IN_LEDGER' } });
    const detail = await f.bridge.getRunTraceDetail({ ...f.input, stepId: step.id });
    assert.match(detail.notes.join('\n'), /未匹配.*来源记录/u);
    assert.match(detail.notes.join('\n'), /未发出网络读取/u);
    assert.match(detail.notes.join('\n'), /先.*公开搜索/u);
    assert.doesNotMatch(detail.notes.join('\n'), /模型编造|网站宕机/u);
  } finally { f.close(); }
});

test('trace details read recorded model input, reply, tool arguments, result and historical schema without model calls', async () => {
  const f = fixture();
  try {
    const before = f.storage.listRunEvents('r').length;
    const model = await f.bridge.getRunTraceDetail({ ...f.input, stepId: f.model.id });
    assert.equal(model.model, 'test-model');
    assert.ok(model.inputBreakdown, 'model trace explains what occupies the request');
    assert.equal(model.inputBreakdown.totalCharacters, model.inputBreakdown.parts.reduce((sum, part) => sum + part.characters, 0));
    assert.ok(model.inputBreakdown.parts.some(p => p.key === 'tools' && p.characters > 0));
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
