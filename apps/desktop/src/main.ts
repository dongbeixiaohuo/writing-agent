import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeSnapshot,
} from "../../../packages/client-bridge/src/protocol.js";
import type {
  DesktopProviderProfileInput,
} from "./provider-profile.js";
import type {
  DesktopRpcMethod,
  DesktopRpcRequest,
  DesktopRpcResponse,
  DesktopPublicationSaveInput,
} from "../../../packages/client-bridge/src/desktop-bridge.js";
import { DESKTOP_RPC_METHODS } from "../../../packages/client-bridge/src/desktop-bridge.js";
import { inspectWorkspaceBackupFile } from "../../../packages/storage/src/index.js";
import { DesktopApplicationHost } from "./application-host.js";
import { NetworkAccessPolicy, SecureWebFetcher } from "../../../packages/runtime/tools/src/index.js";
import { parseDesktopProviderProfileInput } from "./provider-profile.js";
import { dispatchDesktopRpc, safeDesktopFailure } from "./rpc-host.js";
import { resolveDesktopRunEnvironment } from "./run-environment.js";
import {
  DESKTOP_APP_ORIGIN,
  DESKTOP_BRIDGE_CHANNEL,
  DESKTOP_SNAPSHOT_CHANNEL,
  createSecureWebPreferences,
  isAllowedNavigation,
  isTrustedIpcSender,
  resolveRendererAsset,
} from "./security-policy.js";
import { claimDesktopSingleInstance } from "./single-instance.js";
import { replaceWorkspaceDatabaseFromBackup } from "./workspace-restore.js";

const APP_ID = "com.dongbeixiaohuo.writingagent";
const RPC_METHODS = new Set<DesktopRpcMethod>(DESKTOP_RPC_METHODS);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

protocol.registerSchemesAsPrivileged([{
  scheme: "writing-agent",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false,
    stream: true,
  },
}]);
app.enableSandbox();
app.setName("Writing Agent");

const runEnvironment = resolveDesktopRunEnvironment({
  tempPath: app.getPath("temp"),
  smokeId: process.env.WRITING_AGENT_DESKTOP_SMOKE,
  testId: process.env.WRITING_AGENT_DESKTOP_TEST,
});
const smokeNonce = runEnvironment.mode === "smoke" ? runEnvironment.id : null;
if (runEnvironment.disableHardwareAcceleration) app.disableHardwareAcceleration();
if (runEnvironment.disableHardwareAcceleration) app.commandLine.appendSwitch("disable-gpu");
const userDataPath = runEnvironment.root === null
  ? join(app.getPath("appData"), "Writing Agent")
  : join(runEnvironment.root, "user-data");
app.setPath("userData", userDataPath);
const workspacePath = runEnvironment.root === null
  ? join(app.getPath("documents"), "Writing Agent", "Workspace")
  : join(runEnvironment.root, "workspace");
const providerProfilePath = join(app.getPath("userData"), "provider.json");

let mainWindow: BrowserWindow | null = null;
let host: DesktopApplicationHost | null = null;
let hostUnsubscribe: (() => void) | null = null;
let quitting = false;
// The window close button asks first; app.quit() paths set this to skip the prompt.
let allowClose = false;
let rendererHandshakeResolve: (() => void) | null = null;
const rendererHandshakeCompleted = new Promise<void>((resolve) => {
  rendererHandshakeResolve = resolve;
});
let preparedRestore: {
  readonly backupPath: string;
  readonly confirmationHash: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly projectCount: number;
} | null = null;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function restartDesktopAfterResponse(): void {
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 600);
}

function extension(path: string): string {
  const match = path.match(/(\.[A-Za-z0-9]+)$/u);
  return match?.[1]?.toLowerCase() ?? "";
}

function request(value: unknown): DesktopRpcRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { protocolVersion?: unknown; method?: unknown; args?: unknown };
  if (
    candidate.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION ||
    typeof candidate.method !== "string" ||
    !RPC_METHODS.has(candidate.method as DesktopRpcMethod) ||
    !Array.isArray(candidate.args)
  ) return null;
  return candidate as DesktopRpcRequest;
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isTrustedIpcSender(frame.url);
}

