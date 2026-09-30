// Exact source run is opened read-only. Only its project's materials/brief are
// recreated in a new retained workspace; never open production via StoragePort.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const [sourcePath, sourceRunId, mode = '--offline'] = process.argv.slice(2);
assert.ok(sourcePath && sourceRunId);
assert.ok(['--offline', '--allow-real-model'].includes(mode));
const source = new DatabaseSync(sourcePath, { readOnly: true });
let project: any; let brief: any; let materials: any[]; let snapshots: any[]; let events: any[];
try {
  const run = source.prepare('SELECT * FROM runs WHERE id=?').get(sourceRunId)!;
  assert.equal(run.status, 'failed'); assert.equal(run.stop_reason, 'MODEL_RESPONSE_INVALID');
  project = source.prepare('SELECT id,mode FROM projects WHERE id=?').get(run.project_id!);
  brief = JSON.parse(String(source.prepare('SELECT brief_json FROM writing_brief_versions WHERE project_id=? AND created_at<=? ORDER BY created_event_seq DESC LIMIT 1').get(run.project_id!, run.started_at!)!.brief_json));
  materials = source.prepare('SELECT * FROM materials WHERE project_id=?').all(run.project_id!).filter(row => brief.materialIds.includes(row.id));
  snapshots = source.prepare('SELECT request_id,request_json,normalized_payload_json FROM request_snapshots WHERE run_id=? ORDER BY created_at').all(sourceRunId);
  events = source.prepare('SELECT type,payload_json FROM events WHERE run_id=? ORDER BY project_seq').all(sourceRunId).map(row => ({ type: row.type, payload: JSON.parse(String(row.payload_json)) }));
  assert.equal(snapshots.length, 4);
  assert.equal(events.findLast(event => event.type === 'request.failed').payload.error.message, '模型在工具参数完成前达到输出上限');
} finally { source.close(); }
const parent = resolve('output/rc14-research-replay'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, mode === '--offline' ? 'offline-' : 'real-'));
const storage = openWorkspaceStorage({ workspacePath: join(root, 'workspace') });
const report: Record<string, any> = { mode, sourceRunId, originalProjectWrites: 0, realModelCalls: 0,
  sourceFailedOutputLimit: JSON.parse(snapshots!.at(-1).normalized_payload_json).max_tokens,
  sourceRequestHash: createHash('sha256').update(snapshots!.at(-1).request_json).digest('hex'),
  scope: 'research only; prior material reads/readiness/director calls replayed offline; no outline or body generation',
};
const profile = mode === '--allow-real-model' ? loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent', 'provider.json')) : null;
if (profile) assert.equal(profile.model, 'MiniMax-M3');
const live = profile ? createConfiguredProvider(profile, createDefaultCredentialBroker()) : null;
let prepared = 0; let researchCalls = 0;
const materialVersions = new Map<string, string>();
class ReplayProvider extends ModelProviderBase {
  constructor() { super(live?.id ?? 'offline-research', live?.adapterVersion ?? '1', live?.capabilities ?? { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
  override capabilitiesFor(model: string) { return live?.capabilitiesFor(model) ?? super.capabilitiesFor(model); }
  override snapshotRequest(request: ModelRequest) { return live?.snapshotRequest(request) ?? super.snapshotRequest(request); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    if (prepared < 3) {
      const id = snapshots![prepared++].request_id;
      const calls = events!.filter(event => event.type === 'tool.requested' && event.payload.requestId === id);
      assert.ok(calls.length);
      for (const [index, call] of calls.entries()) {
        const args = { ...call.payload.arguments };
        if (call.payload.toolName === 'read_material') args.contentVersionId = materialVersions.get(args.materialId);
        yield { type: 'tool_call_delta', index,
          id: `seed-${prepared}-${index}`, name: call.payload.toolName, argumentsDelta: JSON.stringify(args) };
      }
      yield { type: 'completed', finishReason: 'tool_calls' }; return;
    }
    const user = request.messages.find(message => message.role === 'user')!.content;
    const state = JSON.parse(user.split('\nCOLLABORATION_STATE=')[1]!);
    if (state.actor === 'director' && state.completedStages.includes('research')) {
      yield { type: 'tool_call_delta', index: 0, id: 'test-end', name: 'director_decide', argumentsDelta: JSON.stringify({
        action: 'ask', stage: null, reason: '本次研究专项验证已完成，测试在此暂停，不继续写正文。', questions: ['研究结果已保存，是否结束本次专项测试？'],
      }) };
      yield { type: 'completed', finishReason: 'tool_calls' }; return;
    }
    assert.equal(state.stage, 'research');
    researchCalls++;
    if (live) {
      assert.ok(report.realModelCalls < 2, 'Real model authorization exhausted');
      const snapshot = live.snapshotRequest(request);
      assert.equal((snapshot.normalizedPayload as any).max_tokens, 131072);
      report.realModelCalls++;
      report.requests ??= []; report.requests.push({ requestId: request.requestId, outputLimit: snapshot.outputTokenLimit });
      // Persist the authorization counter before the paid request is dispatched.
      writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
      for await (const event of live.stream(request)) {
        if (event.type === 'tool_call_complete') continue;
        if (event.type === 'text_delta') yield { type: 'text_delta', delta: event.delta };
        else if (event.type === 'tool_call_delta') yield { type: 'tool_call_delta', index: event.index, id: event.id, ...(event.name ? { name: event.name } : {}), argumentsDelta: event.argumentsDelta };
        else if (event.type === 'usage') { report.lastUsage = event.usage; yield { type: 'usage', usage: event.usage }; }
        else if (event.type === 'error') yield { type: 'error', error: event.error };
        else if (event.type === 'completed') yield { type: 'completed', finishReason: event.finishReason };
      }
    } else {
      // Simulate the observed finish reason, not an invented copy of discarded raw output.
      yield { type: 'tool_call_delta', index: 0, id: `research-${researchCalls}`, name: 'submit_writing_stage',
        argumentsDelta: researchCalls === 1 ? '{"stage":"research","content":"incomplete' : JSON.stringify({ stage: 'research', content: '{"claims":[],"notes":"离线研究样本：授权范围为解释分析与虚构示意，不把案例当作真实证据。"}' }) };
      yield { type: 'completed', finishReason: researchCalls === 1 ? 'max_tokens' : 'tool_calls' };
    }
  }
}
try {
  const app = new WritingApplicationService({ storage, provider: new ReplayProvider() });
  const actor = { kind: 'user' as const, id: 'isolated-replay' };
  app.createProject({ operationId: 'create', projectId: project!.id, name: 'rc14 独立研究验证', mode: project!.mode, actor });
  for (const material of materials!) {
    const imported = app.importMaterial({ operationId: `import-${material.id}`, projectId: project!.id,
      expectedProjectRevision: storage.inspectProject(project!.id)!.revision, actor,
      materialId: material.id, displayName: material.display_name, sourceKind: material.source_kind,
      sourceReference: material.source_reference, role: material.role, trustLabel: material.trust_label,
      permissionScope: material.permission_scope, content: material.content });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    if (imported.ok) materialVersions.set(material.id, imported.result.contentVersionId);
  }
  const saved = app.saveWritingBrief({ operationId: 'brief', projectId: project!.id,
    expectedProjectRevision: storage.inspectProject(project!.id)!.revision, baseVersionId: null, brief, actor });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const initial = storage.inspectProject(project!.id)!;
  const result = await app.runDraft({ projectId: project!.id, expectedProjectRevision: initial.revision,
    expectedBriefVersionId: initial.currentBriefVersionId!, model: profile?.model ?? 'offline', parameters: { temperature: 0, toolChoice: 'auto' },
    userInstruction: '按已确认方案开始。', budget: { maxModelRequests: 6, maxToolCalls: 20, maxRetriesPerRequest: 1, maxMajorRevisions: 0 } });
  report.run = result; report.status = storage.getRun(result.runId)?.status;
  const current = storage.inspectProject(project!.id)!;
  assert.ok(current.currentEvidenceVersionId, JSON.stringify(result));
  assert.equal(current.latestBodyVersionId, null);
  const evidence = storage.getArtifactVersion(current.currentEvidenceVersionId)!;
  assert.equal(typeof JSON.parse(evidence.content).notes, 'string');
  report.evidenceCharacters = evidence.content.length; report.evidenceHash = createHash('sha256').update(evidence.content).digest('hex');
  report.evidenceVersionId = evidence.id;
  report.failures = storage.listRunEvents(result.runId).filter(event => ['request.failed','tool.failed'].includes(event.type));
  assert.equal(report.status, 'waiting_user');
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed'; report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  storage.close(); report.checkedAt = new Date().toISOString(); report.researchAttempts = researchCalls;
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outcome: report.outcome, realModelCalls: report.realModelCalls, evidenceCharacters: report.evidenceCharacters, evidence: join(root, 'result.json'), failure: report.failure }));
}
