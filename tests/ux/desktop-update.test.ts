import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { seedPublicationWorkspace } from '../fixtures/publication-workspace.js';

test('Electron keeps running until a new release appears, waits for safe restart and restores the draft', { timeout: 100_000, skip: process.platform !== 'win32' }, t => {
  const id = `update-${randomUUID().replaceAll('-', '')}`;
  const directory = join(tmpdir(), `writing-agent-desktop-test-${id}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  seedPublicationWorkspace(join(directory, 'workspace'), true, true);
  buildSync({ entryPoints: ['apps/desktop/src/desktop-update.ts'], platform: 'node', format: 'cjs', bundle: true, outfile: join(directory, 'update.cjs') });
  const installedElectron = createRequire(import.meta.url)('electron') as string;
  const binaryRoot = join(directory, 'electron');
  cpSync(dirname(installedElectron), binaryRoot, { recursive: true });
  const electron = join(binaryRoot, basename(installedElectron));
  const stage = join(directory, 'app');
  cpSync(resolve('apps/desktop/dist/package'), stage, { recursive: true });
  const fixture = resolve('apps/desktop/test/fixtures/desktop-update-electron.cjs');
  for (const launch of ['upgrade', 'reopen']) {
    const env = { ...process.env, WA_UPDATE_TEST_LAUNCH: launch, WA_UPDATE_TEST_STAGE: stage, WRITING_AGENT_DESKTOP_TEST: id };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electron, [fixture], { env, windowsHide: true, timeout: 35_000, encoding: 'utf8' });
    const failure = join(directory, 'failure.txt');
    assert.equal(child.status, 0, existsSync(failure) ? readFileSync(failure, 'utf8') : `${launch}: ${child.error?.message ?? ''}\n${child.stderr}`);
  }
  const installed = JSON.parse(readFileSync(join(directory, 'installed.json'), 'utf8'));
  const reopened = JSON.parse(readFileSync(join(directory, 'reopened.json'), 'utf8'));
  assert.equal(installed.downloads, 1);
  assert.equal(installed.checks, 3);
  assert.ok(installed.installRequests >= 2);
  assert.deepEqual(reopened, { project: '夜跑随想', draftRestored: true });
});
