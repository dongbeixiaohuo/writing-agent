// User-authorized MiniMax validation: only an isolated SQLite backup is modified.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';

const [source, runId] = process.argv.slice(2);
assert.ok(source && runId, 'Usage: script source.sqlite3 runId');
const root = mkdtempSync(join(tmpdir(), 'writing-agent-rc30-real-'));
const workspace = join(root, 'workspace');
mkdirSync(join(workspace, '.writing-agent'), { recursive: true });
const original = new DatabaseSync(source, { readOnly: true });
await backup(original, join(workspace, '.writing-agent/workspace.sqlite3'));
original.close();
const evidence = resolve('output/rc30-fact-resume'); mkdirSync(evidence, { recursive: true });
const host = new DesktopApplicationHost({ workspacePath: workspace, providerProfilePath: join(process.env.APPDATA!, 'Writing Agent/provider.json'), applicationVersion: '1.0.0-rc.30' });
const bridge = host.bridge;
try {
  const provider = await host.providerStatus();
  assert.equal(provider.model, 'MiniMax-M3'); assert.equal(provider.configured, true);
  const copy = new DatabaseSync(join(workspace, '.writing-agent/workspace.sqlite3'), { readOnly: true });
  const run = copy.prepare('SELECT project_id, session_id FROM runs WHERE id=?').get(runId) as { project_id: string; session_id: string };
  assert.ok(run);
  await bridge.selectSession(run.project_id, run.session_id);
  const before = bridge.getSnapshot();
  assert.ok(before.recoverableRuns.some(r => r.runId === runId && r.status === 'budget_exhausted'));
  const bodyBefore = JSON.stringify(before.previewDocument);
  console.log(JSON.stringify({ phase: 'isolated-start', root, runId }));
  await bridge.resumeRun(runId, 'resume', { operationId: 'rc30-real-recovery' });
  const deadline = Date.now() + 15 * 60_000; let last = '';
  for (;;) {
    await bridge.refresh(); const state = bridge.getSnapshot();
    const current = state.runRecords.find(r => r.id === runId)!;
    const progress = JSON.stringify({ status: current.status, calls: current.modelRequests, reason: current.stopReason, fact: state.factCheckWorkspace.status });
    if (progress !== last) { console.log(progress); last = progress; }
    if (!['running', 'queued', 'paused'].includes(current.status)) {
      const result = { runId, root, model: provider.model, status: current.status, reason: current.stopReason, requests: current.modelRequests, factStatus: state.factCheckWorkspace.status, bodyUnchanged: JSON.stringify(state.previewDocument) === bodyBefore, diagnostics: current.diagnostics };
      writeFileSync(join(evidence, 'real-result.json'), JSON.stringify(result, null, 2));
      assert.ok(['passed', 'blocked'].includes(state.factCheckWorkspace.status), 'Must save an actual assessment, not merely stop without error');
      assert.notEqual(current.stopReason, 'BUDGET_EXHAUSTED');
      console.log('FACT_ASSESSMENT_SAVED'); break;
    }
    if (Date.now() > deadline) { await bridge.cancelRun(runId); throw new Error('isolated test deadline'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  copy.close();
} finally { host.close(); }
