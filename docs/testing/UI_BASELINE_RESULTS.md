# WA-025 DSH 派生 UI 与 Bridge 一致性结果

执行日期：2026-09-18  
分支：`next/runtime`  
固定上游：`deepseek-ai/deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`  
结果：`PASS_LOCAL_WEB_AND_BRIDGE_SCOPE`

## 1. 结论

WA-025 已完成本地 Web 范围的 DSH 派生 UI 视觉、交互与 Bridge 一致性验收。上游参考、显式 Mock 和真实 Application Service 三条入口在同一 Windows 主机、同一 Playwright Chromium 中运行；安全设置文案调整后于 2026-09-18 重新生成并通过 15 张截图、SHA-256 和机器报告，证据保存在 `output/playwright/wa025/`。production 页面通过随机 loopback Local Web Host 读取真实持久状态，测试期间 Provider 调用数为 0。

本轮发现并修复两个会造成假状态的真实问题：

- 原生 browser `fetch` 被存入私有字段后以 Bridge 实例作为接收者调用，Chromium 会在请求发出前抛出 `Illegal invocation`；现在只对默认原生 `fetch` 使用 `globalThis.fetch.bind(globalThis)`，并有回归测试。
- Web Bridge 曾允许迟到的旧 generation 或同 generation 低 revision snapshot 覆盖新状态；现在只接受 generation/revision 单调不回退的 snapshot，断线标记也不再伪造服务端 revision。

## 2. 环境与证据

| 项 | 实际值 |
|---|---|
| OS | Windows `10.0.26200` |
| Browser | Playwright Chromium `143.0.7499.4` |
| deviceScaleFactor | `1` |
| 视口 | `1440×900`、`1280×800` |
| 主题 | light、dark、system 跟随切换 |
| 动效 | `prefers-reduced-motion: reduce` |
| 上游入口 | 隔离 checkout 的 `preview.html?preview-fixture=vfs-example` |
| 派生 Mock | `npm run ui:dev:mock`，页面显式标记未接真实写作 |
| 正式入口 | WA-025 临时 SQLite workspace + 随机 `127.0.0.1` Local Web Host |

权威机器结果：

- `output/playwright/wa025/WA025_REPORT.json`
- `output/playwright/wa025/SHA256SUMS.txt`
- `tests/ui-baseline/fixtures/wa025-content.json`
- `tests/ui-baseline/fixtures/wa025-local-host.ts`
- `tests/ui-baseline/scripts/wa025_ui_playwright.py`

上游 preview 自身仍会请求两个可选端点并得到 404：`/open-in-app/apps`、`/plugins/events`。脚本只允许这两个已知上游失败；派生 Mock 和成功的正式入口不得有未分类 HTTP、页面或 console 错误。项目/设置切换与长轮询并发时，正式 Host 可以精确返回 `/api/v6/events/poll` 的 `409 STALE_CLIENT_GENERATION`；脚本仅允许该路由/状态组合并要求最终状态正确，其他 409 不在白名单内。重复验收中曾实际触发 2 次该竞态并补读恢复；最终留档运行计数为 0，确定性单测继续覆盖旧 generation 响应。

## 3. 视觉结果

上游与派生版的主框架均为 `280px + 1160px + 0px`；侧栏宽度和中心起点差为 0，composer 编辑区域宽度差为 `14.39px`，设置对话框宽度差为 0。派生版设置对话框高度为 640px，上游为 800px，这是已批准的账户、更新、遥测和插件入口裁剪，不改变两栏结构或可达性。

WA-023 像素基线使用 RGB 单通道差值阈值 16；不使用遮罩。changed pixel ratio 上限为 2%，mean channel delta 上限为 2.0：

| 场景 | changed pixel ratio | mean channel delta | 结果 |
|---|---:|---:|---|
| chat light 1440×900 | 0.099% | 0.176 | PASS |
| chat dark 1440×900 | 0.102% | 0.140 | PASS |
| chat dark 1280×800 | 0.129% | 0.176 | PASS |
| settings light 1440×900 | 0.541% | 0.635 | PASS |
| settings dark 1440×900 | 0.010% | 0.256 | PASS |

允许变化只来自 WA-024 已登记的“预览→演示”标签和“稿件预览→稿件与版本”入口文字；没有扩大阈值或增加区域遮罩。

## 4. 交互与真实状态结果

