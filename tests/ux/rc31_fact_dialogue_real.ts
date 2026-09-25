// Authorized MiniMax validation. Never opens the original database for writing.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';

const [source, runId] = process.argv.slice(2);
assert.ok(source && runId);
const root = mkdtempSync(join(tmpdir(), 'writing-agent-rc31-real-'));
const workspace = join(root, 'workspace');
mkdirSync(join(workspace, '.writing-agent'), { recursive: true });
const original = new DatabaseSync(source, { readOnly: true });
const baseline = original.prepare('SELECT id, content_hash FROM artifact_versions ORDER BY id').all();
await backup(original, join(workspace, '.writing-agent/workspace.sqlite3'));
const out = resolve('output/rc31-dialogue'); mkdirSync(out, { recursive: true });
const host = new DesktopApplicationHost({ workspacePath: workspace, providerProfilePath: join(process.env.APPDATA!, 'Writing Agent/provider.json'), applicationVersion: '1.0.0-rc.31' });
try {
  const profile = await host.providerStatus();
  assert.equal(profile.model, 'MiniMax-M3'); assert.equal(profile.configured, true);
  const db = new DatabaseSync(join(workspace, '.writing-agent/workspace.sqlite3'), { readOnly: true });
  const run = db.prepare('SELECT project_id, session_id FROM runs WHERE id=?').get(runId)!;
  const startSeq = Number(db.prepare('SELECT MAX(project_seq) AS seq FROM events WHERE run_id=?').get(runId)!.seq);
  const bridge = host.bridge;
  await bridge.selectSession(String(run.project_id), String(run.session_id));
  console.log(JSON.stringify({ phase: 'isolated-start', root, runId }));
  await bridge.resumeRun(runId, 'resume', { operationId: 'rc31-discuss-metaphor', feedback: '请先核对这条核查意见：每个人都有一把属于自己的刀，纹理也只有自己看得最清。这是现代比喻，不是古籍原句。请按实际正文判断，不应让我给普通比喻补事实材料；真正的古籍引文仍要核实，不要自动放行，也不要改变我已确认的方向和标题。' });
  const deadline = Date.now() + 15 * 60_000; let last = ''; let replied = false;
  for (;;) {
    await bridge.refresh(); const snapshot = bridge.getSnapshot();
    const current = snapshot.runRecords.find(r => r.id === runId)!;
    const progress = JSON.stringify({ status: current.status, requests: current.modelRequests, fact: snapshot.factCheckWorkspace.status });
    if (progress !== last) { console.log(progress); last = progress; }
    if (!['running', 'queued', 'paused'].includes(current.status)) {
      const events = db.prepare('SELECT type,payload_json FROM events WHERE run_id=? AND project_seq>? ORDER BY project_seq').all(runId, startSeq).map(e => ({ type: e.type, payload: JSON.parse(String(e.payload_json)) }));
      if (!replied && current.stopReason === 'WRITING_INPUT_REQUIRED' && !events.some(e => e.type === 'tool.completed' && e.payload.result?.toolName === 'submit_fact_check')) {
        replied = true;
        await bridge.resumeRun(runId, 'resume', { operationId: 'rc31-keep-metaphor', feedback: '保留原句。这就是现代比喻，不是原典直译，不需要润色，也不要再让我选择改法。请独立核对当前正文里真正的事实和引文；不要因为可选润色停止交付，也不要自动放行真实的事实问题。' });
        continue;
      }
      const originalUnchanged = JSON.stringify(original.prepare('SELECT id, content_hash FROM artifact_versions ORDER BY id').all()) === JSON.stringify(baseline);
      const report = { root, runId, originalUnchanged, status: current.status, reason: current.stopReason, fact: snapshot.factCheckWorkspace, events, timeline: snapshot.timelineBySession[String(run.session_id)]?.slice(-8) };
      writeFileSync(join(out, 'real-result.json'), JSON.stringify(report, null, 2));
      assert.ok(originalUnchanged);
      assert.notEqual(current.status, 'budget_exhausted');
      assert.notEqual(current.status, 'failed');
      assert.ok(events.some(e => e.type === 'tool.completed' && e.payload.result?.toolName === 'submit_fact_check'), 'must actually reassess facts');
      console.log('ISOLATED_FACT_DIALOGUE_SAVED'); break;
    }
    if (Date.now() > deadline) { await bridge.cancelRun(runId); throw new Error('test deadline'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  db.close();
} finally { host.close(); original.close(); }
