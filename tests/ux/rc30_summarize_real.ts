import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const [source, runId, ...copies] = process.argv.slice(2);
assert.ok(source && runId && copies.length);
const original = new DatabaseSync(source, { readOnly: true });
const run = original.prepare('SELECT * FROM runs WHERE id=?').get(runId)!;
assert.equal(run.status, 'budget_exhausted', 'Original incident must remain untouched');
const baseline = JSON.parse(String(run.usage_json));
const versions = (db: DatabaseSync) => db.prepare('SELECT id, kind, content_hash FROM artifact_versions WHERE project_id=? AND kind IN (?,?) ORDER BY id').all(run.project_id, 'body', 'title');
const originalVersions = versions(original);
const outcomes = copies.map(root => {
  const db = new DatabaseSync(join(root, 'workspace/.writing-agent/workspace.sqlite3'), { readOnly: true });
  const current = db.prepare('SELECT * FROM runs WHERE id=?').get(runId)!;
  const rows = db.prepare('SELECT type, payload_json FROM events WHERE run_id=? ORDER BY project_seq').all(runId);
  const events = rows.map(r => ({ type: r.type, payload: JSON.parse(String(r.payload_json)) }));
  const boundary = events.findLastIndex(e => e.type === 'run.resumed');
  const recent = events.slice(boundary);
  const requests = recent.filter(e => e.type === 'request.dispatch_attempted').length;
  const reported = recent.filter(e => ['request.completed', 'request.failed', 'request.outcome_unknown'].includes(String(e.type))).map(e => e.payload.usage).filter(Boolean);
  const tools = recent.filter(e => e.type === 'tool.requested').map(e => ({ actor: e.payload.actor, tool: e.payload.toolName }));
  const fact = recent.findLast(e => e.type === 'tool.completed' && e.payload.result?.toolName === 'submit_fact_check');
  const assessment = fact?.payload.result?.result;
  const result = { root, runStatus: current.status, stopReason: current.stop_reason,
    actualRequests: requests, reportedTokens: reported.reduce((total, usage) => total + (usage.totalTokens ?? 0), 0),
    usageReports: reported.length, unreportedRequests: requests - reported.length,
    bodyAndTitleVersionsUnchanged: JSON.stringify(versions(db)) === JSON.stringify(originalVersions),
    newExpertAssignments: tools.filter(t => t.tool === 'director_decide').length,
    tools, factStatus: assessment?.status ?? null, blockers: assessment?.unresolvedClaims ?? [],
    errors: recent.filter(e => e.type === 'request.failed' || e.type === 'tool.failed').map(e => ({ type: e.type, code: e.payload.error?.code ?? e.payload.result?.error?.code, feedback: e.payload.toolSchemaFeedback })),
  };
  db.close(); return result;
});
original.close();
assert.ok(outcomes.at(-1)?.bodyAndTitleVersionsUnchanged);
assert.equal(outcomes.at(-1)?.newExpertAssignments, 0);
assert.ok(['passed', 'blocked'].includes(outcomes.at(-1)?.factStatus));
const report = { originalUnchanged: true, originalUsage: baseline, outcomes,
  totalRequests: outcomes.reduce((n, r) => n + r.actualRequests, 0), reportedTokens: outcomes.reduce((n, r) => n + r.reportedTokens, 0) };
writeFileSync(resolve('output/rc30-fact-resume/real-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ originalUnchanged: true, totalRequests: report.totalRequests, reportedTokens: report.reportedTokens, outcomes: outcomes.map(({ root, runStatus, actualRequests, factStatus, bodyAndTitleVersionsUnchanged, newExpertAssignments }) => ({ root, runStatus, actualRequests, factStatus, bodyAndTitleVersionsUnchanged, newExpertAssignments })) }, null, 2));