| 范围 | 实际操作 | 结果 |
|---|---|---|
| Mock | 选择项目/会话、发送确定性消息、light/dark/system、Esc 关闭设置、打开/关闭写作工作台 | PASS；无外部请求，Mock 明示且只读 |
| 写作面板 | 稿件/差异、核查/来源、锁定块和跨项目重挂载 | PASS；Mock 锁定/修改按钮保持禁用，跨项目无正文泄漏 |
| 正式 Bridge | 一次性 bootstrap、v6 handshake、snapshot/poll、真实项目切换 | PASS；仅随机 loopback，同源 capability |
| 版本保护编辑 | 锁定第一块、修改第二块、生成差异、接受并创建 v2 | PASS；UI 只在 Application Service 返回提交结果后更新 |
| 事实门禁 | 编辑前读取 `passed`，正文变化后读取 `stale` 和失效记录 | PASS；历史通过未被继续显示为当前通过 |
| 项目隔离 | 切到无正文项目，再切回原项目 | PASS；正文/编辑状态未跨项目传播 |
| 设置持久化 | 保存 dark + 16px、整页 reload、重新握手 | PASS；主题和字号从 Host 文件恢复 |
| 网络/Provider | 记录全部浏览器请求和 fixture provider 调用 | PASS；仅 `127.0.0.1`，Provider 0 次 |

Bridge 自动测试还覆盖：原生 fetch 接收者、迟到旧 generation、同 generation 低 revision、协议版本不兼容 fail closed、轮询暂时断线后补读且不调用 `run.start`/`run.resume`。

## 5. 验收映射

| 验收 | 结果 | 证据与边界 |
|---|---|---|
| AT-31 | `PASS` | 独立自有 UI/Host；Mock 显式；无旧页面、外部 DSH Host 或真实用户数据 |
| AT-32 | `PASS_LOCAL_MATRIX` | 固定上游与派生版明暗主题、双视口、结构和量化像素结果 |
| AT-33 | `PASS` | 面板挂载/关闭、项目切换、锁定/差异/事实失效和隔离 |
| AT-34 | `PASS_WEB_SCOPE` | 集中品牌/主题/布局、设置持久化、示例扩展与 production 分发隔离 |
| AT-35 | `PASS` | reconnect、旧 generation、低 revision、协议不兼容及无隐式恢复 |
| AT-36 | `PASS_WEB_SCOPE` | 自有品牌、无上游账户/更新/遥测、无外部网络；desktop 身份留给 WA-017 |

## 6. 可复现命令

先完成固定上游依赖与 preview build（WA-023 已记录），然后从仓库根目录执行：

```powershell
npm run ui:build
npm run ui:build:mock
$upstreamDist = "$env:USERPROFILE\.codex\upstreams\deepseek-harness-0d1f500\apps\web\dist"
python -X utf8 tests/ui-baseline/scripts/wa025_ui_playwright.py --serve-static --upstream-dist "$upstreamDist"
```

Bridge 与分发回归：

```powershell
npm run test:bridge
npm run check:ui
```

`--serve-static` 在随机 loopback 端口直接托管两套已构建静态产物，并在脚本退出时关闭服务器，不依赖开发服务器或残留固定端口。上游 cold-start 的 WebWorker 镜像按上游自身 e2e 门限允许最多 240 秒；脚本会处理 fixture 的首次 API Key 引导和内测声明，但不会绕过未知遮罩或把空白页写成通过。

## 7. 明确未执行

- Electron `appId`、preload/IPC、`contextIsolation`、导航、安装/卸载和更新身份：`NOT_RUN_WA017`。
- Windows 安装包、干净机、自包含 runtime 与签名：`NOT_RUN_WA017_WA018`。
- Firefox、WebKit、移动端、macOS/Linux 桌面：`NOT_RUN`，不声明兼容。
- OS 级 200% 文本缩放和屏幕阅读器人工流程：`NOT_RUN`；本轮只验证 13/14/16px 应用字号、双视口与 reduced-motion。
- 真实商业模型/真实 Key/外部检索：`NOT_RUN_NO_AUTHORIZATION`；本轮不评价模型质量。
- 远端 CI、commit、push、PR、Release 与人工签收：未执行。

后续状态（2026-09-18）：WA-017 同源 Electron 壳、安装包及本机安装/启动/卸载已完成，详见 `WA017_RESULTS.md`。本文件的 Web 视觉结论仍不替代 WA-018 的独立干净机与人工全旅程。
