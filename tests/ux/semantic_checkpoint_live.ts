/** Replay one historical review confirmation in an online SQLite backup only. */
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
const [source, runId] = process.argv.slice(2);
assert.ok(source && runId, 'Pass source SQLite path and waiting review run ID');
const root = mkdtempSync(join(tmpdir(), 'wa-semantic-checkpoint-'));
mkdirSync(join(root, '.writing-agent'));
const original = new DatabaseSync(source, { readOnly: true });
const before = original.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=(SELECT project_id FROM runs WHERE id=?)').get(runId);
await backup(original, join(root, '.writing-agent/workspace.sqlite3')); original.close();
const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent/provider.json'));
const entry = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model)) ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(entry);
const provider = createConfiguredProvider(entry.config, createDefaultCredentialBroker());
const requests: { actor: string; ms: number; chars: number }[] = [];
class LimitedProvider extends ModelProviderBase {
  constructor() { super(provider.id, provider.adapterVersion, provider.capabilitiesFor(entry!.config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const workflow = request.messages.find(m => m.content.includes('COLLABORATION_STATE='));
    const state = workflow ? JSON.parse(workflow.content.split('COLLABORATION_STATE=')[1]!) : null;
    const actor = state?.actor ?? 'author-intent';
    if ((state && (!['director', 'central_revision'].includes(actor) || state.nextStage !== 'central_revision')) || requests.length >= 16) {
      yield { type: 'error', error: { code: 'REPLAY_BOUNDARY', message: 'Isolated verification stops before the next expert', retryable: false } }; return;
    }
    const row = { actor, ms: 0, chars: 0 }; requests.push(row); const start = Date.now();
    for await (const event of provider.stream(request)) {
      if (event.type === 'text_delta') row.chars += event.delta.length;
      row.ms = Date.now() - start;
      if (event.type !== 'tool_call_complete') yield event;
    }
    row.ms = Date.now() - start; console.log(JSON.stringify(row));
  }
}
const storage = openWorkspaceStorage({ workspacePath: root });
const run = storage.getRun(runId)!; assert.equal(run.stopReason, 'CO_CREATION_CHECKPOINT');
const project = storage.inspectProject(run.projectId)!;
const reviewIds = () => ['review_editor', 'review_publish', 'review_reader'].flatMap(stage => storage.listArtifactVersions(project.id, 'review', `${stage}:${runId}`).map(v => v.id));
const reviewsBefore = reviewIds();
const app = new WritingApplicationService({ storage, provider: new LimitedProvider() });
let report: any = { status: 'FAIL', root, model: entry.config.model, requests, originalWrites: 0 };
try {
  const decision = await app.startAuthorTurn({ projectId: project.id, sessionId: run.sessionId, userInstruction: '认同', model: entry.config.model, parameters: {},
    budget: { maxModelRequests: 3, maxToolCalls: 3, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } }).result;
  assert.equal(decision.ok, true, JSON.stringify(decision));
  const handoff = JSON.parse(storage.listArtifactVersions(project.id, 'report', `author-turn:${decision.runId}`).at(-1)!.content);
  assert.equal(handoff.requestedAction, 'resume_checkpoint');
  const result = await app.resumeDraft({ projectId: project.id, runId, operationId: 'semantic-live-resume', decision: 'resume', userInstruction: '认同',
    intentReceiptId: handoff.intentReceiptId, expectedProjectRevision: storage.inspectProject(project.id)!.revision,
    expectedBriefVersionId: project.currentBriefVersionId!, model: entry.config.model, parameters: {},
    budget: { maxModelRequests: 16, maxToolCalls: 24, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } }).result;
  const updated = storage.inspectProject(project.id)!;
  const saved = storage.listRunEvents(runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.result?.stage === 'central_revision');
  assert.ok(saved.length > 0, 'The real revision must be committed, not merely announced');
  assert.notEqual(updated.latestBodyVersionId, project.latestBodyVersionId);
  assert.deepEqual(reviewIds(), reviewsBefore, 'Do not regenerate old reviews');
  const check = new DatabaseSync(source, { readOnly: true });
  const after = check.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=?').get(project.id); check.close();
  assert.deepEqual(after, before, 'Original project unchanged');
  report = { ...report, status: 'PASS', revisionSaved: true, oldReviewsUnchanged: true, runIdUnchanged: true, subsequentExpertsNotCalled: true,
    stopReason: storage.getRun(runId)?.stopReason, resultOk: result.ok };
} finally {
  storage.close(); mkdirSync(resolve('output/semantic-confirmation'), { recursive: true });
  writeFileSync(resolve('output/semantic-confirmation/checkpoint-live.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
