// Offline verification of an isolated live replay. Never opens the user's workspace.
// node --import tsx tests/ux/verify-intake-transition-recording.ts <replay-report.json>
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const report = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
assert.deepEqual(report.turns.map((t: any) => t.phase), ['proposal', 'confirmed']);
const db = new DatabaseSync(join(report.root, '.writing-agent/workspace.sqlite3'), { readOnly: true });
try {
  const events = db.prepare('SELECT type,payload_json FROM events WHERE run_id=? ORDER BY project_seq')
    .all(report.writing.id).map(row => ({ type: row.type, payload: JSON.parse(String(row.payload_json)) }));
  const saved = events.filter(e => e.type === 'tool.completed' && e.payload.result?.ok === true &&
    e.payload.result?.toolName === 'submit_writing_stage').map(e => e.payload.result.result);
  assert.deepEqual(saved.map(s => s.stage), ['research', 'outline']);
  assert.ok(saved.every(s => typeof s.artifactVersionId === 'string' && s.artifactVersionId.length > 0));
  const checkpoint = events.findLast(e => e.type === 'run.waiting_user')?.payload;
  assert.equal(checkpoint?.stopReason, 'CO_CREATION_CHECKPOINT');
  assert.equal(checkpoint.stage, 'outline');
  assert.equal(checkpoint.nextStage, 'draft');
  assert.equal(report.writing.status, 'waiting_user');
  assert.equal(events.filter(e => e.type === 'request.failed').length, 0);
  const recoveredToolErrors = events.filter(e => e.type === 'tool.failed').map(e => e.payload.result?.error?.code);
  console.log(JSON.stringify({ ok: true, mode: 'offline verification of real-model recording',
    phases: report.turns.map((t: any) => t.phase), savedStages: saved.map(s => s.stage),
    checkpoint, recoveredToolErrors, liveCalls: report.liveCalls, model: report.model,
    note: 'Original live process used the old commit_stage assertion; this verifies submit_writing_stage events.' }, null, 2));
} finally { db.close(); }
