import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DesktopApplicationHost } from '../src/application-host.js';
import { seedPublicationWorkspace } from '../../../tests/fixtures/publication-workspace.js';
import { openWorkspaceStorage } from '../../../packages/storage/src/index.js';

async function fixture(passed = true, secondProject = false) {
  const root = mkdtempSync(join(tmpdir(), 'wa-publication-save-'));
  const workspacePath = join(root, 'workspace');
  const bodyVersionId = seedPublicationWorkspace(workspacePath, passed, secondProject);
  const host = new DesktopApplicationHost({ workspacePath, providerProfilePath: join(root, 'provider.json') });
  await host.bridge.selectProject('publication-fixture');
  const input = { projectId: 'publication-fixture', bodyVersionId, format: 'html' as const, layoutPreset: 'clean' as const };
  const cleanup = () => { host.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, workspacePath, host, input, cleanup };
}

function addRun(workspacePath: string, projectId: string, status: 'running' | 'waiting_user' | 'queued' | 'paused') {
  const storage = openWorkspaceStorage({ workspacePath });
  const runId = `export-${projectId}-${status}`;
  try {
    storage.createSession({ sessionId: runId, projectId, purpose: 'writing-pack:draft' });
    storage.startRun({ runId, sessionId: runId, projectId, planVersion: 'export-test' });
    if (status === 'waiting_user') {
      storage.pauseRun({ projectId, runId, operationId: `pause-${runId}`, reason: 'CO_CREATION_CHECKPOINT', payload: {} });
    } else if (status !== 'running') {
      const database = new DatabaseSync(storage.databasePath);
      try { database.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId); }
      finally { database.close(); }
    }
    return runId;
  } finally { storage.close(); }
}

for (const status of ['waiting_user', 'running'] as const) {
  test(`another project's ${status} run does not block the current verified article's Save As`, async () => {
    const f = await fixture(true, true);
    try {
      const runId = addRun(f.workspacePath, 'other-project', status);
      let dialogCalls = 0;
      const target = join(f.root, '已核查文章.html');
      const result = await f.host.savePublicationAs({ ...f.input, layoutPreset: 'editorial' }, async name => {
        dialogCalls++;
        assert.equal(name, '夜跑随想.html');
        return target;
      });
      assert.equal(result.cancelled, false);
      assert.equal(dialogCalls, 1);
      assert.match(readFileSync(target, 'utf8'), /放慢脚步/u);
      const text = await f.host.savePublicationAs({ ...f.input, format: 'txt' }, async () => join(f.root, '已核查文章.txt'));
      assert.equal(text.cancelled, false);
      const storage = openWorkspaceStorage({ workspacePath: f.workspacePath });
      try { assert.equal(storage.getRun(runId)?.status, status, 'export must leave the other run untouched'); }
      finally { storage.close(); }
    } finally { f.cleanup(); }
  });
}

for (const status of ['queued', 'running', 'paused'] as const) {
  test(`a ${status} run in the current project still blocks export before the save dialog`, async () => {
    const f = await fixture();
    try {
      addRun(f.workspacePath, f.input.projectId, status);
      await assert.rejects(f.host.savePublicationAs(f.input, async () => {
        assert.fail('current project is being processed; no save dialog is allowed');
      }), /EXPORT_WRITING_ACTIVE/u);
    } finally { f.cleanup(); }
  });
}

test('a passed article can be exported while its own run is only waiting for feedback', async () => {
  const f = await fixture();
  try {
    addRun(f.workspacePath, f.input.projectId, 'waiting_user');
    assert.deepEqual(await f.host.savePublicationAs(f.input, async () => null), { cancelled: true });
  } finally { f.cleanup(); }
});

test('starting current-project processing while the save dialog is open prevents writing a file', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'processing.html');
    await assert.rejects(f.host.savePublicationAs(f.input, async () => {
      addRun(f.workspacePath, f.input.projectId, 'running');
      return target;
    }), /EXPORT_WRITING_ACTIVE/u);
    assert.equal(existsSync(target), false);
    assert.equal(f.host.bridge.getSnapshot().deliveryWorkspace.exports.length, 0);
  } finally { f.cleanup(); }
});

test('formal export saves the verified rendered file at the user-selected path and can locate it by receipt', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.host.savePublicationAs, 'function', 'Native Save As must exist');
    const target = join(f.root, '用户选择的文章.html');
    const result = await f.host.savePublicationAs(f.input, async name => {
      assert.equal(name, '夜跑随想.html'); return target;
    });
    assert.equal(result.cancelled, false);
    if (result.cancelled) throw new Error('unexpected cancel');
    assert.equal(result.savedPath, target);
    assert.match(readFileSync(target, 'utf8'), /<strong>放慢脚步<\/strong>/u);
    assert.equal(f.host.publicationSavedPath(result.receiptId), target);
    assert.throws(() => f.host.publicationSavedPath(target), /EXPORT_RECEIPT_NOT_FOUND/u);
    const text = await f.host.savePublicationAs({ ...f.input, format: 'txt' }, async () => join(f.root, '文章.txt'));
    assert.equal(text.cancelled, false);
    assert.doesNotMatch(readFileSync(join(f.root, '文章.txt'), 'utf8'), /\*\*放慢脚步\*\*|<strong>/u);
  } finally { f.cleanup(); }
});

test('cancel saves nothing and does not create an export record', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.host.savePublicationAs, 'function');
    assert.deepEqual(await f.host.savePublicationAs(f.input, async () => null), { cancelled: true });
    assert.equal(f.host.bridge.getSnapshot().deliveryWorkspace.exports.length, 0);
  } finally { f.cleanup(); }
});

test('unverified current body cannot open a formal save dialog', async () => {
  const f = await fixture(false);
  try {
    assert.equal(typeof f.host.savePublicationAs, 'function');
    await assert.rejects(f.host.savePublicationAs(f.input, async () => { assert.fail('gate must precede dialog'); }), /FACT_GATE_NOT_PASSED/u);
  } finally { f.cleanup(); }
});

test('body changes while choosing the path invalidate the export instead of saving a different revision', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.host.savePublicationAs, 'function');
    const target = join(f.root, 'stale.html');
    await assert.rejects(f.host.savePublicationAs(f.input, async () => {
      await f.host.bridge.saveBody(f.input.bodyVersionId, '# 新版本\n\n新的一点感受。', 'export race test'); return target;
    }), /EXPORT_SELECTION_CHANGED/u);
    assert.equal(existsSync(target), false);
  } finally { f.cleanup(); }
});

test('the save dialog cannot overwrite workspace internals or use the wrong extension', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.host.savePublicationAs, 'function');
    for (const target of [join(f.workspacePath, 'overwrite.html'), join(f.root, 'provider.json')]) {
      await assert.rejects(f.host.savePublicationAs(f.input, async () => target), /EXPORT_DESTINATION_INVALID/u);
      assert.equal(existsSync(target), false);
    }
  } finally { f.cleanup(); }
});

test('switching project while the dialog is open never exports the newly selected project', async () => {
  const f = await fixture(true, true);
  try {
    await assert.rejects(f.host.savePublicationAs(f.input, async () => {
      await f.host.bridge.selectProject('other-project'); return join(f.root, 'wrong-project.html');
    }), /EXPORT_SELECTION_CHANGED/u);
    assert.equal(existsSync(join(f.root, 'wrong-project.html')), false);
  } finally { f.cleanup(); }
});
