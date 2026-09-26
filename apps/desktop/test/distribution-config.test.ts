import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../../packages/client-bridge/src/protocol.js';

const root = resolve("apps/desktop");

test("desktop package owns its identity and produces an explicit unsigned NSIS artifact", async () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    productName: string;
    main: string;
  };
  assert.deepEqual(packageJson, {
    ...packageJson,
    name: "writing-agent-desktop",
    version: "1.0.0-rc.45",
    productName: "Writing Agent",
    main: "dist/main.cjs",
  });

  // @ts-expect-error The executable builder config intentionally has no runtime type package.
  const imported = await import("../electron-builder.config.mjs");
  const config = imported.default as {
    appId: string;
    productName: string;
    publish: unknown;
    win: { target: readonly string[]; signExecutable: boolean };
    nsis: Record<string, unknown>;
  };
  assert.equal(config.appId, "com.dongbeixiaohuo.writingagent");
  assert.equal(config.productName, "Writing Agent");
  assert.equal(config.publish, null);
  assert.deepEqual(config.win.target, ["nsis"]);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.nsis.guid, "c03d2689-78a4-57b7-813e-a5d1cf38cbb8");
  assert.equal(config.nsis.include, "../../build/installer.nsh");
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);

  const installerInclude = readFileSync(resolve(root, "build/installer.nsh"), "utf8");
  for (const required of [
    "!macro customInit",
    "IfSilent",
    "ReadRegStr $R8 HKCU",
    "ReadRegStr $R8 HKLM",
    "检测到已安装 Writing Agent",
    "将升级到 ${VERSION}",
    "保留项目、设置和模型凭据",
    "无需手工卸载旧版本",
    "customPageAfterChangeDir",
    "customCheckAppRunning",
    "Writing Agent.lnk",
    "waOrphanInstallPath",
    "/KEEP_APP_DATA",
    "旧安装记录不完整",
    "waPreviousInstallDetected",
    "步骤 1/2：正在移除旧版本",
    "1. 正在安全移除旧版本… 项目与设置会保留。",
    "步骤 2/2：正在安装 Writing Agent ${VERSION}",
    "1. 旧版本已移除    2. 正在安装新版本…",
    "customUnInstallCheck",
    "customUnInstallCheckCurrentUser",
    "waValidateRegisteredRemoval",
  ]) assert.equal(installerInclude.includes(required), true, required);

  const workflow = readFileSync(resolve(".github/workflows/desktop-rc.yml"), "utf8");
  for (const required of [
    "workflow_dispatch:",
    "contents: read",
    "npm run check:runtime",
    "npm run check:ui",
    "npm run check:desktop",
    "npm run test:py",
    "npm run check:claude-runtime",
    "npm audit --omit=dev --audit-level=high",
    "check_document_pack.py",
    "apps/desktop/scripts/test_desktop_installer.ps1",
    "actions/upload-artifact@v4",
  ]) assert.equal(workflow.includes(required), true, required);
  for (const forbidden of ["contents: write", "actions/create-release", "softprops/action-gh-release"])
    assert.equal(workflow.includes(forbidden), false, forbidden);

  const upgradeScript = readFileSync(resolve(root, "scripts/test_desktop_upgrade.ps1"), "utf8");
  for (const required of [
    "PreviousInstallerPath",
    "CurrentInstallerPath",
    "Assert-SingleRegistration",
    "previousInstallRemoved = 'PASS'",
    "appDataPreservedDuringUpgrade = 'PASS'",
    "appDataPreservedDuringUninstall = 'PASS'",
    "workspacePreservedDuringUpgrade = 'PASS'",
    "workspacePreservedDuringUninstall = 'PASS'",
    "existingShortcutsPreserved = 'PASS'",
    "SimulateOrphanedPreviousInstall",
    "orphanedPreviousInstallRecovered",
    "Remove-Item -LiteralPath $shortcutPath -Force",
    "Refusing to run the isolated upgrade test while a real Writing Agent shortcut is visible",
    "Start-Process -FilePath $FileName -ArgumentList $Arguments -PassThru",
  ]) assert.equal(upgradeScript.includes(required), true, required);
  assert.equal(upgradeScript.includes("$startInfo.ArgumentList"), false);

  const visibleProgressScript = readFileSync(resolve("tests/ux/installer_upgrade_progress.py"), "utf8");
  for (const required of [
    "步骤 1/2：正在移除旧版本",
    "步骤 2/2：正在安装 Writing Agent",
    "visibleSequence",
    "shortcutsUnchangedBeforeRestore",
    "testRegistrationRemoved",
    "testRootRemoved",
    "CSIDL_DESKTOPDIRECTORY",
  ]) assert.equal(visibleProgressScript.includes(required), true, required);
});

