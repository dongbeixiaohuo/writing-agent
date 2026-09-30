// Read only the reported project; recreate its paused title discussion elsewhere.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import type { ModelProvider } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';
import { getPublicationCandidates, isUsablePublicationTitle } from '../../packages/application/src/publication-choice.js';

const [sourcePath, sourceRunId, flag] = process.argv.slice(2);
assert.ok(sourcePath && sourceRunId && flag === '--allow-real-model');
const db = new DatabaseSync(sourcePath, { readOnly: true });
let source: any;
try {
  const run = db.prepare('SELECT project_id,status FROM runs WHERE id=?').get(sourceRunId)!;
  assert.equal(run.status, 'waiting_user');
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(run.project_id!)!;
  const brief = JSON.parse(String(db.prepare('SELECT brief_json FROM writing_brief_versions WHERE id=?').get(project.current_brief_version_id!)!.brief_json));
  const body = db.prepare('SELECT content FROM artifact_versions WHERE id=?').get(project.latest_body_version_id!)!;
  const oldCandidates = JSON.parse(String(db.prepare("SELECT content FROM artifact_versions WHERE project_id=? AND logical_key='author-publication-candidates' ORDER BY created_event_seq DESC LIMIT 1").get(project.id!)!.content));
  const wait = JSON.parse(String(db.prepare("SELECT payload_json FROM events WHERE run_id=? AND type='run.waiting_user' ORDER BY project_seq DESC LIMIT 1").get(sourceRunId)!.payload_json));
  source = { project, brief, body: body.content, oldCandidates, wait,
    materials: db.prepare('SELECT * FROM materials WHERE project_id=?').all(project.id!).filter(m => brief.materialIds.includes(m.id)) };
} finally { db.close(); }
const parent = resolve('output/rc15-title-replay'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'real-'));
const report: Record<string, any> = { sourceRunId, originalProjectWrites: 0, realModelCalls: 0, requests: [],
  scope: 'title discussion and candidate generation only; no title selection, body change or fact-check', sourceBodyHash: createHash('sha256').update(source.body).digest('hex') };
const saveReport = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
const profile = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent', 'provider.json'))!;
assert.equal(profile.model, 'MiniMax-M3');
const live = createConfiguredProvider(profile, createDefaultCredentialBroker());
const counted: ModelProvider = { id: live.id, adapterVersion: live.adapterVersion, capabilities: live.capabilities,
  capabilitiesFor: model => live.capabilitiesFor(model), snapshotRequest: request => live.snapshotRequest(request),
  async *stream(request) {
    assert.ok(report.realModelCalls < 8, 'Bounded 8-request title test limit reached');
    report.realModelCalls++;
    report.requests.push({ requestId: request.requestId, actor: request.messages[0]?.content.match(/ACTOR=([^\n]+)/u)?.[1] });
    saveReport(); yield* live.stream(request);
  } };
const storage = openWorkspaceStorage({ workspacePath: join(root, 'workspace') });
const service = new WritingApplicationService({ storage, provider: counted });
let bridge: ReturnType<typeof createApplicationBridge> | undefined;
try {
  const projectId = source.project.id;
  const actor = { kind: 'user' as const, id: 'isolated-title-replay' };
  storage.createProject({ projectId, operationId: 'project', name: 'rc15 独立标题交流验证', mode: source.project.mode, actor });
  for (const material of source.materials) {
    const result = service.importMaterial({ operationId: `import-${material.id}`, projectId, actor,
      expectedProjectRevision: storage.inspectProject(projectId)!.revision, materialId: material.id,
      displayName: material.display_name, sourceKind: material.source_kind, sourceReference: material.source_reference,
      role: material.role, trustLabel: material.trust_label, permissionScope: material.permission_scope, content: material.content });
    assert.equal(result.ok, true);
  }
  assert.equal(storage.saveWritingBrief({ projectId, operationId: 'brief', actor, expectedProjectRevision: storage.inspectProject(projectId)!.revision, baseVersionId: null, brief: source.brief }).ok, true);
  assert.equal(storage.commitArtifactVersion({ projectId, operationId: 'body', actor, expectedProjectRevision: storage.inspectProject(projectId)!.revision,
    kind: 'body', logicalKey: 'main', baseVersionId: null, content: source.body, reason: 'isolated source body' }).ok, true);
  const bodyId = storage.inspectProject(projectId)!.latestBodyVersionId!;
  // Preserve the historical invalid candidate through the storage seam, not the fixed creation API.
  assert.equal(storage.commitArtifactVersion({ projectId, operationId: 'legacy-candidate', actor, expectedProjectRevision: storage.inspectProject(projectId)!.revision,
    kind: 'report', logicalKey: 'author-publication-candidates', baseVersionId: null,
    content: JSON.stringify({ ...source.oldCandidates, bodyVersionId: bodyId }), reason: 'historical invalid title fixture' }).ok, true);
  storage.createSession({ projectId, sessionId: 'conversation', purpose: 'writing-pack:draft' });
  storage.startRun({ projectId, sessionId: 'conversation', runId: 'waiting-title', purpose: 'writing-pack:draft', planVersion: 'test', expectedBodyVersionId: bodyId });
  storage.pauseRun({ projectId, runId: 'waiting-title', operationId: 'pause', reason: 'WRITING_INPUT_REQUIRED', payload: source.wait });
  bridge = createApplicationBridge({ service, workspaceId: 'rc15-title', initialProjectId: projectId,
    model: { model: profile.model, parameters: { temperature: 0 }, providerLabel: 'MiniMax', credentialReference: 'existing secure broker' }, pollIntervalMs: 50 });
  await bridge.selectSession(projectId, 'conversation');
  await bridge.resumeRun('waiting-title', 'resume', { operationId: 'feedback', feedback: '这不像标题，是正文开场。请重新拟三个简洁、能吸引人的标题，并说明区别；只讨论标题，正文不要改，不要替我选择。' });
  const deadline = Date.now() + 180_000;
  let turn;
  do {
    turn = storage.listRuns(projectId).find(run => run.id !== 'waiting-title');
    if (turn && !['running', 'queued'].includes(turn.status)) break;
    assert.ok(Date.now() < deadline, 'Timed out waiting for bounded title turn');
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  report.run = turn; report.candidates = getPublicationCandidates(storage, projectId);
  report.failures = storage.listRunEvents(turn!.id).filter(event => ['request.failed', 'tool.failed'].includes(event.type));
  report.bodyUnchanged = storage.inspectProject(projectId)!.latestBodyVersionId === bodyId;
  report.titleNotSelected = storage.inspectProject(projectId)!.currentTitleVersionId === null;
  report.workflowStillWaiting = storage.getRun('waiting-title')!.status === 'waiting_user';
  report.replies = storage.listRunEvents(turn!.id).flatMap(event => {
    const result = (event.payload.result as any)?.result; return event.type === 'tool.completed' && typeof result?.reply === 'string' ? [result.reply] : [];
  });
  assert.equal(turn!.status, 'completed');
  assert.equal(report.candidates.candidates.length, 3);
  assert.ok(report.candidates.candidates.every((c: any) => isUsablePublicationTitle(c.title, source.body)));
  assert.ok(report.requests.some((r: any) => r.actor === 'title'));
  assert.ok(report.bodyUnchanged && report.titleNotSelected && report.workflowStillWaiting);
  assert.equal(report.failures.length, 0);
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  bridge?.dispose(); storage.close(); report.checkedAt = new Date().toISOString(); saveReport();
  console.log(JSON.stringify({ outcome: report.outcome, realModelCalls: report.realModelCalls, evidence: join(root, 'result.json'), error: report.error }));
}
