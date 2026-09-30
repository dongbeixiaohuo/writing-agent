import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { TOOL_PRESENTATION, recordedActorLabel } from '../src/tool-presentation.js';
import { WritingApplicationService } from '../../application/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createApplicationBridge } from '../src/application-bridge.js';
import { savePublicationCandidates } from '../../application/src/publication-choice.js';

test('body edits keep displayed title choices available with unchanged ordinals and a fresh-check explanation', async () => {
  const f = await fixture();
  try {
    const actor = { kind: 'user', id: 'test' } as const;
    f.storage.commitArtifactVersion({ projectId: 'project', operationId: 'body', expectedProjectRevision: f.storage.inspectProject('project')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 旧稿\n\n文章。', reason: 'test', actor });
    const oldBody = f.storage.inspectProject('project')!.latestBodyVersionId!;
    savePublicationCandidates(f.storage, 'project', 'choices', oldBody, ['慢一点', '窗边的安静'].map(title => ({ title, opening: null, distributionCopy: null, rationale: '观察' })));
    f.storage.commitArtifactVersion({ projectId: 'project', operationId: 'edit', expectedProjectRevision: f.storage.inspectProject('project')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: oldBody, content: '# 新稿\n\n修改后的文章。', reason: 'test', actor });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'wait', reason: 'WRITING_INPUT_REQUIRED',
      payload: { kind: 'publication_selection', nextStage: 'fact_check', reason: '请选择标题', questions: [] } });
    const request = (await f.snapshot()).recoverableRuns.find(r => r.runId === 'run')?.inputRequest;
    assert.deepEqual(request?.candidates?.map(c => c.title), ['慢一点', '窗边的安静']);
    assert.match(request?.reason ?? '', /正文已更新.*按当前稿件核查/u);
  } finally { f.close(); }
});

