import assert from 'node:assert/strict';
import { existsSync, renameSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { DesktopApplicationHost } from '../src/application-host.js';
import { startDesktopApplicationHost } from '../src/startup.js';
import { openWorkspaceStorage } from '../../../packages/storage/src/index.js';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';

for (const file of ['ui-settings.json', 'search-settings.json', 'provider.json']) {
  test(`startup preserves damaged ${file}, opens healthy projects, reports the fallback and permits reconfiguration`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'wa-startup-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const storage = openWorkspaceStorage({ workspacePath: root });
    const result = storage.createProject({ projectId: 'healthy', operationId: 'create-healthy', name: '仍可阅读的稿件',
      mode: 'quick', actor: { kind: 'user', id: 'local' } });
    assert.equal(result.ok, true);
    storage.close();
    const metadata = join(root, '.writing-agent');
    const profile = join(root, 'provider.json');
    const damagedPath = join(file === 'ui-settings.json' ? metadata : root, file);
    const original = Buffer.from('{"schemaVersion":1,"private":"SHOULD_NOT_APPEAR_IN_LOG",');
    writeFileSync(damagedPath, original);
    const options = { workspacePath: root, providerProfilePath: profile, credentials: new CredentialBroker({ environment: {} }) };
    const host = await startDesktopApplicationHost(options);
    try {
      await host.bridge.handshake();
      await host.bridge.selectProject('healthy');
      const snapshot = host.bridge.getSnapshot();
      assert.equal(snapshot.projects[0]?.name, '仍可阅读的稿件');
      assert.equal(snapshot.settings.theme, 'paper');
      assert.equal(snapshot.settings.contentFontSize, 14);
      assert.equal(snapshot.settings.credentialReference, null);
      assert.equal((await host.searchStatus()).tavilyEnabled, false);
      assert.equal(snapshot.startupNotices?.length, 1);
      const backup = readdirSync(dirname(damagedPath)).find(name => name.startsWith(file+'.invalid-'));
      assert.ok(backup, 'must preserve exact input bytes before changing settings');
      assert.deepEqual(readFileSync(join(dirname(damagedPath), backup)), original);
      assert.ok(snapshot.startupNotices![0]!.includes(backup));
      const log = readFileSync(join(metadata, 'logs', 'settings-recovery.jsonl'), 'utf8');
      assert.ok(log.includes(basename(damagedPath)));
      assert.ok(!log.includes('SHOULD_NOT_APPEAR_IN_LOG'));
      if (file === 'ui-settings.json') await host.bridge.updateSettings({ theme: 'dark' });
      if (file === 'search-settings.json') await host.configureSearch({ parallelEnabled: false, tavilyEnabled: false, searchLimit: 3 });
      if (file === 'provider.json') {
        assert.equal((await host.providerStatus()).configured, false);
        const status = await host.configureProvider({ kind: 'openai_compatible', providerId: 'synthetic-config',
          baseURL: 'https://example.invalid/v1', model: 'offline-fixture', tools: 'supported', usage: 'unknown',
          apiKey: 'synthetic-session-only', persistence: 'session' });
        assert.equal(status.model, 'offline-fixture');
      }
    } finally { host.close(); }
    const reopened = await startDesktopApplicationHost(options);
    try {
      assert.equal(reopened.bridge.getSnapshot().startupNotices?.length ?? 0, 0);
      assert.equal(reopened.bridge.getSnapshot().settings.theme, file === 'ui-settings.json' ? 'dark' : 'paper');
      if (file === 'search-settings.json') assert.equal((await reopened.searchStatus()).searchLimit, 3);
      if (file === 'provider.json') assert.equal((await reopened.providerStatus()).model, 'offline-fixture');
    } finally { reopened.close(); }
  });
}

test('unreadable settings path stays intact, disables overwrite and leaves the workspace usable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wa-startup-config-io-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, '.writing-agent', 'ui-settings.json');
  mkdirSync(file, { recursive: true });
  writeFileSync(join(file, 'sentinel'), 'keep');
  const host = await startDesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json') });
  try {
    assert.equal(host.bridge.getSnapshot().settings.theme, 'paper');
    assert.match(host.bridge.getSnapshot().startupNotices?.join(' ') ?? '', /原位置/);
    await assert.rejects(host.bridge.updateSettings({ theme: 'dark' }), /SETTINGS_FILE_PRESERVED/);
    assert.equal(readFileSync(join(file, 'sentinel'), 'utf8'), 'keep');
  } finally { host.close(); }
});