function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(mainWindow, options);
}

function showSaveDialog(options: SaveDialogOptions) {
  return mainWindow === null
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(mainWindow, options);
}

async function handleRpc(
  event: IpcMainInvokeEvent,
  input: unknown,
): Promise<DesktopRpcResponse> {
  if (!trustedSender(event)) {
    return { ok: false, error: { code: "IPC_SENDER_REJECTED", message: "IPC sender is not trusted" } };
  }
  const parsed = request(input);
  if (parsed === null) {
    return { ok: false, error: { code: "DESKTOP_REQUEST_INVALID", message: "Desktop request is invalid" } };
  }
  const currentHost = host;
  if (currentHost === null) {
    return { ok: false, error: { code: "DESKTOP_HOST_NOT_READY", message: "Desktop host is not ready" } };
  }
  try {
    if (parsed.method === 'searchStatus' || parsed.method === 'configureSearch' || parsed.method === 'testSearchConnection') {
      const result = parsed.method === 'searchStatus' ? await currentHost.searchStatus()
        : parsed.method === 'testSearchConnection' ? await currentHost.testSearchConnection(parsed.args[0] as 'parallel' | 'tavily')
        : await currentHost.configureSearch(parsed.args[0] as import('../../../packages/client-bridge/src/desktop-bridge.js').SearchSettingsInput);
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'savePublicationAs') {
      const input = parsed.args[0] as DesktopPublicationSaveInput;
      const result = await currentHost.savePublicationAs(input, async fileName => {
        const selected = await showSaveDialog({
          title: '导出文章 · 选择保存位置',
          defaultPath: join(app.getPath('documents'), fileName),
          filters: [{ name: input.format === 'html' ? '排版文章（浏览器打开）' : '纯文本文章', extensions: [input.format] }],
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        return selected.canceled || !selected.filePath ? null : selected.filePath;
      });
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'revealPublication') {
      if (typeof parsed.args[0] !== 'string') throw new Error('EXPORT_RECEIPT_NOT_FOUND');
      shell.showItemInFolder(currentHost.publicationSavedPath(parsed.args[0]));
      return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'revealProviderConfig') {
      shell.showItemInFolder(currentHost.providerConfigPath());
      return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "providerStatus") {
      if (parsed.args[0] !== undefined && parsed.args[0] !== 'summary') throw new Error('INVALID_ARGUMENT');
      return { ok: true, result: await currentHost.providerStatus(parsed.args[0]), snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'providerDetails') {
      if (typeof parsed.args[0] !== 'string') throw new Error('INVALID_ARGUMENT');
      return { ok: true, result: await currentHost.providerDetails(parsed.args[0]), snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "testProviderConnection") {
      return { ok: true, result: await currentHost.testProviderConnection(), snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "configureProvider") {
      const inputProfile: DesktopProviderProfileInput = parseDesktopProviderProfileInput(parsed.args[0]);
      const result = await currentHost.configureProvider(inputProfile);
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'selectProvider') {
      if (typeof parsed.args[0] !== 'string' || typeof parsed.args[1] !== 'string') throw new Error('DESKTOP_PROVIDER_INPUT_INVALID');
      const result = await currentHost.selectProvider(parsed.args[0], parsed.args[1]);
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === 'listProviderModels') {
      const result = await currentHost.listProviderModels(parseDesktopProviderProfileInput(parsed.args[0]));
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "previewDiagnostics") {
      const result = await currentHost.previewDiagnostics();
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "exportDiagnostics") {
      const confirmationHash = parsed.args[0];
      if (typeof confirmationHash !== "string" || !/^[a-f0-9]{64}$/u.test(confirmationHash)) {
        return { ok: false, error: { code: "DESKTOP_REQUEST_INVALID", message: "Desktop request is invalid" } };
      }
      const selected = await showSaveDialog({
        title: "导出脱敏诊断包",
        defaultPath: join(
          app.getPath("documents"),
          `writing-agent-diagnostics-${confirmationHash.slice(0, 8)}.zip`,
        ),
        filters: [{ name: "ZIP 诊断包", extensions: ["zip"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (selected.canceled || selected.filePath === undefined) {
        return { ok: true, result: { cancelled: true }, snapshot: currentHost.bridge.getSnapshot() };
      }
      const written = await currentHost.writeDiagnostics(selected.filePath, confirmationHash);
      return {
        ok: true,
        result: { cancelled: false, ...written },
        snapshot: currentHost.bridge.getSnapshot(),
      };
    }
    if (parsed.method === "selectLegacyMigrationSource") {
      const kind = parsed.args[0];
      if (kind !== "manifest" && kind !== "desktop_v0_1") {
        return { ok: false, error: { code: "DESKTOP_REQUEST_INVALID", message: "Desktop request is invalid" } };
      }
      if (kind === "manifest") {
        const selected = await showOpenDialog({
          title: "选择包含 run_manifest.json 的旧项目目录",
          properties: ["openDirectory"],
        });
        if (selected.canceled || selected.filePaths[0] === undefined) {
          return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
        }
        const result = currentHost.planLegacyImport({
          kind: "manifest",
          projectPath: selected.filePaths[0],
        });
        return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
      }
      const database = await showOpenDialog({
        title: "选择旧版桌面数据库",
        properties: ["openFile"],
        filters: [{ name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (database.canceled || database.filePaths[0] === undefined) {
        return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
      }
      const artifacts = await showOpenDialog({
        title: "选择旧版项目产物目录",
        properties: ["openDirectory"],
      });
      if (artifacts.canceled || artifacts.filePaths[0] === undefined) {
        return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
      }
      const result = currentHost.planLegacyImport({
        kind: "desktop_v0_1",
        databasePath: database.filePaths[0],
        artifactsRoot: artifacts.filePaths[0],
      });
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "applyLegacyMigration") {
      const planHash = parsed.args[0];
      if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/u.test(planHash)) {
        return { ok: false, error: { code: "DESKTOP_REQUEST_INVALID", message: "Desktop request is invalid" } };
      }
      const result = await currentHost.applyLegacyImport(planHash);
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    if (parsed.method === "backupWorkspace") {
      const day = new Date().toISOString().slice(0, 10);
      const selected = await showSaveDialog({
        title: "备份 Writing Agent 工作区",
        defaultPath: join(app.getPath("documents"), `writing-agent-workspace-${day}.sqlite3`),
        filters: [{ name: "Writing Agent 工作区备份", extensions: ["sqlite3"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (selected.canceled || selected.filePath === undefined) {
        return { ok: true, result: { cancelled: true }, snapshot: currentHost.bridge.getSnapshot() };
      }
      const written = await currentHost.writeWorkspaceBackup(selected.filePath);
      return {
        ok: true,
        result: { cancelled: false, ...written },
        snapshot: currentHost.bridge.getSnapshot(),
      };
    }
    if (parsed.method === "selectWorkspaceRestoreBackup") {
      const selected = await showOpenDialog({
        title: "选择 Writing Agent 工作区备份",
        properties: ["openFile"],
        filters: [{ name: "Writing Agent 工作区备份", extensions: ["sqlite3"] }],
      });
      if (selected.canceled || selected.filePaths[0] === undefined) {
        preparedRestore = null;
        return { ok: true, result: null, snapshot: currentHost.bridge.getSnapshot() };
      }
      const backupPath = selected.filePaths[0];
      const inspection = inspectWorkspaceBackupFile(backupPath);
      if (!inspection.ok) {
        throw Object.assign(new Error(inspection.message), { code: inspection.code });
      }
      if (!inspection.supported) {
        throw Object.assign(new Error("Backup schema is not supported"), { code: "SCHEMA_UNSUPPORTED" });
      }
      const byteLength = statSync(backupPath).size;
      const sha256 = await sha256File(backupPath);
      const confirmationHash = createHash("sha256")
        .update(JSON.stringify({ sha256, byteLength, schemaVersion: inspection.schemaVersion, projectCount: inspection.projectCount }), "utf8")
        .digest("hex");
      preparedRestore = {
        backupPath,
        confirmationHash,
        fileName: basename(backupPath),
        byteLength,
        sha256,
        schemaVersion: inspection.schemaVersion,
        projectCount: inspection.projectCount,
      };
      return {
        ok: true,
        result: {
          confirmationHash,
          confirmationPhrase: "恢复工作区",
          fileName: preparedRestore.fileName,
          byteLength,
          sha256,
          schemaVersion: inspection.schemaVersion,
          projectCount: inspection.projectCount,
        },
        snapshot: currentHost.bridge.getSnapshot(),
      };
    }
    if (parsed.method === "applyWorkspaceRestore") {
      const [confirmationHash, confirmationPhrase] = parsed.args;
      const restore = preparedRestore;
      if (
        restore === null ||
        typeof confirmationHash !== "string" ||
        confirmationHash !== restore.confirmationHash ||
        confirmationPhrase !== "恢复工作区"
      ) {
        throw Object.assign(new Error("Workspace restore confirmation does not match"), { code: "RESTORE_CONFIRMATION_MISMATCH" });
      }
      const inspection = inspectWorkspaceBackupFile(restore.backupPath);
      if (!inspection.ok || !inspection.supported) {
        const code = inspection.ok ? "SCHEMA_UNSUPPORTED" : inspection.code;
        throw Object.assign(new Error("Selected backup is no longer valid"), { code });
      }
      const freshSize = statSync(restore.backupPath).size;
      const freshSha256 = await sha256File(restore.backupPath);
      if (freshSize !== restore.byteLength || freshSha256 !== restore.sha256) {
        throw Object.assign(new Error("Selected backup changed after preview"), { code: "RESTORE_CONFIRMATION_STALE" });
      }

      const safetyDirectory = join(workspacePath, ".writing-agent", "restore-backups");
      mkdirSync(safetyDirectory, { recursive: true });
      const safetyPath = join(
        safetyDirectory,
        `before-restore-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.sqlite3`,
      );
      const safety = await currentHost.writeWorkspaceBackup(safetyPath);
      const snapshot = currentHost.bridge.getSnapshot();
      hostUnsubscribe?.();
      hostUnsubscribe = null;
      currentHost.close();
      host = null;
      preparedRestore = null;
      try {
        const closedSize = statSync(restore.backupPath).size;
        const closedSha256 = await sha256File(restore.backupPath);
        if (closedSize !== restore.byteLength || closedSha256 !== restore.sha256) {
          throw Object.assign(new Error("Selected backup changed before restore"), { code: "RESTORE_CONFIRMATION_STALE" });
        }
        await replaceWorkspaceDatabaseFromBackup({
          workspacePath,
          backupPath: restore.backupPath,
        });
      } catch (error) {
        restartDesktopAfterResponse();
        throw error;
      }
      restartDesktopAfterResponse();
      return {
        ok: true,
        result: {
          restarting: true,
          restoredProjectCount: inspection.projectCount,
          safetyBackupFileName: safety.fileName,
          safetyBackupSha256: safety.sha256,
        },
        snapshot,
      };
    }
    if (parsed.method === "deleteProject") {
      const [projectId, confirmedName] = parsed.args;
      if (
        typeof projectId !== "string" || projectId.trim().length === 0 ||
        typeof confirmedName !== "string" || confirmedName.trim().length === 0
      ) {
        return { ok: false, error: { code: "DESKTOP_REQUEST_INVALID", message: "Desktop request is invalid" } };
      }
      const result = await currentHost.deleteProject(projectId, confirmedName);
      return { ok: true, result, snapshot: currentHost.bridge.getSnapshot() };
    }
    const response = await dispatchDesktopRpc(currentHost.bridge, parsed);
    if (parsed.method === "handshake") {
      rendererHandshakeResolve?.();
      rendererHandshakeResolve = null;
    }
    return response;
  } catch (error) {
    return safeDesktopFailure(error);
  }
}

function broadcast(snapshot: BridgeSnapshot): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_SNAPSHOT_CHANNEL, snapshot);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Writing Agent",
    backgroundColor: "#f7f7f5",
    autoHideMenuBar: true,
    webPreferences: createSecureWebPreferences(join(__dirname, "preload.cjs")),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => {
    if (runEnvironment.showWindow) window.show();
  });
  if (runEnvironment.mode === 'test') {
    const testTitle = `Writing Agent · ${app.getVersion()} 桌面体验测试（独立数据）`;
    window.setTitle(testTitle);
    window.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle(testTitle);
    });
  }
  if (runEnvironment.mode === 'production') {
    window.on('close', (event) => {
      if (allowClose) return;
      event.preventDefault();
      void dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['最小化', '退出程序', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: '关闭 Writing Agent',
        message: '最小化窗口，还是退出程序？',
        detail: '最小化后程序留在任务栏继续运行；退出会结束当前写作运行，已保存的内容仍保留。',
      }).then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 0) window.minimize();
        if (response === 1) { allowClose = true; window.close(); }
      }).catch(() => undefined);
    });
  }
  void window.loadURL(`${DESKTOP_APP_ORIGIN}/index.html`);
  return window;
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  if (smokeNonce === null || runEnvironment.root === null || host === null) return;
  await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
  await Promise.race([
    rendererHandshakeCompleted,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  // Let Electron deliver the renderer's handshake response before smoke teardown removes IPC handlers.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const handshake = await host.bridge.handshake();
  const resultPath = join(app.getPath("temp"), `writing-agent-desktop-smoke-result-${smokeNonce}.json`);
  writeFileSync(resultPath, `${JSON.stringify({
    status: "ready",
    productName: app.getName(),
    appId: APP_ID,
    url: window.webContents.getURL(),
    protocolVersion: handshake.protocolVersion,
    workspaceId: handshake.workspaceId,
    electron: process.versions.electron,
    node: process.versions.node,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  host.close();
  host = null;
  app.quit();
}

async function start(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId("com.dongbeixiaohuo.writingagent");
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );

  const rendererRoot = join(__dirname, "renderer");
  protocol.handle("writing-agent", async (protocolRequest) => {
    try {
      const assetPath = resolveRendererAsset(rendererRoot, protocolRequest.url);
      const data = readFileSync(assetPath);
      const headers = new Headers({
        "content-type": CONTENT_TYPES[extension(assetPath)] ?? "application/octet-stream",
        "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
      });
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });

  mkdirSync(workspacePath, { recursive: true });
  host = new DesktopApplicationHost({
    workspacePath,
    providerProfilePath,
    applicationVersion: app.getVersion(),
    applicationBuild: "writing-agent-desktop-v1",
    // Identify the installed browser honestly; no session cookies are copied.
    // Public WeChat article HTML can exceed 2 MiB even when its text is short.
    authorWebFetcher: new SecureWebFetcher({ policy: new NetworkAccessPolicy({ allowHttp: true }),
      userAgent: session.defaultSession.getUserAgent(), maxBytes: 8 * 1024 * 1024 }),
  });
  hostUnsubscribe = host.subscribe(broadcast);
  ipcMain.handle(DESKTOP_BRIDGE_CHANNEL, handleRpc);
  mainWindow = createWindow();
  mainWindow.on("closed", () => { mainWindow = null; });
  await runSmoke(mainWindow);
}

const ownsInstance = runEnvironment.mode !== "production" || claimDesktopSingleInstance(app, () => {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (ownsInstance) {
  app.on("activate", () => {
    if (mainWindow === null && app.isReady()) mainWindow = createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (quitting) return;
    quitting = true;
    hostUnsubscribe?.();
    hostUnsubscribe = null;
    host?.close();
    host = null;
    ipcMain.removeHandler(DESKTOP_BRIDGE_CHANNEL);
  });
  void start().catch((error: unknown) => {
    process.stderr.write(`Writing Agent desktop failed: ${error instanceof Error ? error.name : "DESKTOP_START_FAILED"}\n`);
    app.exit(1);
  });
}