function declaredWritingTools(source: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(node.properties.filter(ts.isPropertyAssignment)
        .map(property => [property.name.getText().replace(/^['"]|['"]$/g, ''), property.initializer]));
      const name = fields.get('name');
      if (name && ts.isStringLiteral(name) && fields.has('inputSchema') && fields.has('permissions') && fields.has('effect')) names.push(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('tools.ts', source, ts.ScriptTarget.Latest, true));
  return names;
}

test('tool inventory distinguishes registered definitions from upstream MCP calls and output references', () => {
  assert.deepEqual(declaredWritingTools(`
    const definition = { name: 'search_fact_sources', inputSchema: {}, permissions: [], effect: 'read_only', execute: async () => null };
    const request = { method: 'tools/call', params: { name: 'web_search', arguments: {} } };
    const preview = { name: 'submit_writing_stage', arguments: {}, contentArgument: 'content' };
  `), ['search_fact_sources']);
});

test('every declared writing tool has display documentation, while caller names are a fixed allowlist', () => {
  const declared = new Set<string>();
  for (const base of ['packages/application/src', 'packages/runtime/tools/src']) {
    for (const file of readdirSync(base).filter(file => file.endsWith('.ts'))) {
      const source = readFileSync(join(base, file), 'utf8');
      for (const name of declaredWritingTools(source)) {
        declared.add(name);
        const info = TOOL_PRESENTATION[name];
        assert.ok(info?.description && info.label && info.category, `Missing display metadata for ${name}`);
      }
    }
  }
  for (const name of ['search_fact_sources', 'read_fact_source', 'read_material', 'submit_writing_stage', 'interpret_author_reply']) assert.ok(declared.has(name), name);
  for (const role of ['intake', 'director', 'research', 'outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review', 'fact_check', 'title']) assert.ok(recordedActorLabel(role), role);
  assert.equal(recordedActorLabel('constructor'), null);
});

async function fixture(purpose = 'writing-pack:draft') {
  const path = mkdtempSync(join(tmpdir(), 'wa-collaboration-view-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  const service = new WritingApplicationService({ storage });
  service.createProject({ operationId: 'create', projectId: 'project', name: '交互验收', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'project', sessionId: 'session', purpose: 'writing-pack:draft' });
  storage.startRun({ projectId: 'project', sessionId: 'session', runId: 'run', purpose, planVersion: 'test', displayInstruction: '开始' });
  const bridge = createApplicationBridge({ service, workspaceId: 'test', model: { model: 'test', providerLabel: 'test', credentialReference: null, parameters: { temperature: 0, toolChoice: 'auto' } } });
  await bridge.selectSession('project', 'session');
  return {
    storage, service, bridge,
    event(type: Parameters<typeof storage.recordRunEvent>[0]['type'], operationId: string, payload: Record<string, unknown>) {
      storage.recordRunEvent({ projectId: 'project', runId: 'run', operationId, type, payload });
    },
    async snapshot() { await bridge.refresh(); return bridge.getSnapshot(); },
    close() { bridge.dispose(); storage.close(); rmSync(path, { recursive: true, force: true }); },
  };
}

test('permission-loop diagnostics survive later waits and explain the concrete cause in main chat', async () => {
  const f = await fixture();
  try {
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'permission-loop', reason: 'TOOL_FAILURE_LOOP',
      payload: { tool: 'read_artifact_version', validationCode: 'TOOL_PERMISSION_DENIED', attempts: 3 } });
    const snapshot = await f.snapshot();
    const recovery = snapshot.recoverableRuns.find(r => r.runId === 'run');
    assert.equal(recovery?.validationFailure?.code, 'TOOL_PERMISSION_DENIED');
    assert.match(recovery!.validationFailure!.explanation, /不是文章事实核查不通过/);
    f.storage.resumeRun({ projectId: 'project', runId: 'run', operationId: 'retry', decision: 'resume' });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'checkpoint', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'language_review', nextStage: 'fact_check' } });
    const later = await f.snapshot();
    const error = later.timelineBySession.session.find(item => item.kind === 'tool' && item.label === '自动重试已暂停');
    assert.ok(error?.kind === 'tool');
    assert.match(error.detail, /当前阶段权限之外/);
  } finally { f.close(); }
});

test('a paused question already covered by the reason is shown once, not twice', async () => {
  const f = await fixture();
  try {
    const reason = '只剩一处发布层面事项需要你确认：事实核查以完整正文、锁定标题与分发文案为核查范围，正文本身这一版不动，可以吗？';
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'need-input', reason: 'WRITING_INPUT_REQUIRED',
      payload: { reason, questions: ['事实核查以完整正文、锁定标题与分发文案为核查范围，正文本身这一版不动，可以吗？'] } });
    const snapshot = await f.snapshot();
    const pauseMessage = snapshot.timelineBySession.session.find(item => item.kind === 'message' && item.body.includes('需要补充信息，写作已暂停'));
    assert.ok(pauseMessage?.kind === 'message');
    assert.equal(/\d+\. /u.test(pauseMessage.body), false, 'the covered question must not be repeated as a numbered item');
    assert.ok(pauseMessage.body.includes('可以吗'));

    f.storage.resumeRun({ projectId: 'project', runId: 'run', operationId: 'r', decision: 'resume', displayInstruction: '继续' });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'need-input-2', reason: 'WRITING_INPUT_REQUIRED',
      payload: { reason, questions: ['你那段加班经历具体发生在哪一年？'] } });
    const second = (await f.snapshot()).timelineBySession.session.filter(item => item.kind === 'message' && item.body.includes('需要补充信息，写作已暂停')).at(-1);
    assert.ok(second?.kind === 'message');
    assert.ok(second.body.includes('1. 你那段加班经历具体发生在哪一年？'), 'a genuinely different question still shows as a numbered item');
  } finally { f.close(); }
});

