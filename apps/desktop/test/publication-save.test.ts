import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopApplicationHost } from '../src/application-host.js';
import { seedPublicationWorkspace } from '../../../tests/fixtures/publication-workspace.js';

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
