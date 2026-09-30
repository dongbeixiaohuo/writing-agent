/** Real-provider recovery of a legacy failure, exclusively in an online backup. */
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { PUBLICATION_SELECTION_WAIT_REASON, getPublicationCandidates } from '../../packages/application/src/publication-choice.js';

const [source, runId] = process.argv.slice(2);
assert.ok(source && runId, 'Pass source SQLite path and legacy failed run ID');
const root = mkdtempSync(join(tmpdir(), 'wa-rc55-recovery-'));
mkdirSync(join(root, '.writing-agent'));
const original = new DatabaseSync(source, { readOnly: true });
const before = original.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=(SELECT project_id FROM runs WHERE id=?)').get(runId);
await backup(original, join(root, '.writing-agent/workspace.sqlite3')); original.close();
const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const entry = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model)) ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(entry);
const provider = createConfiguredProvider(entry.config, createDefaultCredentialBroker());
const requests: { actor: string; ms: number; chars: number }[] = [];
let phase = 'recover';
class LimitedProvider extends ModelProviderBase {
  constructor() { super(provider.id, provider.adapterVersion, provider.capabilitiesFor(entry!.config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const workflow = request.messages.find(m => m.content.includes('COLLABORATION_STATE='));
    const state = workflow ? JSON.parse(workflow.content.split('COLLABORATION_STATE=')[1]!) : null;
    const actor = state?.actor ?? 'author-intent';
    assert.ok(!state || ['director', ...(phase === 'approved' ? ['title'] : [])].includes(actor), `Unexpected expert before approval: ${actor}`);
    assert.ok(requests.length < 16, 'Replay request limit');
    const row = { actor, ms: 0, chars: 0 }; requests.push(row); const start = Date.now();
    for await (const event of provider.stream(request)) {
      if (event.type === 'text_delta') row.chars += event.delta.length;
      row.ms = Date.now() - start;
      if (event.type !== 'tool_call_complete') yield event;
    }
    console.log(JSON.stringify({ phase, ...row }));
  }
}
const storage = openWorkspaceStorage({ workspacePath: root });
const run = storage.getRun(runId)!; assert.equal(run.stopReason, 'TOOL_FAILURE_LOOP');
const project = storage.inspectProject(run.projectId)!;
const bodyIds = () => storage.listArtifactVersions(project.id, 'body', 'main').map(v => v.id);
const bodiesBefore = bodyIds();
const eventSeq = storage.listRunEvents(runId).at(-1)!.projectSeq;
const app = new WritingApplicationService({ storage, provider: new LimitedProvider() });
const model = { model: entry.config.model, parameters: {}, budget: { maxModelRequests: 12, maxToolCalls: 20, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } };
let report: any = { status: 'FAIL', root, model: entry.config.model, requests, originalWrites: 0 };
try {
  await app.resumeDraft({ ...model, projectId: project.id, runId, operationId: 'rc55-recover', decision: 'resume',
    expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId! }).result;
  assert.equal(storage.getRun(runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
  assert.equal(storage.listRunEvents(runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'language_review');
  assert.deepEqual(bodyIds(), bodiesBefore);
  phase = 'approved';
  const decision = await app.startAuthorTurn({ ...model, projectId: project.id, sessionId: run.sessionId, userInstruction: '这一版可以，往下继续' }).result;
  assert.equal(decision.ok, true, JSON.stringify(decision));
  const handoff = JSON.parse(storage.listArtifactVersions(project.id, 'report', `author-turn:${decision.runId}`).at(-1)!.content);
  assert.equal(handoff.requestedAction, 'resume_checkpoint');
  await app.resumeDraft({ ...model, projectId: project.id, runId, operationId: 'rc55-approved', decision: 'resume', userInstruction: '这一版可以，往下继续',
    intentReceiptId: handoff.intentReceiptId, expectedProjectRevision: storage.inspectProject(project.id)!.revision,
    expectedBriefVersionId: project.currentBriefVersionId! }).result;
  const lastWait = storage.listRunEvents(runId).findLast(e => e.type === 'run.waiting_user');
  assert.equal(lastWait?.payload.stopReason, 'WRITING_INPUT_REQUIRED');
  assert.equal(lastWait?.payload.reason, PUBLICATION_SELECTION_WAIT_REASON);
  assert.ok(getPublicationCandidates(storage, project.id), 'Title candidates must be saved for author selection');
  assert.deepEqual(bodyIds(), bodiesBefore, 'Finished experts must not regenerate');
  const failures = storage.listRunEvents(runId).filter(e => e.projectSeq > eventSeq && e.type === 'tool.failed');
  assert.equal(failures.length, 0, JSON.stringify(failures.map(e => e.payload)));
  const check = new DatabaseSync(source, { readOnly: true });
  const after = check.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=?').get(project.id); check.close();
  assert.deepEqual(after, before, 'Original project unchanged');
  report = { ...report, status: 'PASS', recoveredCheckpoint: 'language_review', nextWait: 'publication_selection', savedBodiesUnchanged: true, newToolFailures: 0 };
} finally {
  storage.close(); mkdirSync(resolve('output/rc55-recovery'), { recursive: true });
  writeFileSync(resolve('output/rc55-recovery/live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
