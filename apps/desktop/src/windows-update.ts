import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { releaseUrl, type DesktopRelease } from './desktop-update.js';

const { NsisUpdater, CancellationToken, NoOpLogger } = electronUpdater;
const execFileAsync = promisify(execFile);
const SIGNATURE_CHECK = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$signature = Get-AuthenticodeSignature -LiteralPath $env:WA_UPDATE_INSTALLER_PATH
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 1 }
$sha = [System.Security.Cryptography.SHA256]::Create()
try { [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '') }
finally { $sha.Dispose() }
`;

export async function hasExpectedWindowsUpdateSigner(path: string, expectedSigner: string): Promise<boolean> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SIGNATURE_CHECK, 'utf16le').toString('base64')], {
      env: { ...process.env, PSModulePath: join(dirname(powershell), 'Modules'), WA_UPDATE_INSTALLER_PATH: path }, windowsHide: true, timeout: 20_000,
    });
    return stdout.trim().toLowerCase() === expectedSigner;
  } catch (error) {
    throw new Error('UPDATE_SIGNATURE_CHECK_FAILED', { cause: error });
  }
}

export function matchesReleaseManifest(info: UpdateInfo, release: DesktopRelease): boolean {
  const file = info.files?.[0];
  return info.version === release.version && info.path === release.installer && info.files?.length === 1 &&
    file?.url === release.installer && file.size === release.installerBytes && !('packages' in info) &&
    typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(file.sha512) && file.sha512 === info.sha512;
}

async function hasExpectedHash(path: string, sha512: string, signal: AbortSignal): Promise<boolean> {
  const hash = createHash('sha512');
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
  return hash.digest('base64') === sha512;
}

export async function downloadWindowsUpdate(release: DesktopRelease, expectedSigner: string,
  onProgress: (percent: number) => void, signal: AbortSignal): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSigner)) throw new Error('UPDATE_SIGNER_NOT_CONFIGURED');
  const updater = new NsisUpdater({ provider: 'generic', url: releaseUrl(release, 'download'), channel: 'latest' });
  updater.logger = new NoOpLogger();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = true;
  updater.disableWebInstaller = true;
  // A per-release feed has no previous installer blockmap. Download the full package.
  updater.disableDifferentialDownload = true;
  updater.verifyUpdateCodeSignature = async (_names, path) =>
    await hasExpectedWindowsUpdateSigner(path, expectedSigner) ? null : 'UPDATE_SIGNER_MISMATCH';
  updater.on('download-progress', progress => onProgress(progress.percent));
  const update = await updater.checkForUpdates();
  signal.throwIfAborted();
  if (!update?.isUpdateAvailable || !matchesReleaseManifest(update.updateInfo, release)) throw new Error('UPDATE_MANIFEST_MISMATCH');
  const token = new CancellationToken();
  const cancel = () => token.cancel();
  const deadline = setTimeout(cancel, 20 * 60 * 1000);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const [path] = await updater.downloadUpdate(token);
    // Check cached downloads too. The library's signature callback is only called on a fresh download.
    if (!path || !await hasExpectedHash(path, update.updateInfo.sha512, signal) || !await hasExpectedWindowsUpdateSigner(path, expectedSigner)) {
      throw new Error('UPDATE_INSTALLER_UNVERIFIED');
    }
    signal.throwIfAborted();
    return path;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
  }
}

export async function launchWindowsUpdateInstaller(path: string): Promise<void> {
  const installer = spawn(path, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    installer.once('error', reject);
    installer.once('spawn', resolve);
  });
  installer.unref();
}
