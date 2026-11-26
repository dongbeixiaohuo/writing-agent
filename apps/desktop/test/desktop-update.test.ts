import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DesktopUpdateState } from '../../../packages/client-bridge/src/desktop-update.js';
import { DesktopUpdate, UPDATE_INTERVAL_MS, selectDesktopRelease } from '../src/desktop-update.js';
import { hasExpectedWindowsUpdateSigner, matchesReleaseManifest } from '../src/windows-update.js';

function release(version: string, manifest = true) {
  const asset = (name: string) => ({ name, size: 42, state: 'uploaded', browser_download_url: 'https://untrusted.example/file.exe' });
  return {
    tag_name: `desktop-v${version}`, draft: false, published_at: '2026-11-26T00:00:00Z', prerelease: true,
    assets: [asset(`Writing-Agent-Setup-${version}-x64.exe`), asset('SHA256SUMS.txt'), ...(manifest ? [asset('latest.yml')] : [])],
  };
}

test('discovery chooses a newer public complete Windows desktop RC by semantic version', () => {
  const entries = [release('1.0.0-rc.99'), release('1.0.0-rc.115'), { ...release('1.0.0-rc.999'), draft: true },
    { ...release('1.0.0-rc.777'), assets: [] }, { ...release('1.0.0-rc.500'), tag_name: 'v1.0.0-rc.500' },
    { ...release('1.0.0-rc.255'), assets: [{ ...release('1.0.0-rc.255').assets[0], state: 'starter' }] }, release('1.0.0-rc.124')];
  assert.deepEqual(selectDesktopRelease(entries, '1.0.0-rc.116'), {
    version: '1.0.0-rc.124', installer: 'Writing-Agent-Setup-1.0.0-rc.124-x64.exe', installerBytes: 42, hasUpdateManifest: true,
  });
  assert.equal(selectDesktopRelease(entries, '1.0.0-rc.124'), null);
});

test('while a window stays open, polling or resuming discovers a newly published RC and coalesces overlapping checks', async () => {
  const states: DesktopUpdateState[] = [];
  let now = 0;
  let entries: unknown[] = [];
  let checks = 0;
  const update = new DesktopUpdate({
    version: '1.0.0-rc.116', now: () => now, canInstallInApp: false,
    async listReleases() { checks++; return entries; },
    download: async () => assert.fail('unsigned builds cannot download an update for automatic installation'),
    safeToRestart: () => true, install: async () => assert.fail('must not install'),
    openRelease: async url => assert.equal(url, 'https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.117'),
    publish: state => states.push(state), logFailure: (_, error) => assert.fail(String(error)),
  });
  await update.check();
  assert.deepEqual(states.at(-1), { phase: 'current' });
  entries = [release('1.0.0-rc.117')];
  now += UPDATE_INTERVAL_MS - 1;
  await update.check();
  assert.equal(checks, 1);
  now++;
  await Promise.all([update.check(), update.check(), update.request('check')]);
  assert.equal(checks, 2);
  assert.deepEqual(states.at(-1), { phase: 'available', version: '1.0.0-rc.117', installInApp: false });
  await update.request('download');
  await update.request('open-release');
  update.stop();
  await update.check(true);
  assert.equal(checks, 2);
});

test('signed update waits until all work is saved and starts the installer exactly once', async () => {
  const states: DesktopUpdateState[] = [];
  let downloads = 0;
  let installs = 0;
  let busy = true;
  const update = new DesktopUpdate({
    version: '1.0.0-rc.116', canInstallInApp: true,
    listReleases: async () => [release('1.0.0-rc.117')],
    async download(_release, progress) { downloads++; progress(41); progress(100); return 'test-installer'; },
    safeToRestart: () => !busy,
    async install(path) { installs++; assert.equal(path, 'test-installer'); },
    openRelease: async () => {}, publish: state => states.push(state), logFailure: (_, error) => assert.fail(String(error)),
  });
  await update.check();
  assert.equal(downloads, 0);
  await Promise.all([update.request('download'), update.request('download')]);
  assert.equal(downloads, 1);
  assert.ok(states.some(state => state.phase === 'downloading' && state.percent === 41));
  assert.deepEqual(states.at(-1), { phase: 'ready', version: '1.0.0-rc.117' });
  await update.request('install');
  assert.equal(installs, 0);
  busy = false;
  await Promise.all([update.request('install'), update.request('install')]);
  assert.equal(installs, 1);
  assert.equal(update.installing, true);
});

