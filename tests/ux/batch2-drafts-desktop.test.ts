import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { seedPublicationWorkspace } from '../fixtures/publication-workspace.js';
const compiledRoot = resolve(process.env.WA_COMPILED_ROOT ?? '.');
const label = process.env.WA_TEST_LABEL ?? 'new';
const out = resolve('output/testing/batch2');
mkdirSync(out, { recursive: true });
const devElectron = createRequire(import.meta.url)('electron') as string;
const binaryRoot = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'wa-electron-drafts-')) : null;
if (binaryRoot) cpSync(dirname(devElectron), binaryRoot, { recursive: true });
after(() => { if (binaryRoot) rmSync(binaryRoot, { recursive: true, force: true, maxRetries: 3 }); });
const electron = binaryRoot ? join(binaryRoot, basename(devElectron)) : devElectron;
for (const scenario of ['project', 'navigation', 'paragraph', 'isolation']) {
  test(`Electron draft recovery: ${scenario}`, t => {
    const id = 'batch2-' + randomUUID().replaceAll('-', '');
    const root = join(tmpdir(), 'writing-agent-desktop-test-' + id);
    mkdirSync(root);
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    const workspace = join(root, 'workspace');
    seedPublicationWorkspace(workspace, true, true);
    const storage = openWorkspaceStorage({ workspacePath: workspace });
    storage.createSession({ sessionId: 'other-session', projectId: 'other-project', purpose: 'writing-pack:draft' });
    storage.close();
    const env = { ...process.env, WA_COMPILED_ROOT: compiledRoot, WRITING_AGENT_DESKTOP_TEST: id, WA_DRAFT_SCENARIO: scenario };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electron, [resolve('apps/desktop/test/fixtures/batch2-drafts-electron.cjs')], { env, windowsHide: true, timeout: 35_000, encoding: 'utf8' });
    const result = existsSync(join(root, 'result.json')) ? JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) : { error: child.error?.message, stderr: child.stderr };
    writeFileSync(join(out, `${label}-drafts-${scenario}.json`), JSON.stringify({ compiledRoot, ...result }, null, 2));
    assert.equal(child.status, 0, JSON.stringify(result));
    assert.equal(result.passed, true);
  });
}
