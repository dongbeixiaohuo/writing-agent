import { randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const settings = {
  appearance: { code: 'UI_SETTINGS_INVALID', label: '外观设置', fallback: '已使用默认主题和字号' },
  search: { code: 'SEARCH_SETTINGS_INVALID', label: '搜索设置', fallback: '外部搜索已关闭，可在设置中重新启用' },
  provider: { code: 'DESKTOP_PROVIDER_PROFILE_INVALID', label: '模型配置', fallback: '可以继续打开稿件，在设置中重新配置模型' },
  failureAnalysis: { code: 'FAILURE_ANALYSIS_SETTINGS_INVALID', label: '报错分析设置', fallback: '请在备份与排障中重新选择分析模型' },
} as const;
type SettingsKind = keyof typeof settings;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** The parser only sees persisted input. A read error must never rename a healthy file. */
export function readLocalSettings<T>(path: string, kind: SettingsKind, missing: T,
  parse: (input: unknown) => T, recovery?: LocalSettingsRecovery, damaged = missing): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      if (damaged === missing) return missing;
      // An archived settings file is a recovery, not a new installation.
      try {
        const prefix = basename(path) + '.invalid-';
        return readdirSync(dirname(path)).some(name => name.startsWith(prefix) && name.endsWith('.bak')) ? damaged : missing;
      } catch (directoryError) {
        if (errorCode(directoryError) === 'ENOENT') return missing;
        if (!recovery) throw directoryError;
        recovery.report(path, kind, false, errorCode(directoryError) ?? 'SETTINGS_READ_FAILED');
        return damaged;
      }
    }
    if (!recovery) throw error;
    recovery.report(path, kind, false, errorCode(error) ?? 'SETTINGS_READ_FAILED');
    return damaged;
  }
  try {
    return parse(JSON.parse(text));
  } catch (cause) {
    if (!recovery) {
      const code = settings[kind].code;
      throw Object.assign(new Error(code, { cause }), { code });
    }
    recovery.report(path, kind, true, settings[kind].code);
    return damaged;
  }
}

export class LocalSettingsRecovery {
  readonly notices: string[] = [];
  readonly #preserved = new Set<string>();

  constructor(private readonly logPath: string) {}

  assertWritable(path: string): void {
    if (this.#preserved.has(path)) throw new Error('SETTINGS_FILE_PRESERVED');
  }

  report(path: string, kind: SettingsKind, malformed: boolean, code: string): void {
    if (this.#preserved.has(path)) return;
    let backup: string | undefined;
    let archiveError: string | undefined;
    if (malformed) {
      try {
        if (!lstatSync(path).isFile()) throw new Error('NOT_A_REGULAR_SETTINGS_FILE');
        const destination = path + '.invalid-' + randomUUID() + '.bak';
        renameSync(path, destination);
        backup = basename(destination);
      } catch (error) {
        archiveError = errorCode(error) ?? 'SETTINGS_ARCHIVE_FAILED';
      }
    }
    if (!backup) this.#preserved.add(path);
    const setting = settings[kind];
    let notice = `${setting.label}${malformed ? '损坏' : '无法读取'}，${setting.fallback}。 ` +
      (backup ? `原文件保存在同目录的 ${backup}。` : '原文件保留在原位置。请检查文件权限或占用并重新打开应用，再保存这项设置。');
    const record = JSON.stringify({ time: new Date().toISOString(), file: basename(path), code, backup, archiveError });
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, record + '\n', { mode: 0o600, flush: true });
    } catch (error) {
      process.stderr.write(record + ' log_write_failed=' + (errorCode(error) ?? 'UNKNOWN') + '\n');
      notice += ' 本地诊断日志无法写入，错误已输出到进程日志。';
    }
    this.notices.push(notice);
  }
}