test('offline checks, bad downloads and a failed launch leave actionable retry states', async () => {
  const failures: string[] = [];
  let offline = true;
  let badDownload = true;
  let badLaunch = true;
  const update = new DesktopUpdate({
    version: '1.0.0-rc.116', canInstallInApp: true,
    async listReleases() { if (offline) throw new Error('offline'); return [release('1.0.0-rc.125')]; },
    async download() { if (badDownload) throw new Error('bad signature'); return 'verified'; },
    safeToRestart: () => true, async install() { if (badLaunch) throw new Error('spawn failed'); },
    openRelease: async () => {}, publish: () => {}, logFailure: operation => failures.push(operation),
  });
  await update.check();
  assert.equal((await update.request('status')).phase, 'idle');
  assert.equal((await update.request('check')).phase, 'error');
  offline = false;
  assert.equal((await update.request('check')).phase, 'available');
  assert.equal((await update.request('download')).phase, 'error');
  assert.equal((await update.request('install')).phase, 'error');
  badDownload = false;
  assert.equal((await update.request('download')).phase, 'ready');
  assert.equal((await update.request('install')).phase, 'error');
  badLaunch = false;
  assert.equal((await update.request('install')).phase, 'installing');
  assert.deepEqual(failures, ['check', 'check', 'download', 'install']);
});

test('signed build offers a release missing update metadata as a manual download', async () => {
  const update = new DesktopUpdate({
    version: '1.0.0-rc.116', canInstallInApp: true, listReleases: async () => [release('1.0.0-rc.117', false)],
    download: async () => assert.fail('no update metadata'), safeToRestart: () => true, install: async () => assert.fail('must not install'),
    openRelease: async () => {}, publish: () => {}, logFailure: (_, error) => assert.fail(String(error)),
  });
  assert.deepEqual(await update.request('check'), { phase: 'available', version: '1.0.0-rc.117', installInApp: false });
  assert.equal((await update.request('download')).phase, 'available');
});

test('update metadata can only point at the exact version and asset discovered on GitHub', () => {
  const offer = selectDesktopRelease([release('1.0.0-rc.117')], '1.0.0-rc.116')!;
  const sha512 = createHash('sha512').update('fixture').digest('base64');
  const info = { version: offer.version, sha512, path: offer.installer, releaseDate: '2026-11-26', files: [{ url: offer.installer, sha512, size: offer.installerBytes }] };
  assert.equal(matchesReleaseManifest(info, offer), true);
  assert.equal(matchesReleaseManifest({ ...info, version: '1.0.0-rc.118' }, offer), false);
  assert.equal(matchesReleaseManifest({ ...info, files: [{ ...info.files[0]!, url: 'https://untrusted.example/file.exe' }] }, offer), false);
  assert.equal(matchesReleaseManifest({ ...info, files: [{ ...info.files[0]!, size: 43 }] }, offer), false);
});

test('authenticode requires a trusted Windows signature and the exact configured certificate', { skip: process.platform !== 'win32' }, async () => {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `
$ProgressPreference = 'SilentlyContinue'
$path = Join-Path $PSHOME powershell.exe
$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($signature.Status -ne 'Valid') { exit 1 }
[Convert]::ToBase64String($signature.SignerCertificate.RawData)
`;
  const raw = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    env: { ...process.env, PSModulePath: join(dirname(powershell), 'Modules') }, encoding: 'utf8', timeout: 20_000,
  });
  const expected = createHash('sha256').update(Buffer.from(raw.trim(), 'base64')).digest('hex');
  assert.equal(await hasExpectedWindowsUpdateSigner(powershell, expected), true);
  assert.equal(await hasExpectedWindowsUpdateSigner(powershell, '0'.repeat(64)), false);
  await assert.rejects(hasExpectedWindowsUpdateSigner(fileURLToPath(import.meta.url), expected), /UPDATE_SIGNATURE_CHECK_FAILED/u);
});
