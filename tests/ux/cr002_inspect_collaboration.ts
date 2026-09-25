import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Read-only synthetic workspace evidence. Never accepts a production database path.
const [testId, reportName] = process.argv.slice(2);
assert.match(testId ?? '', /^cr002-[a-z0-9-]{8,48}$/u);
assert.match(reportName ?? '', /^complete[a-z-]*\.json$/u);
const evidenceRoot = resolve('output', testId!);
const report = JSON.parse(readFileSync(join(evidenceRoot, reportName!), 'utf8'));
const database = new DatabaseSync(join(tmpdir(), `writing-agent-desktop-test-${testId}`, 'workspace/.writing-agent/workspace.sqlite3'), { readOnly: true });
try {
  const rows = database.prepare('SELECT id, request_json FROM request_snapshots WHERE run_id=? ORDER BY created_at, rowid').all(report.runId);
  const requests = rows.flatMap(row => {
    const request = JSON.parse(String(row.request_json));
    const user = request.messages.find((message: {role: string}) => message.role === 'user')?.content ?? '';
    const marker = 'COLLABORATION_STATE=';
    const offset = user.indexOf(marker);
    if (offset < 0) return [];
    const state = JSON.parse(user.slice(offset + marker.length));
    return [{ snapshotId: row.id, actor: state.actor, stage: state.stage,
      inputVersionIds: state.inputVersionIds, taskInstruction: state.taskInstruction,
      expectedArtifact: state.expectedArtifact,
      tools: request.tools.map((tool: {name: string}) => tool.name),
      bodyIds: state.artifacts.filter((artifact: {kind: string}) => artifact.kind === 'body').map((artifact: {id: string}) => artifact.id),
      peerReviewArtifactCount: state.artifacts.filter((artifact: {kind: string}) => artifact.kind === 'review').length,
    }];
  });
  const reviews = requests.filter(request => String(request.actor).startsWith('review_'));
  assert.ok(reviews.length >= 3);
  assert.equal(new Set(reviews.map(request => request.bodyIds[0])).size, 1, 'All initial reviewers bind the same primary draft');
  assert.ok(reviews.every(request => request.peerReviewArtifactCount === 0), 'No peer review leakage');
  assert.ok(reviews.every(request => request.taskInstruction && request.expectedArtifact?.mayCommitBody === false));
  const lastFact = requests.findLast(request => request.actor === 'fact_check');
  const reviewScope = reviews.every(request => request.bodyIds.length === 1)
    ? 'sole_shared_draft' : 'historical_pre_fix_reviews_also_received_legacy_baseline';
  if (report.outcome === 'passed') assert.deepEqual(lastFact?.bodyIds, [report.preview.id], 'Final fact request binds only the current article');
  const evidence = { checkedAt: new Date().toISOString(), runId: report.runId,
    integrity: database.prepare('PRAGMA integrity_check').get(),
    sharedPrimaryDraftAndNoPeerLeak: 'passed', reviewScope,
    currentFactScope: lastFact?.bodyIds.length === 1 && lastFact.bodyIds[0] === report.preview.id ? 'passed' : 'not_yet_passed',
    reviewRoles: [...new Set(reviews.map(request => request.actor))], requests };
  writeFileSync(join(evidenceRoot, 'persisted-collaboration.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ runId: report.runId, snapshots: requests.length, reviewScope, currentFactScope: evidence.currentFactScope, reviewRoles: evidence.reviewRoles }));
} finally { database.close(); }