test('model failure surfaces the sanitized upstream reason in the timeline', async () => {
  const f = await fixture();
  try {
    f.event('request.dispatch_attempted', 'model-1', { requestId: 'request-1' });
    f.event('request.failed', 'model-1', {
      error: { code: 'INVALID_REQUEST', message: '模型服务拒绝了请求参数' },
      providerHttpStatus: 400,
      providerDetail: 'unknown parameter: include',
    });
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'fail', status: 'failed', stopReason: 'INVALID_REQUEST' });
    const snapshot = await f.snapshot();
    const row = snapshot.timelineBySession.session.find(item => item.kind === 'tool' && item.label === '运行失败');
    assert.ok(row?.kind === 'tool');
    assert.match(row.detail, /模型服务拒绝了请求/u);
    assert.match(row.detail, /上游返回：unknown parameter: include/u);
    const requestRow = snapshot.timelineBySession.session.find(item => item.kind === 'tool' && item.label === '写作模型');
    assert.ok(requestRow?.kind === 'tool');
    assert.match(requestRow.detail, /上游返回：unknown parameter: include/u);
  } finally { f.close(); }
});

test('timeout diagnostics expose a safe local deadline and response timing, not a provider failure claim', async () => {
  const f = await fixture();
  try {
    f.event('request.dispatch_attempted', 'timeout-phase', {});
    f.event('request.outcome_unknown', 'timeout-phase', { error: { code: 'TIMEOUT' },
      transport: { phase: 'stream_idle', timeoutMs: 90000, elapsedMs: 110000, firstResponseMs: 20, lastActivityMs: 20000, privateField: 'SECRET' },
      stream: { headersMs: 15, firstContentMs: 20, lastContentMs: 20000, contentEvents: 8, privateField: 'SECRET' } });
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'wait-phase', status: 'waiting_user', stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' });
    const snapshot = await f.snapshot();
    const request = snapshot.runRecords[0]!.diagnostics!.segments[0]!.modelRequests[0]!;
    assert.equal(request.transport?.phase, 'stream_idle');
    assert.equal(request.stream?.firstContentMs, 20);
    assert.equal(snapshot.recoverableRuns[0]?.interruption?.timeoutPhase, 'stream_idle');
    assert.doesNotMatch(JSON.stringify(request), /SECRET/);
  } finally { f.close(); }
});

test('legacy checkpoint without a visible artifact still asks a readable question without inventing content', async () => {
  const f = await fixture();
  try {
    f.event('run.waiting_user', 'legacy-wait', { stopReason: 'CO_CREATION_CHECKPOINT', stage: 'outline', nextStage: 'draft' });
    const timeline = (await f.snapshot()).timelineBySession.session!;
    const question = timeline.find(item => item.kind === 'message' && item.body.includes('这个方向可以吗？'));
    assert.ok(question?.kind === 'message');
    assert.doesNotMatch(question.body, /已保存|本阶段成果/);
    assert.equal(timeline.filter(item => item.kind === 'tool' && item.audience === 'conversation' && item.label === '等待你的确认').length, 0);
  } finally { f.close(); }
});

