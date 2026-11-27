import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../../packages/client-bridge/src/protocol.js';

const root = resolve("apps/desktop");

test("clean Windows CI installs Electron before running real desktop tests", () => {
  for (const [file, validation] of [
    ["packaging.yml", "- name: Validate desktop host"],
    ["desktop-rc.yml", "- run: npm run check:desktop"],
  ] as const) {
    const workflow = readFileSync(resolve(".github/workflows", file), "utf8");
    const install = workflow.indexOf("- run: node node_modules/electron/install.js");
    assert.ok(install >= 0, `${file} must explicitly install Electron 44 (no postinstall)`);
    assert.ok(install < workflow.indexOf(validation), `${file} must install before testing`);
  }
});

test("candidate validation includes search safety and conversation rendering regressions", () => {
  const { scripts } = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(scripts["check:runtime"]!, /npm run test:fact-search(?:\s|$)/u);
  assert.match(scripts["test:ui"]!, /packages\/ui\/test\/conversation-readability\.test\.ts/u);
});

test("desktop package preserves its NSIS identity and emits update metadata without publishing", async () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    productName: string;
    main: string;
  };
  assert.deepEqual(packageJson, {
    ...packageJson,
    name: "writing-agent-desktop",
    version: "1.0.0-rc.118",
    productName: "Writing Agent",
    main: "dist/main.cjs",
  });

  // @ts-expect-error The executable builder config intentionally has no runtime type package.
  const imported = await import("../electron-builder.config.mjs");
  const config = imported.default as {
    appId: string;
    productName: string;
    publish: unknown;
    forceCodeSigning: boolean;
    win: { target: readonly string[]; signExecutable: boolean };
    nsis: Record<string, unknown>;
  };
  assert.equal(config.appId, "com.dongbeixiaohuo.writingagent");
  assert.equal(config.productName, "Writing Agent");
  assert.deepEqual(config.publish, { provider: 'generic', url: 'https://github.com/dongbeixiaohuo/writing-agent/releases/download/', channel: 'latest' });
  const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(scripts['desktop:package']!, /--publish never/u);
  assert.deepEqual(config.win.target, ["nsis"]);
  assert.equal(config.win.signExecutable, Boolean(process.env.WRITING_AGENT_UPDATE_SIGNER_SHA256?.trim()));
  assert.equal(config.forceCodeSigning, config.win.signExecutable);
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
    "previous_ref:",
    "contents: read",
    "npm run check:runtime",
    "npm run check:ui",
    "npm run check:desktop",
    "npm run test:py",
    "npm run check:claude-runtime",
    "npm audit --omit=dev --audit-level=high",
    "check_document_pack.py",
    "apps/desktop/scripts/test_desktop_installer.ps1",
    "-PreviousInstallerPath",
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
    "Previous and current installer versions must differ",
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

