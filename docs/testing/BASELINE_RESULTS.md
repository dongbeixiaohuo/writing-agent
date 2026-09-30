# M0 回归基线结果

执行日期：2026-09-16  
对应任务：WA-003  
分支：`next/runtime`  
源码基线：`ca01dcf989729a5c255bbb50b4b7896f3ef810a4`

## 1. 结论

M0 可在当前环境继续：需求包自检、legacy 全量回归、旧桌面 TypeScript 检查/Web 构建、规范迁移夹具和来源登记测试均通过。唯一环境跳过是旧 Tauri Rust 编译，因为本机未安装 Rust/Cargo；这不影响当前默认 Electron 路线，但若修改或重发旧桌面安装包，必须先补齐 Rust 工具链并单独验证。

本结果不表示 DSH UI 已移植、Electron 安装包已构建、真实模型已调用或文章质量已验证。

## 2. 环境

| 工具 | 实际版本/状态 |
|---|---|
| Windows PowerShell | 7.6.5 |
| Node.js | v24.18.0 |
| npm | 11.16.0 |
| Python | 3.11.8 |
| Git | 2.49.0.windows.1 |
| pnpm（当前仓库） | 10.32.1 |
| pnpm（DSH 固定 checkout，按 packageManager） | 11.7.0 |
| Cargo | `NOT_FOUND` |
| rustc | `NOT_FOUND` |

DSH 上游声明 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`；固定 checkout 中解析到的版本满足要求。

## 3. 需求包完整性

命令：

```powershell
$env:PYTHONUTF8='1'
python writing-agent-1.0-prd-v1.1-dsh-ui\tools\check_document_pack.py
```

结果：`PASS`

- backlog JSON 可解析，25 个任务。
- 依赖图无环，依赖均可解析。
- UI 并行线与 WA-011 汇合关系通过。
- 38 个验收场景及 requirement/acceptance ID 均可解析。
- Markdown fence、相对链接、来源 ID 和废弃路线检查通过。

## 4. Legacy 全量回归

命令：

```powershell
$env:PYTHONUTF8='1'
npm run check
```

结果：`PASS`

- Python：222 tests，`OK`，1 skipped，18.088 秒（最终复跑）。
- 跳过项：联网插件隔离安装测试仅在 `RUN_PLUGIN_INSTALL_TEST=1` 时执行；本轮未授权/不需要联网安装，按既有设计跳过。
- Python syntax：26 files，PASS。
- workflow contract：PASS。
- docs contract：PASS。
- `claude-runtime` 与消费端同步：PASS。
- Claude plugin manifest strict validation：PASS。
- marketplace manifest strict validation：PASS。

本轮新增的 7 个定向测试也单独执行：

```powershell
$env:PYTHONUTF8='1'
python -m unittest tests.test_legacy_fixtures tests.test_upstream_sources -v
```

结果：7 tests，`OK`，0.193 秒。覆盖：

- legacy manifest 的本地指针和 stale 状态；
- 无绑定旧 `passed` 必须 fail closed；
- 旧桌面 SQLite 表/列、`user_version=0`、无 foreign key 基线；
- 合成 `project.json` 不含密钥/真实用户路径；
- valid/unsupported/partial/stale snapshot/malformed 五类事实门禁夹具；
- 上游 registry 状态、OID/hash 格式和 notice/distribution 一致性。

测试开发过程中，`partial-support` 夹具最初使用了不被 `fact-check-v2` 接受的 claim type，定向测试按预期失败；改为当前契约允许的 `other` 后重新执行通过。未放宽生产门禁。

## 5. 旧桌面 0.1.0

命令：

```powershell
Set-Location writing-agent-app
npm run check
npm run build
```

结果：`PASS`

- `tsc -b`：PASS。
- Vite 8.0.3：114 modules transformed，PASS。
- `dist/index.html`：0.42 kB（gzip 0.28 kB）。
- CSS：19.38 kB（gzip 4.71 kB）。
- JS：403.74 kB（gzip 120.83 kB）。

`dist/` 为既有 ignore 范围，没有将构建产物加入版本控制。

旧 Tauri Rust 检查：`SKIPPED_ENV`

```text
cargo  NOT_FOUND
rustc  NOT_FOUND
```

这不是 Rust 编译通过。若后续需要修复/重发 legacy 0.1.0，须在安装匹配工具链后运行 `cargo check` 和安装包 smoke。

## 6. DSH 固定源码

只读 checkout：`%USERPROFILE%\.codex\upstreams\deepseek-harness-0d1f500`

核验：

- `git rev-parse HEAD` = `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。
- detached HEAD，工作树干净。
- 根版本 `0.1.6-alpha.1`，MIT。
- 已读取 root/client/docs 规则、架构、client/host/API、核心 runtime、UI 主题/布局/对话/预览/品牌和 desktop 文档/源码入口。
- 本轮未改上游 checkout，未把上游源码复制进产品树。

## 7. 真实旧数据只读核验

检查范围仅限 schema、PRAGMA 和表记录数：

| 数据目录 | profiles | projects | outputs | exports |
|---|---:|---:|---:|---:|
| `%APPDATA%\com.lanmeng.writingagentapp.preview0414` | 1 | 1 | 3 | 0 |
| `%APPDATA%\com.lanmeng.writingagentapp` | 2 | 8 | 50 | 4 |

未读取 API Key、文章正文或配置值；未启动旧应用、未写数据库、未执行迁移。

## 8. 未运行/不应误报

| 项目 | 状态 | 原因/归属 |
|---|---|---|
| 上游 DSH 完整 install/build/UI 启动 | `NOT_RUN` | WA-023 建立参考基线时执行 |
| 上游/派生 UI 截图和人工视觉验收 | `NOT_RUN` | WA-023/WA-025 |
| Writing Agent 自有 runtime 竖切面 | `NOT_IMPLEMENTED` | WA-005–011 |
| 真实 provider/API Key 调用 | `NOT_RUN` | 需实现 provider 且具备合法配置后执行 |
| Electron/Tauri 安装包与干净 Windows | `NOT_RUN` | M3；当前没有新桌面壳 |
| npm 公开命令/包 | `NOT_AVAILABLE` | 根包仍为 private，不提前宣布 |

## 9. WA-003 完成判据

- [x] 实际命令逐项记录 PASS/SKIPPED_ENV/NOT_RUN，不把跳过当通过。
- [x] 建立不含私人数据和 Key 的 legacy manifest 与旧桌面 schema 夹具。
- [x] 建立严格门禁的通过、阻断、损坏和 stale-binding 差分夹具。
- [x] 新夹具有自动测试，且纳入根 `npm run check`。
- [x] 保留旧数据源只读，未执行迁移或写入。