test('intake diagnostics name the tool, explain its purpose and project only confirmed result states', async () => {
  const f = await fixture('writing-pack:intake');
  try {
    f.event('tool.requested', 'save', { toolName: 'respond_writing_intake' });
    f.event('tool.completed', 'save', { result: { ok: true, toolName: 'respond_writing_intake', result: { phase: 'proposal', reply: 'private reply', summary: 'private summary' } } });
    const group = (await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.toolGroups[0]!;
    assert.equal(group.label, '保存需求交流');
    assert.match(group.description!, /待确认方案/u);
    assert.deepEqual(group.callers, [{ label: '需求澄清助手（按运行类型）', count: 1 }]);
    assert.deepEqual(group.outcomes, [{ label: '已保存待确认方案，尚未确认', count: 1 }]);
    assert.doesNotMatch(JSON.stringify(group), /private reply|private summary/u);
  } finally { f.close(); }
});

test('shared tools retain recorded actor counts; historical or invalid actors stay unknown', async () => {
  const f = await fixture();
  try {
    for (const [id, actor] of [['a', 'director'], ['b', 'researcher'], ['c', undefined], ['d', 'sk-secret-value']] as const) {
      f.event('tool.requested', id, { toolName: 'read_material', ...(actor ? { actor } : {}) });
      f.event('tool.completed', id, { result: { ok: true, toolName: 'read_material', result: {} } });
    }
    const group = (await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.toolGroups[0]!;
    assert.deepEqual(group.callers, [{ label: '写作导演', count: 1 }, { label: '资料研究', count: 1 }, { label: '未记录调用者', count: 2 }]);
    assert.doesNotMatch(JSON.stringify(group), /sk-secret/u);
  } finally { f.close(); }
});

test('unknown tools are identified as unregistered and failed saves never claim a saved proposal', async () => {
  const f = await fixture('writing-pack:intake');
  try {
    f.event('tool.requested', 'save', { toolName: 'respond_writing_intake' });
    f.event('tool.failed', 'save', { result: { ok: false, error: { code: 'INTAKE_SOURCE_QUOTE_INVALID' }, result: { phase: 'confirmed' } } });
    f.event('tool.requested', 'future', { toolName: 'future_tool' });
    const groups = (await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.toolGroups;
    assert.deepEqual(groups[0]!.outcomes, []);
    assert.equal(groups[1]!.label, '未登记的工具');
    assert.equal(groups[1]!.toolName, 'future_tool');
  } finally { f.close(); }
});

test('run records retain their own tool details and director reasoning for diagnostics', async () => {
  const f = await fixture();
  try {
    f.event('tool.requested', 'read-1', { toolName: 'read_material' });
    f.event('tool.completed', 'read-1', { result: { ok: true, toolName: 'read_material', result: {} } });
    f.event('tool.requested', 'decision', { toolName: 'director_decide' });
    f.event('tool.completed', 'decision', { result: { ok: true, toolName: 'director_decide', result: { collaboration: { stage: 'fact_check', status: 'completed', reason: '正文 abc123 及标题门禁 passed' } } } });
    const snapshot = await f.snapshot();
    assert.match(JSON.stringify(snapshot.runRecords[0]?.diagnostics), /读取参考材料/u);
    assert.match(JSON.stringify(snapshot.runRecords[0]?.diagnostics), /abc123/u);
    assert.equal(snapshot.runRecords[0]?.activity, undefined, 'new snapshots use bounded diagnostics rather than legacy timeline activity');
    const director = snapshot.timelineBySession.session.find(item => item.id.endsWith(':director'));
    assert.equal(director?.kind === 'message' ? director.audience : null, 'diagnostic');
  } finally { f.close(); }
});

test('recovery explains the current model interruption and an accepted reply without reusing old failures', async () => {
  const f = await fixture();
  try {
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'checkpoint', reason: 'WRITING_INPUT_REQUIRED', payload: {kind: 'publication_selection', reason: '选标题', questions: ['请选择']} });
    f.storage.resumeRun({ projectId: 'project', runId: 'run', operationId: 'ok', decision: 'resume', displayInstruction: 'ok' });
    f.event('request.dispatch_attempted', 'timeout', {});
    f.event('request.outcome_unknown', 'timeout', { error: { code: 'TIMEOUT', message: 'secret provider response' } });
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'wait', status: 'waiting_user', stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' });
    assert.equal((await f.snapshot()).recoverableRuns[0]?.inputRequest, undefined, 'old title choices are not the current recovery decision');
    assert.deepEqual((await f.snapshot()).recoverableRuns[0]?.interruption,
      { source: 'model', cause: 'timeout', replyAccepted: true });
    f.storage.resumeRun({ projectId: 'project', runId: 'run', operationId: 'retry', decision: 'retry_unknown' });
    f.event('tool.requested', 'external', { toolName: 'external-write' });
    f.event('tool.outcome_unknown', 'external', { error: { code: 'TIMEOUT' } });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'wait-tool', reason: 'UNKNOWN_EXTERNAL_OUTCOME' });
    assert.deepEqual((await f.snapshot()).recoverableRuns[0]?.interruption,
      { source: 'tool', cause: 'timeout', replyAccepted: false });
    f.storage.resumeRun({ projectId: 'project', runId: 'run', operationId: 'retry-tool', decision: 'retry_unknown' });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'need-input', reason: 'WRITING_INPUT_REQUIRED' });
    assert.equal((await f.snapshot()).recoverableRuns[0]?.interruption, undefined);
  } finally { f.close(); }
});

