import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { replaceWorkspaceDatabaseFromBackup } from '../../apps/desktop/src/workspace-restore.js';
import { seedPublicationWorkspace } from '../fixtures/publication-workspace.js';

const devElectron = createRequire(import.meta.url)('electron') as string;
// Chromium child processes need ordinary inherited Windows ACLs; the checkout may be on OneDrive.
const binaryRoot = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'wa-electron-runtime-')) : null;
if (binaryRoot) cpSync(dirname(devElectron), binaryRoot, { recursive: true });
after(() => { if (binaryRoot) rmSync(binaryRoot, { recursive: true, force: true, maxRetries: 3 }); });
const electron = binaryRoot ? join(binaryRoot, basename(devElectron)) : devElectron;
const actor = { kind: 'user', id: 'fixture' } as const;

for (const action of ['projects', 'rollback', 'retry', 'prepare', 'exit', 'apply'] as const) {
  test(`Electron first-batch startup through native IPC: ${action}`, async t => {
    const id = 'batch1-' + randomUUID().replaceAll('-', '');
    const root = join(tmpdir(), 'writing-agent-desktop-test-' + id);
    mkdirSync(root);
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    const workspace = join(root, 'workspace');
    if (action === 'projects') {
      seedPublicationWorkspace(workspace, true, true);
      const storage = openWorkspaceStorage({ workspacePath: workspace });
      try {
        storage.createSession({ sessionId: 'healthy-session', projectId: 'other-project', purpose: 'writing-pack:draft' });
        assert.equal(storage.commitArtifactVersion({ projectId: 'other-project', operationId: 'healthy', expectedProjectRevision: 0,
          kind: 'body', logicalKey: 'main', baseVersionId: null, content: '健康项目专属内容', reason: 'fixture', actor }).ok, true);
        await storage.createBackup(join(root, 'project-backup.sqlite3'));
      } finally { storage.close(); }
      const db = new DatabaseSync(join(workspace,'.writing-agent','workspace.sqlite3'));
      try { db.exec("UPDATE body_documents SET document_json='original-damaged-bytes' WHERE project_id='publication-fixture'"); }
      finally { db.close(); }
      writeFileSync(join(workspace, '.writing-agent', 'ui-settings.json'), '{"theme":');
    } else {
      const backupPath = join(root, 'selected.sqlite3');
      for (const [location, name] of [[workspace, '原有文章'], [join(root, 'source'), '备份中的文章']] as const) {
        const storage = openWorkspaceStorage({ workspacePath: location });
        try {
          assert.equal(storage.createProject({ projectId: name, operationId: name, name, mode: 'quick', actor }).ok, true);
          if (location !== workspace) await storage.createBackup(backupPath);
        } finally { storage.close(); }
      }
      if (action !== 'apply') await assert.rejects(replaceWorkspaceDatabaseFromBackup({ workspacePath: workspace, backupPath, onPhase: phase => {
        if (phase === (action === 'prepare' ? 'transaction-created' : 'target-removed')) throw Error('SIMULATED_EXIT');
      } }), /SIMULATED_EXIT/);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, WRITING_AGENT_DESKTOP_TEST: id, WA_FIXTURE_ACTION: action };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WRITING_AGENT_DESKTOP_SMOKE;
    const child = spawnSync(electron, [resolve('apps/desktop/test/fixtures/startup-resilience-electron.cjs')], {
      env, windowsHide: true, timeout: 35_000, encoding: 'utf8',
    });
    const resultPath = join(root, 'result.json');
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {};
    assert.equal(child.status, 0, JSON.stringify({ result, error: child.error?.message, stderr: child.stderr?.slice(-800) }));
    assert.equal(result.passed, true, JSON.stringify(result));
    if (action === 'exit') {
      assert.ok(existsSync(join(workspace, '.writing-agent', 'restore-journal.json')));
      assert.equal(existsSync(join(workspace, '.writing-agent', 'workspace.sqlite3')), false);
    }
    if (action === 'apply') {
      // The regular desktop opener re-enables WAL on the installed standalone snapshot.
      const restored = openWorkspaceStorage({ workspacePath: workspace });
      try { assert.deepEqual(restored.listProjects().map(p => p.name), ['备份中的文章']); }
      finally { restored.close(); }
      const safety = new DatabaseSync(join(workspace, '.writing-agent', 'restore-backups', result.safetyBackupFileName), { readOnly: true });
      try { assert.equal(safety.prepare('SELECT name FROM projects').get()?.name, '原有文章'); }
      finally { safety.close(); }
    }
    if (action === 'projects') {
      const fresh = openWorkspaceStorage({ workspacePath: workspace, readOnly: true });
      try {
        const repaired = fresh.inspectProject('publication-fixture')!;
        assert.match(fresh.getBodyDocument(repaired.latestBodyVersionId!)!.content, /慢慢跑步/);
        const healthy = fresh.inspectProject('other-project')!;
        assert.equal(fresh.getArtifactVersion(healthy.latestBodyVersionId!)?.content, '健康项目专属内容');
      } finally { fresh.close(); }
    }
  });
}
