import { appendFileSync, mkdirSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { migrateWorkspaceStorage, StorageOpenError } from "../../../packages/storage/src/index.js";
import { DesktopApplicationHost, type DesktopApplicationHostOptions } from "./application-host.js";

/** Called only by the desktop process that owns the single-instance lock. */
export async function startDesktopApplicationHost(
  options: DesktopApplicationHostOptions,
): Promise<DesktopApplicationHost> {
  try {
    return new DesktopApplicationHost(options);
  } catch (error) {
    // The storage opener closes its connection on failure. Do not repair unknown,
    // corrupt, inaccessible or newer databases, and never create a replacement.
    if (!(error instanceof StorageOpenError) || error.code !== "SCHEMA_MIGRATION_REQUIRED") throw error;
    // Uses SQLite online backup + identity/integrity checks before the ordered
    // migration transaction; backup failures leave the old schema untouched.
    await migrateWorkspaceStorage({ workspacePath: options.workspacePath });
    return new DesktopApplicationHost(options);
  }
}

const STARTUP_ERRORS: Readonly<Record<string, string>> = {
  SCHEMA_MIGRATION_REQUIRED: "旧版工作区需要升级，请安装最新客户端后重试。不要删除项目数据库。",
  SCHEMA_MIGRATION_FAILED: "工作区升级未完成，升级前备份仍保留在工作区的 .writing-agent/backups 中。请保留原文件并反馈日志。",
  SCHEMA_UNSUPPORTED: "这个工作区由更新版本的客户端创建，请使用相同或更新版本打开；程序不会降级或清空数据。",
  SCHEMA_MIGRATION_UNSUPPORTED: "这个工作区版本暂不支持自动升级。请保留原文件并反馈日志。",
  DATABASE_CORRUPT: "工作区数据库未通过完整性检查。程序不会清空或重建项目，请保留原文件并从已验证备份恢复。",
  DATABASE_UNAVAILABLE: "无法读取工作区数据库，请检查文件访问权限、磁盘空间及是否被其他程序占用。",
  DATABASE_CONFIGURATION_FAILED: "工作区数据库无法启用所需的安全存储设置，请检查磁盘和文件访问权限。",
  UNRECOGNIZED_DATABASE: "工作区不是可识别的 Writing Agent 数据库，程序不会覆盖它。请检查工作区路径。",
  BACKUP_VERIFICATION_FAILED: "升级前备份未通过校验，已停止升级。请保留原工作区并检查磁盘空间。",
  BACKUP_DESTINATION_EXISTS: "备份目标已存在，程序未覆盖它。请保留备份并重试。",
  DESKTOP_PROVIDER_PROFILE_INVALID: "模型配置文件无法读取，请保留配置文件并反馈日志；不要删除项目数据。",
  SEARCH_SETTINGS_INVALID: "搜索配置文件无法读取，请保留配置文件并反馈日志；不要删除项目数据。",
  EACCES: "没有访问工作区或备份目录的权限，请检查目录权限。",
  EPERM: "工作区或备份目录拒绝了文件操作，请检查目录权限和文件占用。",
  ENOSPC: "磁盘空间不足，请腾出足够空间后重试；不要删除项目数据库。",
  EEXIST: "工作区所需目录被同名文件占用，请检查工作区及 .writing-agent/backups 路径。",
  ENOTDIR: "工作区所需路径不是目录，请检查工作区及 .writing-agent/backups 路径。",
  DESKTOP_RENDERER_NOT_READY: "客户端界面未能完成加载，请重试并反馈启动日志。",
  DESKTOP_RENDERER_FAILED: "客户端界面进程意外停止，程序将退出。请重新打开 Writing Agent；若再次出现，请反馈本地进程日志。已保存的项目仍保留，不要删除工作区或配置文件。",
  DESKTOP_START_FAILED: "客户端启动未完成。请保留项目和配置文件，重试或反馈启动日志；不要删除工作区。",
};

export function describeDesktopStartupFailure(error: unknown): { code: string; message: string } {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : error instanceof Error ? error.message : "";
  const code = Object.hasOwn(STARTUP_ERRORS, candidate) ? candidate : "DESKTOP_START_FAILED";
  return { code, message: STARTUP_ERRORS[code]! };
}

/** Store only allowlisted diagnostics: raw exceptions can contain credentials or article text. */
export function recordDesktopStartupFailure(error: unknown, logDirectory: string, version: string): string {
  mkdirSync(logDirectory, { recursive: true });
  const path = join(logDirectory, "startup-errors.jsonl");
  appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), version,
    ...describeDesktopStartupFailure(error) })}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

const PROCESS_TYPES = new Set(["Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker", "Unknown"]);
const PROCESS_REASONS = new Set(["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]);

/** Attach before app.whenReady() so launch/GPU failures are observable as well. */
export function registerDesktopProcessDiagnostics(options: {
  readonly app: Pick<EventEmitter, "on">;
  readonly logDirectory: string;
  readonly version: string;
  readonly isExiting: () => boolean;
  readonly isMainRenderer: (webContents: unknown) => boolean;
  readonly reportRendererFailure: (error: unknown) => void;
}): void {
  function record(event: "child-process-gone" | "render-process-gone", details: unknown): string {
    const input = typeof details === "object" && details !== null
      ? details as Record<string, unknown> : {};
    // Never copy Electron's name/serviceName, a webContents URL, or raw detail fields.
    const type = event === "render-process-gone" ? "Renderer"
      : typeof input.type === "string" && PROCESS_TYPES.has(input.type) ? input.type : "Unknown";
    const reason = typeof input.reason === "string" && PROCESS_REASONS.has(input.reason)
      ? input.reason : "unknown";
    const exitCode = typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode)
      ? input.exitCode : null;
    const row = { timestamp: new Date().toISOString(), version: options.version, event, type, reason, exitCode };
    try {
      mkdirSync(options.logDirectory, { recursive: true });
      appendFileSync(join(options.logDirectory, "process-events.jsonl"), `${JSON.stringify(row)}\n`,
        { encoding: "utf8", mode: 0o600 });
    } catch {
      // A locked/unwritable profile must not prevent a renderer failure prompt.
      process.stderr.write(`${JSON.stringify(row)}\n`);
    }
    return reason;
  }
  options.app.on("child-process-gone", (_event: unknown, details: unknown) => {
    record("child-process-gone", details);
  });
  options.app.on("render-process-gone", (_event: unknown, webContents: unknown, details: unknown) => {
    const reason = record("render-process-gone", details);
    if (options.isExiting() || !options.isMainRenderer(webContents) || reason === "clean-exit" || reason === "killed") return;
    options.reportRendererFailure({ code: "DESKTOP_RENDERER_FAILED" });
  });
}
