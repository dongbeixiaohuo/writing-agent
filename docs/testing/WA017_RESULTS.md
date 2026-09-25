# WA-017 桌面分发结果

日期：2026-09-19  
结论：`COMPLETE_LOCAL`；Windows x64 自包含 RC 的分发闭包、固定安装身份、历史升级/卸载机制与当前 rc.6 打包后启动均有本机证据。rc.5 → rc.6 精确原位升级和独立干净机仍待最终验收，未在这里冒充完成。

## 1. 交付闭包

- `apps/desktop/`：Electron 44 最小壳、自有 appId/数据目录、自定义 `writing-agent://app` 协议、固定 RPC allowlist。
- `packages/client-bridge/src/desktop-bridge.ts`：协议 v17 的受限 preload bridge；renderer 不直接访问文件、进程、数据库或 provider，并保留显式项目选择、共创反馈与 HTML 排版参数。
- `apps/desktop/scripts/build-desktop.mjs`：捆绑 Writing Agent Application Service、SQLite runtime 和 production renderer；排除 source map、Python、Tauri、DSH/Claude host 与旧 `App.tsx`。
- `apps/desktop/scripts/test_desktop_installer.ps1`、`apps/desktop/scripts/test_desktop_upgrade.ps1`、`apps/desktop/scripts/run_desktop_smoke.ps1`：真实 NSIS 安装、上一候选原位升级、缺失登记恢复、打包后启动握手与卸载验证；隔离安装测试同时检查卸载登记和快捷方式目标，升级测试会先备份并暂时移出测试前的真实快捷方式，在 `finally` 中原样恢复，防止历史安装器误识别用户孤儿安装。
- `SOURCE_AND_DEPENDENCY_MANIFEST.json`、包内 `SHA256SUMS.txt`、发行资产 `SHA256SUMS.txt`：来源、依赖和校验和。

桌面版本独立为 `1.0.0-rc.6`；仓库旧工作流根包继续为 `0.11.0`，避免把 RC 冒充旧插件升级。rc.1–rc.5 仅保留历史证据。

## 2. 安全边界

| 边界 | 实现与验证 |
|---|---|
| Renderer | `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、禁 webview/worker Node/不安全内容 |
| Preload | 仅暴露固定 bridge API；bundle 只含 `require("electron")`，不含 Node builtin |
| IPC | 固定 channel 与 method switch allowlist；校验协议版本和发送方 `writing-agent://app` |
| 导航/窗口 | 阻断远程导航、新窗口和权限请求；不调用 `shell.openExternal` |
| 静态资源 | 自定义协议只读取 renderer 根目录，拒绝编码/路径穿越 |
| 网络 | renderer 的 HTTP/HTTPS 请求被取消；模型网络仅由主进程按用户保存的 provider 配置发起 |
| 凭据 | API Key 进入 Windows Credential Manager 或会话内存；`provider.json` 只保存 `managed:desktop-primary` 引用 |
| 身份/更新 | `com.dongbeixiaohuo.writingagent`、固定 NSIS GUID `c03d2689-78a4-57b7-813e-a5d1cf38cbb8`、Writing Agent 数据目录；无 DSH 账户、遥测、插件市场或自动更新端点 |

自动验证：`npm run test:desktop` 23/23、`npm run check:desktop`、`node tests/check_desktop_distribution.mjs` 均通过；包含恢复交换、模型连接安全投影、Windows PowerShell 校验和与当前协议烟测。

## 3. 当前 RC 产物

本地产物（未提交、未上传）：

- `output/desktop/Writing-Agent-Setup-1.0.0-rc.6-x64.exe`
- 大小：111,340,408 bytes
- SHA-256：`11bfd315eeaca79ac548ac2cfc47cea5028341bce901ff6397a9d726e00531fa`
- 签名：`NotSigned`；`electron-builder` 明确设置 `signExecutable=false`
- 解包闭包：73 个文件，387,062,983 bytes；Electron/Chromium 运行时已包含

该 hash 只对应 2026-09-19 的 rc.6 本地候选。任何重建都必须重新生成并发布同批次 `SHA256SUMS.txt`。

## 4. 实机安装、启动、卸载

环境：Windows 11 企业版 64 位，build 26200，31.4 GiB RAM，Intel Core Ultra 7 255H；PowerShell 7.6.5；开发机 Node 24.18.0。应用内 Electron 为 44.0.0、Node 为 24.18.1。

rc.6 已将解包应用复制到 `%TEMP%` 的普通本地 ACL 路径后执行打包后 smoke：797 ms 内完成 `writing-agent://app/index.html`、协议 v17、Application Service 与隔离 SQLite workspace 握手，退出码 0、stdout/stderr 为空，证据为 `output/desktop-rc6-smoke.json`。隔离 test/smoke 模式不再争抢用户 production 单实例锁，因此不会关闭或接管现场程序。

以下是 rc.2 的历史独立安装证据。当前开发机已有用户运行中的 Writing Agent；NSIS 原位升级会关闭同名进程，所以本轮没有自动执行 rc.5 → rc.6 安装/卸载，而是将它列为最终用户关闭应用后的验收项。

历史执行：

```powershell
& apps/desktop/scripts/test_desktop_installer.ps1 `
  -InstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.2-x64.exe `
  -EvidencePath output/desktop-installer-test-rc2-final.json
```

