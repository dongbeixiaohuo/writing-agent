import { compare, valid } from 'semver';
import type { DesktopUpdateAction, DesktopUpdateState } from '../../../packages/client-bridge/src/desktop-update.js';

const REPOSITORY = 'dongbeixiaohuo/writing-agent';
export const DESKTOP_RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
export const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

export interface DesktopRelease {
  readonly version: string;
  readonly installer: string;
  readonly installerBytes: number;
  readonly hasUpdateManifest: boolean;
}

export function releaseUrl(release: DesktopRelease, kind: 'tag' | 'download'): string {
  return `${RELEASES_URL}/${kind}/desktop-v${release.version}`;
}

export function selectDesktopRelease(value: unknown, currentVersion: string): DesktopRelease | null {
  if (!Array.isArray(value) || !valid(currentVersion)) throw new Error('UPDATE_RELEASE_LIST_INVALID');
  let latest: DesktopRelease | null = null;
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || entry.draft !== false || !entry.published_at) continue;
    const version = typeof entry.tag_name === 'string'
      ? /^desktop-v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/u.exec(entry.tag_name)?.[1] : undefined;
    if (!version || valid(version) !== version || compare(version, currentVersion) <= 0 || !Array.isArray(entry.assets)) continue;
    if (latest && compare(version, latest.version) <= 0) continue;
    const installer = `Writing-Agent-Setup-${version}-x64.exe`;
    const uploaded = new Map<string, number>();
    for (const asset of entry.assets) {
      if (asset?.state === 'uploaded' && typeof asset.name === 'string' && Number.isSafeInteger(asset.size) && asset.size > 0) {
        uploaded.set(asset.name, asset.size);
      }
    }
    const installerBytes = uploaded.get(installer);
    if (!installerBytes || !uploaded.has('SHA256SUMS.txt')) continue;
    latest = { version, installer, installerBytes, hasUpdateManifest: uploaded.has('latest.yml') };
  }
  return latest;
}

interface DesktopUpdateOptions {
  version: string;
  canInstallInApp: boolean;
  listReleases(signal: AbortSignal): Promise<unknown>;
  download(release: DesktopRelease, onProgress: (percent: number) => void, signal: AbortSignal): Promise<string>;
  safeToRestart(): boolean;
  install(path: string): Promise<void>;
  openRelease(url: string): Promise<void>;
  publish(state: DesktopUpdateState): void;
  logFailure(operation: string, error: unknown): void;
  now?: () => number;
}

export class DesktopUpdate {
  #state: DesktopUpdateState = { phase: 'idle' };
  #offer: DesktopRelease | null = null;
  #verifiedInstaller: string | null = null;
  #lastCheckAt = -Infinity;
  #work: AbortController | null = null;
  #stopped = false;
  readonly #options: DesktopUpdateOptions;

  constructor(options: DesktopUpdateOptions) { this.#options = options; }

  get installing(): boolean { return this.#state.phase === 'installing'; }

  stop(): void {
    this.#stopped = true;
    this.#work?.abort();
  }

  #publish(state: DesktopUpdateState): void {
    if (this.#stopped) return;
    this.#state = state;
    this.#options.publish(state);
  }

  async check(manual = false): Promise<void> {
    if (this.#stopped || this.#work || this.#verifiedInstaller || this.installing) return;
    const now = (this.#options.now ?? Date.now)();
    if (!manual && now - this.#lastCheckAt < UPDATE_INTERVAL_MS) return;
    this.#lastCheckAt = now;
    const work = this.#work = new AbortController();
    const previous = this.#state;
    if (manual || previous.phase === 'available') this.#publish({ phase: 'checking' });
    try {
      const offer = selectDesktopRelease(await this.#options.listReleases(work.signal), this.#options.version);
      if (this.#stopped) return;
      this.#offer = offer;
      this.#publish(offer === null ? { phase: 'current' } : {
        phase: 'available', version: offer.version, installInApp: this.#options.canInstallInApp && offer.hasUpdateManifest,
      });
    } catch (error) {
      if (this.#stopped) return;
      this.#options.logFailure('check', error);
      this.#publish(manual ? { phase: 'error', operation: 'check', message: '暂时连不上 GitHub 或读不到版本信息，过一会儿可以再查。' } : previous);
    } finally { this.#work = null; }
  }

  async #download(): Promise<void> {
    const offer = this.#offer;
    if (this.#stopped || this.#work || this.#verifiedInstaller || this.installing || !offer?.hasUpdateManifest || !this.#options.canInstallInApp) return;
    const work = this.#work = new AbortController();
    this.#publish({ phase: 'downloading', version: offer.version, percent: 0 });
    try {
      const path = await this.#options.download(offer, value => {
        const percent = Math.max(0, Math.min(100, Math.floor(value)));
        if (Number.isFinite(percent) && this.#state.phase === 'downloading' && percent > this.#state.percent) {
          this.#publish({ phase: 'downloading', version: offer.version, percent });
        }
      }, work.signal);
      if (this.#stopped) return;
      this.#verifiedInstaller = path;
      this.#publish({ phase: 'ready', version: offer.version });
    } catch (error) {
      if (this.#stopped) return;
      this.#options.logFailure('download', error);
      this.#publish({ phase: 'error', operation: 'download', message: '更新未能下载或通过校验。可以重试，也可以到 GitHub 查看这个版本。' });
    } finally { this.#work = null; }
  }

  async #install(): Promise<void> {
    const path = this.#verifiedInstaller;
    if (this.#stopped || this.installing || !path || !this.#offer || !this.#options.safeToRestart()) return;
    this.#publish({ phase: 'installing', version: this.#offer.version });
    try { await this.#options.install(path); }
    catch (error) {
      this.#options.logFailure('install', error);
      this.#publish({ phase: 'error', operation: 'install', message: '安装程序没有启动。可以重试安装，或到 GitHub 手动下载。' });
    }
  }

  async request(action: DesktopUpdateAction): Promise<DesktopUpdateState> {
    if (this.#stopped) return { phase: 'disabled' };
    if (action === 'check') await this.check(true);
    if (action === 'download') await this.#download();
    if (action === 'install') await this.#install();
    if (action === 'open-release' && this.#offer && !this.installing) await this.#options.openRelease(releaseUrl(this.#offer, 'tag'));
    return this.#state;
  }
}