test("external signing regenerates the feed and blockmap from the final bytes without changing the installer", () => {
  const directory = mkdtempSync(join(tmpdir(), "wa-signed-metadata-"));
  try {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const filename = `Writing-Agent-Setup-${version}-x64.exe`;
    const installer = join(directory, filename);
    const original = Buffer.alloc(33_000, 0x41);
    const signed = Buffer.concat([original, Buffer.from("fixture certificate table")]);
    for (const bytes of [original, signed]) {
      writeFileSync(installer, bytes);
      const run = spawnSync(process.execPath, [join(root, "scripts/signed-update-metadata.mjs"), directory], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(readFileSync(installer), bytes);
      const sha = createHash("sha512").update(bytes).digest("base64");
      const metadata = readFileSync(join(directory, "latest.yml"), "utf8");
      assert.ok(metadata.includes(`url: ${filename}\n    sha512: ${sha}\n    size: ${bytes.length}\n`));
      assert.ok(metadata.includes(`path: ${filename}\nsha512: ${sha}\n`));
      const blocks = JSON.parse(gunzipSync(readFileSync(`${installer}.blockmap`)).toString("utf8"));
      assert.equal(blocks.files[0].sizes.reduce((total: number, size: number) => total + size, 0), bytes.length);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.match(installerScript, /\[string\]\$PreviousInstallerPath/u);
  assert.match(installerScript, /test_desktop_upgrade\.ps1/u);
  assert.match(installerScript, /中文 安装/u);

  const directory = mkdtempSync(join(tmpdir(), "wa-checksum-"));
  try {
    const installer = join(directory, "Writing-Agent-Setup-1.0.0-rc.58-x64.exe");
    const blockmap = `${installer}.blockmap`;
    const historicalInstaller = join(directory, "Writing-Agent-Setup-1.0.0-rc.57-x64.exe");
    const historicalBlockmap = `${historicalInstaller}.blockmap`;
    const sourceManifest = join(directory, "source-manifest.json");
    writeFileSync(installer, "installer", "utf8");
    const updateManifest = join(directory, 'latest.yml');
    const installerHash = createHash('sha512').update('installer').digest('base64');
    const installerName = 'Writing-Agent-Setup-1.0.0-rc.58-x64.exe';
    writeFileSync(updateManifest, `version: 1.0.0-rc.58\nfiles:\n  - url: ${installerName}\n    sha512: ${installerHash}\n    size: 9\npath: ${installerName}\nsha512: ${installerHash}\n`, 'utf8');
    writeFileSync(blockmap, "blockmap", "utf8");
    writeFileSync(historicalInstaller, "historical-installer", "utf8");
    writeFileSync(historicalBlockmap, "historical-blockmap", "utf8");
    writeFileSync(sourceManifest, JSON.stringify({
      product: "Writing Agent",
      version: "1.0.0-rc.58",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    }), "utf8");
    const run = () => spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ArtifactDirectory",
      directory,
      "-Version",
      "1.0.0-rc.58",
      "-SourceManifestPath",
      sourceManifest,
    ], { encoding: "utf8", env: { ...process.env, WRITING_AGENT_UPDATE_SIGNER_SHA256: '' } });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const sums = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8");
    for (const [path, name] of [[installer, "Writing-Agent-Setup-1.0.0-rc.58-x64.exe"], [blockmap, "Writing-Agent-Setup-1.0.0-rc.58-x64.exe.blockmap"], [updateManifest, 'latest.yml']] as const) {
      const expected = createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.match(sums, new RegExp(`${expected}  ${name.replaceAll(".", "\\.")}`, "u"));
    }
    assert.equal(sums.includes("1.0.0-rc.57"), false, "historical artifacts leaked into current checksum set");
    const buildManifest = JSON.parse(readFileSync(join(directory, "build-manifest.json"), "utf8")) as {
      version: string;
      sourceRevision: string;
      artifacts: string[];
      checksumFile: string;
    };
    assert.deepEqual(buildManifest, {
      version: "1.0.0-rc.58",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      artifacts: [
        "Writing-Agent-Setup-1.0.0-rc.58-x64.exe",
        "Writing-Agent-Setup-1.0.0-rc.58-x64.exe.blockmap",
        'latest.yml',
      ],
      checksumFile: "SHA256SUMS.txt",
    });
    writeFileSync(installer, 'changed installer', 'utf8');
    assert.notEqual(run().status, 0, 'metadata for a different installer must fail packaging');
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

test("upgrade smoke validates the current bridge protocol rather than the prior RC protocol", () => {
  const upgradeScript = readFileSync(resolve(root, "scripts/test_desktop_upgrade.ps1"), "utf8");
  assert.match(upgradeScript, new RegExp(`\\[int\\]\\$ExpectedProtocolVersion = ${UI_BRIDGE_PROTOCOL_VERSION}`, 'u'));
  assert.match(upgradeScript, /-ExpectedProtocolVersion \$ExpectedProtocolVersion/u);
});

test("desktop shell allows only the fixed update entry and preserves renderer navigation restrictions", () => {
  const mainSource = readFileSync(resolve(root, "src/main.ts"), "utf8");
  const preloadSource = readFileSync(resolve(root, "src/preload.ts"), "utf8");
  const source = [mainSource, preloadSource].join("\n");
  assert.equal(mainSource.match(/shell\.openExternal\(/gu)?.length, 1);
  assert.match(mainSource, /openRelease: url => shell\.openExternal\(url\)/u);
  assert.match(mainSource, /!trustedSender\(event\) \|\| event\.sender !== mainWindow\?\.webContents/u);
  for (const forbidden of [
    'autoUpdater',
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