实际结果：

| 检查 | 结果 |
|---|---|
| NSIS per-user 静默安装到隔离目录 | `PASS`，exit 0 |
| 安装后启动并等待 renderer `did-finish-load` | `PASS`，920 ms（隐藏 smoke，不等同人工“可操作时间”） |
| 产品/协议读回 | Writing Agent；`writing-agent://app/index.html`；protocol 16 |
| workspace | 创建独立 SQLite workspace，并完成 Application Service handshake |
| 中文安装路径额外验证 | `PASS`；`%LOCALAPPDATA%\Temp\写作Agent安装测试-rc4` 可启动和卸载 |
| 卸载 | `PASS`，应用文件移除，安装目录外证据保留 |

rc.4 → rc.5 正常登记和缺失登记两条升级路径另行执行：

```powershell
& apps/desktop/scripts/test_desktop_upgrade.ps1 `
  -PreviousInstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.4-x64.exe `
  -CurrentInstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.5-x64.exe `
  -EvidencePath output/desktop-upgrade-test-rc4-to-rc5.json

& apps/desktop/scripts/test_desktop_upgrade.ps1 `
  -PreviousInstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.4-x64.exe `
  -CurrentInstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.5-x64.exe `
  -EvidencePath output/desktop-orphan-upgrade-test-rc4-to-rc5.json `
  -SimulateOrphanedPreviousInstall
```

两条结果均为 `PASS`：注册完整时使用固定键 `c03d2689-78a4-57b7-813e-a5d1cf38cbb8`；删除 rc.4 旧登记后则从 Writing Agent 快捷方式找回原位置。旧目录专用文件均被移除，只保留一个 rc.5 卸载项；AppData、Workspace 与测试前快捷方式在升级及随后卸载后均保留；升级后的协议 v16 启动握手通过。这证明固定安装身份和两阶段升级机制，但不替代 rc.5 → rc.6 当前二进制的用户验收。用户不需要先手工卸载旧版，只需先关闭正在运行的应用。

原生可见进度另用 `tests/ux/installer_upgrade_progress.py` 验收：安装页先出现“步骤 1/2：正在移除旧版本”，旧卸载程序成功返回后再出现“步骤 2/2：正在安装 Writing Agent 1.0.0-rc.5”。`output/installer-upgrade-progress-rc4-to-rc5.json` 记录两阶段窗口文本、截图、注册版本和清理读回；测试前后桌面/开始菜单快捷方式 hash 一致，临时注册表与目录均已移除。

回归过程曾发现历史 rc.3 安装器会从用户真实快捷方式找回 rc.2 孤儿安装，使第一次测试误替换用户现场。已备份后将现场恢复为 rc.2，移除测试新增的卸载登记，并二次读回应用版本、快捷方式、登记缺失状态和用户数据目录。测试脚本隔离修复后，rc.3 → rc.4 重跑通过，现场仍为测试前的 rc.2 孤儿安装。

开发仓库位于 OneDrive D 盘且目录 ACL 含特殊 SID 时，Electron 44 的 GPU/renderer 子进程在 Windows build 26200 触发 `0x80000003`；这与 Electron #51761/#52098 记录的 sandbox/ACL 签名一致。同一 binary 从 NSIS 安装到本地 C 盘继承正常 ACL 后，生产四步建稿、真实 provider 共创、导出和重启读回均通过。结论限定为开发目录 ACL，不推导为中文路径不兼容，也不以隐藏 smoke 替代可见 UI 验收。

## 5. PRD 映射

| 验收 | 状态 | 证据与限制 |
|---|---|---|
| AT-01 | `PARTIAL` | 自包含安装后启动通过；尚未在无开发工具的独立干净机执行真实写作 |
| AT-24 | `PASS_LOCAL` | 分发扫描无 DSH/Claude/Python/Tauri/旧 UI/node_modules/source map；普通依赖有 manifest |
| AT-25 | `PASS_LOCAL` | 包内示例/manifest/诊断边界扫描无 Key、私人正文或本机私有路径 |
| AT-30 | `PASS` | DSH 单实例 helper 精确 hash、MIT notice 与 Electron/Chromium notices 均入包 |
| AT-36 | `PASS_LOCAL` | 自有 appId/路径/品牌，无 updater/遥测/上游默认服务 |
| AT-37 | `PASS_LOCAL` | 包闭包无旧 Tauri/旧页面；迁移后的新 Bridge 可打开，打包同源 UI 已完成真实 Provider 全旅程 |
| AT-38 | `PASS_LOCAL` | sandbox/preload/IPC/协议/导航/路径/renderer 网络自动测试通过 |

## 6. 未宣称内容

- 未在另一台或全新 VM 上安装；未验证 Windows 10、低配/高 DPI、企业杀软策略和屏幕阅读器。
- 未购买代码签名证书，SmartScreen 体验未验收。
- Anthropic-compatible MiniMax-M3 已在 rc.2 隔离安装中跑完角色化共创、基于现稿修改、事实核查、杂志 HTML 导出和重启读回；OpenAI-compatible 商业端点及其他模型仍未验收。启动握手本身不产生模型费用。
- 未上传 GitHub Release、未改 `latest`、未创建 PR 或 tag。