test('run diagnostics preserve every model attempt and aggregate reads by known material without leaking tool bodies', async () => {
  const f = await fixture();
  try {
    f.event('request.dispatch_attempted', 'model-1', { requestId: 'request-1' });
    f.event('request.failed', 'model-1', { error: { code: 'MODEL_OUTPUT_TRUNCATED', message: 'secret request body' } });
    f.event('request.dispatch_attempted', 'model-2', { requestId: 'request-2' });
    f.event('request.completed', 'model-2', { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, responseText: 'secret response body' });
    for (const operationId of ['read-1', 'read-2']) {
      f.event('tool.requested', operationId, { toolName: 'read_material', arguments: { materialId: 'missing-material', contentVersionId: 'version-1', offset: 0 } });
      f.event('tool.completed', operationId, { result: { ok: true, toolName: 'read_material', result: { materialId: 'missing-material', content: 'secret material body' } } });
    }
    f.event('tool.requested', 'decision', { toolName: 'director_decide', arguments: { stage: 'outline', action: 'dispatch', reason: '安排提纲' } });
    f.event('tool.completed', 'decision', { result: { ok: true, toolName: 'director_decide', result: { collaboration: { actor: 'planner', stage: 'outline', status: 'dispatched', reason: '请策划形成提纲' } } } });
    const diagnostics = (await f.snapshot()).runRecords[0]?.diagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics.segments[0]?.modelRequests.length, 2);
    assert.equal(diagnostics.segments[0]?.modelRequests[0]?.errorCode, 'MODEL_OUTPUT_TRUNCATED');
    assert.deepEqual(diagnostics.segments[0]?.modelRequests[1]?.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    const reads = diagnostics.segments[0]?.toolGroups.find(group => group.toolName === 'read_material');
    assert.equal(reads?.count, 2);
    assert.equal(reads?.targets?.[0]?.id, 'missing-material');
    assert.equal(reads?.targets?.[0]?.count, 2);
    assert.match(JSON.stringify(diagnostics), /请策划形成提纲/u);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret (?:request|response|material) body/u);
  } finally { f.close(); }
});