test("release checksum helper is self-contained under Windows PowerShell", {
  skip: process.platform !== "win32",
}, () => {
  const script = resolve(root, "scripts/write_release_checksums.ps1");
  const installerScript = readFileSync(resolve(root, "scripts/test_desktop_installer.ps1"), "utf8");
  const checksumScript = readFileSync(script, "utf8");
  assert.equal(checksumScript.includes("Get-FileHash"), false);
  assert.equal(installerScript.includes("Get-FileHash"), false);
  assert.match(checksumScript, /System\.Security\.Cryptography\.SHA256/u);
  assert.match(installerScript, /System\.Security\.Cryptography\.SHA256/u);
  assert.match(installerScript, /Get-ExistingWritingAgentShortcutTargets/u);

  const directory = mkdtempSync(join(tmpdir(), "wa-checksum-"));
  try {
    const installer = join(directory, "Writing-Agent-Setup-test.exe");
    const blockmap = `${installer}.blockmap`;
    writeFileSync(installer, "installer", "utf8");
    writeFileSync(blockmap, "blockmap", "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ArtifactDirectory",
      directory,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const sums = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8");
    for (const [path, name] of [[installer, "Writing-Agent-Setup-test.exe"], [blockmap, "Writing-Agent-Setup-test.exe.blockmap"]] as const) {
      const expected = createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.match(sums, new RegExp(`${expected}  ${name.replaceAll(".", "\\.")}`, "u"));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packaged smoke validates the current bridge protocol", () => {
  const smokeScript = readFileSync(resolve(root, "scripts/run_desktop_smoke.ps1"), "utf8");
  assert.match(smokeScript, new RegExp(`\\[int\\]\\$ExpectedProtocolVersion = ${UI_BRIDGE_PROTOCOL_VERSION}`, 'u'));
  assert.match(smokeScript, /\$result\.protocolVersion -ne \$ExpectedProtocolVersion/u);
  assert.equal(smokeScript.includes("$result.protocolVersion -ne 7"), false);
});

test("desktop shell contains no updater, external navigation, upstream runtime, or old Tauri path", () => {
  const mainSource = readFileSync(resolve(root, "src/main.ts"), "utf8");
  const preloadSource = readFileSync(resolve(root, "src/preload.ts"), "utf8");
  const source = [mainSource, preloadSource].join("\n");
  for (const forbidden of [
    "autoUpdater",
    "shell.openExternal",
    "@tauri-apps",
    "DSH_HOME",
    "dsh-app",
    "claude",
    "nodeIntegration: true",
    "sandbox: false",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /app\.setAppUserModelId\("com\.dongbeixiaohuo\.writingagent"\)/u);
  assert.match(source, /app\.setPath\("userData"/u);
  assert.match(mainSource, /runEnvironment\.mode !== "production" \|\| claimDesktopSingleInstance/u);
  assert.match(source, /setWindowOpenHandler/u);
  assert.match(source, /will-navigate/u);
  assert.match(source, /setPermissionRequestHandler/u);
  assert.match(source, /if \(runEnvironment\.disableHardwareAcceleration\) app\.disableHardwareAcceleration\(\)/u);
  assert.match(source, /if \(runEnvironment\.disableHardwareAcceleration\) app\.commandLine\.appendSwitch\("disable-gpu"\)/u);
  assert.equal(mainSource.includes("rmSync(smokeRoot"), false);
  assert.equal(preloadSource.includes('security-policy.js'), false);
  assert.equal(/from "node:/u.test(preloadSource), false);
});

test("single-instance helper stays an exact tracked copy of the fixed DSH upstream", () => {
  const registry = JSON.parse(readFileSync(resolve("upstream-sources.json"), "utf8")) as {
    upstreams: Array<{
      id: string;
      commit: string;
      components: Array<{
        id: string;
        status: string;
        copied_files: Array<{
          source_path: string;
          target_path: string;
          sha256: string;
          exact_copy: boolean;
        }>;
      }>;
    }>;
  };
  const upstream = registry.upstreams.find(candidate => candidate.id === "deepseek-harness");
  assert.ok(upstream);
  assert.equal(upstream.commit, "0d1f50007f9bca3f52b06e1c3074fa14d5fb0720");
  const component = upstream.components.find(candidate => candidate.id === "electron-shell-reference");
  assert.ok(component);
  assert.equal(component.status, "ported_verified");
  const copied = component.copied_files.find(candidate => candidate.target_path === "apps/desktop/src/single-instance.ts");
  assert.ok(copied);
  assert.deepEqual(copied, {
    source_path: "apps/desktop/src/single-instance.ts",
    target_path: "apps/desktop/src/single-instance.ts",
    sha256: "dc6a6e263a6fdedc3f1cfacb97eb6f60dd5b04ad5d3b02daae4640f2e30a5150",
    exact_copy: true,
  });
  const local = readFileSync(resolve(copied.target_path));
  assert.equal(createHash("sha256").update(local).digest("hex"), copied.sha256);
});