test('a valid JSON settings file with missing fields is archived even if the recovery log cannot be written', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wa-settings-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const metadata = join(root, '.writing-agent');
  mkdirSync(metadata);
  writeFileSync(join(metadata, 'logs'), 'synthetic path conflict');
  writeFileSync(join(metadata, 'ui-settings.json'), '{"schemaVersion":1}');
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { writes.push(String(chunk)); return true; });
  const host = await startDesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {} }) });
  try {
    assert.equal(host.bridge.getSnapshot().settings.theme, 'paper');
    assert.match(host.bridge.getSnapshot().startupNotices?.join(' ') ?? '', /日志无法写入/);
    assert.ok(writes.some(line => line.includes('UI_SETTINGS_INVALID') && line.includes('log_write_failed')));
    const copy = readdirSync(metadata).find(name => name.startsWith('ui-settings.json.invalid-'))!;
    assert.equal(readFileSync(join(metadata, copy), 'utf8'), '{"schemaVersion":1}');
  } finally { host.close(); }
});

test('a damaged draft waiting for confirmation can be backed up before repair; a running writer still blocks backup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wa-waiting-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = openWorkspaceStorage({ workspacePath: root });
  const actor = { kind: 'user', id: 'fixture' } as const;
  try {
    for (const id of ['damaged', 'healthy']) {
      assert.equal(storage.createProject({ projectId: id, operationId: id, name: id, mode: 'quick', actor }).ok, true);
      storage.createSession({ projectId: id, sessionId: id, purpose: 'draft' });
    }
    assert.equal(storage.commitArtifactVersion({ projectId: 'damaged', operationId: 'body', expectedProjectRevision: 0,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: 'draft', reason: 'fixture', actor }).ok, true);
    storage.startRun({ projectId: 'damaged', sessionId: 'damaged', runId: 'waiting', planVersion: 'test' });
    storage.pauseRun({ projectId: 'damaged', runId: 'waiting', operationId: 'pause', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'outline' } });
    const sql = new DatabaseSync(storage.databasePath);
    try { sql.exec("UPDATE body_documents SET document_json = 'damaged-bytes' WHERE project_id = 'damaged'"); }
    finally { sql.close(); }
  } finally { storage.close(); }
  const host = await startDesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {} }) });
  try {
    assert.ok(host.bridge.getSnapshot().projects.find(p => p.id === 'damaged')?.readIssue);
    const path = join(root, 'snapshot.sqlite3');
    await host.writeWorkspaceBackup(path);
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT document_json FROM body_documents WHERE project_id='damaged'").get()?.document_json, 'damaged-bytes');
      assert.equal(snapshot.prepare("SELECT status FROM runs WHERE id='waiting'").get()?.status, 'waiting_user');
    } finally { snapshot.close(); }
    const running = openWorkspaceStorage({ workspacePath: root });
    try { running.startRun({ projectId: 'healthy', sessionId: 'healthy', runId: 'running', planVersion: 'test' }); }
    finally { running.close(); }
    await assert.rejects(host.writeWorkspaceBackup(join(root, 'busy.sqlite3')), /ACTIVE_RUNS_PRESENT/);
  } finally { host.close(); }
});

test('legacy interrupted restore blocks startup before it can create an empty database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-restore-regression-'))
  try {
    const storage = openWorkspaceStorage({ workspacePath: root })
    storage.createProject({ operationId: 'create', projectId: 'saved-project', name: 'saved',
      mode: 'quick', actor: { kind: 'user', id: 'test' } })
    storage.close()
    const target = join(root, '.writing-agent', 'workspace.sqlite3')
    renameSync(target, `${target}.restore-previous-legacy`)
    await assert.rejects(async () => {
      const host = await startDesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json') })
      host.close()
    }, { code: 'RESTORE_RECOVERY_REQUIRED' })
    assert.equal(existsSync(target), false, 'startup must not silently create an empty workspace')
    assert.throws(() => new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json') }),
      { code: 'RESTORE_RECOVERY_REQUIRED' })
    assert.throws(() => openWorkspaceStorage({ workspacePath: root }), { code: 'RESTORE_RECOVERY_REQUIRED' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