test('run diagnostics distinguish material versions, attribute failed reads, identify artifact versions, and retain long director tasks', async () => {
  const f = await fixture();
  try {
    for (const [operationId, versionId, fail] of [['read-v1', 'version-1', false], ['read-v2', 'version-2', true]] as const) {
      f.event('tool.requested', operationId, { toolName: 'read_material', arguments: { materialId: 'material-1', contentVersionId: versionId } });
      f.event(fail ? 'tool.failed' : 'tool.completed', operationId, { result: fail
        ? { ok: false, toolName: 'read_material', error: { code: 'MATERIAL_READ_DENIED' } }
        : { ok: true, toolName: 'read_material', result: { content: 'private material body' } } });
    }
    f.event('tool.requested', 'artifact', { toolName: 'read_artifact_version', arguments: { versionId: 'artifact-version-1' } });
    f.event('tool.completed', 'artifact', { result: { ok: true, toolName: 'read_artifact_version', result: { content: 'private manuscript body' } } });
    const reason = `请策划梳理本次文章的结构。${'分清证据与观点，并明确每节目的。'.repeat(75)}`;
    f.event('tool.requested', 'director', { toolName: 'director_decide' });
    f.event('tool.completed', 'director', { result: { ok: true, toolName: 'director_decide', result: { collaboration: { actor: 'planner', stage: 'outline', status: 'dispatched', reason } } } });
    const groups = (await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.toolGroups;
    const reads = groups.find(group => group.toolName === 'read_material')!;
    assert.equal(reads.targets?.length, 2);
    assert.deepEqual(reads.targets?.map(target => [target.id, target.versionId, target.failed, target.errorCodes]), [
      ['material-1', 'version-1', 0, []], ['material-1', 'version-2', 1, ['MATERIAL_READ_DENIED']],
    ]);
    assert.equal(groups.find(group => group.toolName === 'read_artifact_version')?.targets?.[0]?.id, 'artifact-version-1');
    assert.equal((await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.decisions[0]?.reason, reason);
    assert.doesNotMatch(JSON.stringify(groups), /private (?:material|manuscript) body/u);
  } finally { f.close(); }
});

test('director diagnostics mark truncation and suppress credential-like task text', async () => {
  const f = await fixture();
  try {
    f.event('tool.requested', 'long-decision', { toolName: 'director_decide' });
    f.event('tool.completed', 'long-decision', { result: { ok: true, toolName: 'director_decide', result: {
      collaboration: { actor: 'planner', stage: 'outline', status: 'dispatched', reason: '任务'.repeat(1200) },
    } } });
    f.event('tool.requested', 'secret-decision', { toolName: 'director_decide' });
    f.event('tool.completed', 'secret-decision', { result: { ok: true, toolName: 'director_decide', result: {
      collaboration: { actor: 'planner', stage: 'draft', status: 'dispatched', reason: '请勿展示 api_key=top-secret' },
    } } });
    const decisions = (await f.snapshot()).runRecords[0]!.diagnostics!.segments[0]!.decisions;
    assert.match(decisions[0]?.reason ?? '', /（说明已截断）$/u);
    assert.ok((decisions[0]?.reason?.length ?? 0) <= 2010);
    assert.equal(decisions[1]?.reason, '任务说明含敏感信息，已隐藏');
    assert.doesNotMatch(JSON.stringify(decisions), /top-secret/u);
  } finally { f.close(); }
});

test('manuscript preview uses the locked publication title, not an old body heading', async () => {
  const f = await fixture();
  try {
    const commit = (kind: 'body' | 'title', content: string) => f.storage.commitArtifactVersion({ operationId: kind, projectId: 'project', expectedProjectRevision: f.storage.inspectProject('project')!.revision, kind, logicalKey: 'main', baseVersionId: null, content, reason: 'test', actor: { kind: 'user', id: 'test' } });
    assert.equal(commit('body', '# 旧工作标题\n\n正文不变。').ok, true);
    assert.equal(commit('title', '- 选择状态：已锁定\n- 最终标题：「功劳不是特权」\n').ok, true);
    const preview = (await f.snapshot()).previewDocument;
    assert.equal(preview.title, '功劳不是特权');
    assert.match(preview.body, /^# 功劳不是特权\n/u);
    assert.doesNotMatch(preview.body, /旧工作标题/u);
  } finally { f.close(); }
});

test('mixed invalid legacy title candidates are not silently renumbered for selection', async () => {
  const f = await fixture();
  try {
    const paragraph = '键盘被推到一边。同事路过看了一眼，没有停。';
    const body = f.storage.commitArtifactVersion({ operationId: 'body', projectId: 'project', expectedProjectRevision: f.storage.inspectProject('project')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: paragraph + '\n\n后续正文。', reason: 'legacy', actor: { kind: 'user', id: 'test' } });
    assert.equal(body.ok, true); if (!body.ok) return;
    f.storage.commitArtifactVersion({ operationId: 'legacy-candidates', projectId: 'project', expectedProjectRevision: f.storage.inspectProject('project')!.revision,
      kind: 'report', logicalKey: 'author-publication-candidates', baseVersionId: null, reason: 'legacy', actor: { kind: 'user', id: 'test' },
      content: JSON.stringify({ bodyVersionId: body.result.versionId, candidates: [paragraph, '功劳不是通行证'].map(title => ({ title, opening: null, distributionCopy: null, rationale: '旧候选' })) }) });
    f.storage.pauseRun({ projectId: 'project', runId: 'run', operationId: 'wait-title', reason: 'WRITING_INPUT_REQUIRED', payload: {
      kind: 'publication_selection', reason: '等待选择标题', questions: ['请选择'], nextStage: 'fact_check',
    } });
    const request = (await f.snapshot()).recoverableRuns.find(run => run.runId === 'run')?.inputRequest;
    assert.equal(request?.kind, 'publication_selection');
    assert.equal((await f.snapshot()).runRecords.find(run => run.id === 'run')?.waitingFor, 'publication_selection');
    assert.deepEqual(request?.candidates, [], 'regenerate the invalid batch instead of presenting stored option 2 as displayed option 1');
  } finally { f.close(); }
});

test('author run history projects its own persisted reply, not the reply from another turn', async () => {
  const f = await fixture();
  try {
    f.event('tool.completed', 'reply', { result: { ok: true, toolName: 'respond_author', result: { reply: '你想用哪一个标题？', artifactVersionId: 'reply-report' } } });
    assert.equal((await f.snapshot()).runRecords.find(run => run.id === 'run')?.replyPreview, '你想用哪一个标题？');
  } finally { f.close(); }
});

test('director decisions and outline content are visible in the conversation without opening history', async () => {
  const f = await fixture();
  try {
    f.event('tool.completed', 'decision', { result: { ok: true, toolName: 'director_decide', result: { collaboration: { actor: 'planner', stage: 'outline', decisionId: 'decision', status: 'dispatched', inputVersionIds: [], reason: '材料充分，先请策划形成提纲供你确认。' } } } });
    const committed = f.storage.commitArtifactVersion({ operationId: 'outline', projectId: 'project', expectedProjectRevision: f.storage.inspectProject('project')!.revision, kind: 'outline', logicalKey: 'main', baseVersionId: null, content: '# 本次提纲\n\n1. 为什么\n2. 怎么做', reason: '提纲', requestSnapshotId: null, actor: { kind: 'agent', id: 'planner', runId: 'run' } });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    f.event('tool.completed', 'outline', { result: { ok: true, toolName: 'submit_writing_stage', result: { stage: 'outline', artifactVersionId: committed.result.versionId } } });
    const text = JSON.stringify((await f.snapshot()).timelineBySession.session);
    assert.match(text, /写作导演/u);
    assert.match(text, /材料充分，先请策划形成提纲供你确认/u);
    assert.match(text, /本次提纲/u);
  } finally { f.close(); }
});

for (const legacy of [false, true]) test(`output truncation has an accurate persisted explanation (legacy=${legacy})`, async () => {
  const f = await fixture();
  try {
    const code = legacy ? 'MODEL_RESPONSE_INVALID' : 'MODEL_OUTPUT_TRUNCATED';
    f.event('request.dispatch_attempted', 'model', {});
    f.event('request.failed', 'model', { error: { code, message: '模型在工具参数完成前达到输出上限' } });
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'fail', status: 'failed', stopReason: code, payload: { code } });
    const snapshot = await f.snapshot();
    const text = JSON.stringify(snapshot.timelineBySession.session);
    assert.match(text, /输出.*上限/u);
    assert.doesNotMatch(text, /格式校验|账户额度不足/u);
    assert.equal(snapshot.runRecords[0]?.stopReason, 'MODEL_OUTPUT_TRUNCATED');
  } finally { f.close(); }
});

test('bounded output recovery remains pending and visible instead of announcing terminal failure', async () => {
  const f = await fixture();
  try {
    f.event('request.dispatch_attempted', 'first', {});
    f.event('request.failed', 'first', { error: { code: 'MODEL_OUTPUT_TRUNCATED' }, recovery: { kind: 'output_truncation', attempt: 1 } });
    let row = (await f.snapshot()).timelineBySession.session.find(item => item.kind === 'tool' && item.label === '写作模型');
    assert.ok(row?.kind === 'tool'); assert.equal(row.state, 'pending'); assert.match(row.detail, /重新生成/u);
    f.event('request.dispatch_attempted', 'second', { outputRecoveryAttempt: 1 });
    row = (await f.snapshot()).timelineBySession.session.find(item => item.kind === 'tool' && item.label === '写作模型');
    assert.ok(row?.kind === 'tool'); assert.equal(row.state, 'pending'); assert.match(row.detail, /重新生成/u);
  } finally { f.close(); }
});

test('rework clears downstream stage completion instead of retaining a misleading checkmark', async () => {
  const f = await fixture();
  try {
    f.event('tool.requested', 'outline', { toolName: 'submit_writing_stage', arguments: { stage: 'outline' } });
    f.event('tool.completed', 'outline', { result: { ok: true, toolName: 'submit_writing_stage', result: { stage: 'outline' } } });
    f.event('tool.completed', 'rework', { result: { ok: true, toolName: 'director_decide', result: { collaboration: { actor: 'planner', stage: 'outline', decisionId: 'rework', status: 'rework', reason: '按用户新方向重做提纲', inputVersionIds: [], invalidatedStages: ['outline', 'draft', 'review_editor', 'review_reader', 'central_revision', 'language_review', 'fact_check'] } } } });
    const snapshot = await f.snapshot();
    assert.notEqual(snapshot.runRecords[0]?.stages.find(stage => stage.id === 'outline')?.status, 'completed');
  } finally { f.close(); }
});

test('historical completed runs without a passed gate never announce complete delivery', async () => {
  const f = await fixture();
  try {
    const body = f.storage.commitArtifactVersion({ operationId: 'body', projectId: 'project', expectedProjectRevision: f.storage.inspectProject('project')!.revision, kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 工作稿\n\n内容待核查。', reason: '测试旧运行', requestSnapshotId: null, actor: { kind: 'agent', id: 'writer', runId: 'run' } });
    assert.equal(body.ok, true);
    if (!body.ok) return;
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'finish', status: 'completed', stopReason: null, payload: { artifactVersionId: body.result.versionId } });
    const text = JSON.stringify((await f.snapshot()).timelineBySession.session);
    assert.doesNotMatch(text, /完整(?:写作)?流程已完成/u);
    assert.match(text, /尚未.*交付/u);
  } finally { f.close(); }
});

test('a persisted blocked fact check is not a successfully completed stage', async () => {
  const f = await fixture();
  try {
    f.event('tool.requested', 'fact', { toolName: 'submit_fact_check', arguments: {} });
    f.event('tool.completed', 'fact', { result: { ok: true, toolName: 'submit_fact_check', result: { status: 'blocked', unresolvedClaims: [{ claimText: '无依据的数字', recommendedAction: '请提供出处' }] } } });
    f.storage.finishRun({ projectId: 'project', runId: 'run', operationId: 'wait', status: 'waiting_user', stopReason: 'WRITING_INPUT_REQUIRED' });
    const snapshot = await f.snapshot();
    assert.equal(snapshot.runRecords[0]?.stages.find(stage => stage.id === 'fact_check')?.status, 'failed');
    assert.match(snapshot.runRecords[0]?.stages.find(stage => stage.id === 'fact_check')?.detail ?? '', /待处理/u);
    const factRow = snapshot.timelineBySession.session.find(item => item.kind === 'tool' && item.label === '事实核查');
    assert.ok(factRow?.kind === 'tool');
    assert.equal(factRow.state, 'failure');
    assert.match(factRow.detail, /待处理/u);
  } finally { f.close(); }
});

test('explicit new conversation selection survives refresh without resuming the old session', async () => {
  const f = await fixture();
  try {
    await f.bridge.selectProject('project');
    assert.equal(f.bridge.getSnapshot().selectedSessionId, '');
    await f.bridge.refresh();
    assert.equal(f.bridge.getSnapshot().selectedSessionId, '');
  } finally { f.close(); }
});
