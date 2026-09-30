# WA-023 DSH UI 本地保真基线结果

执行日期：2026-09-17  
分支：`next/runtime`  
固定上游：`deepseek-ai/deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`  
结果：`PASS_LOCAL_BASELINE`

## 1. 结论

WA-023 已完成本地源码移植基线：10 个 DSH 主题/布局/侧栏/输入/Button 文件按字节精确复制并登记 SHA-256；自有 Web composition、品牌、Client Bridge v1 和确定性 Mock 可独立启动；正式构建默认 fail closed，不含 Mock fixture，也不连接外部 DSH/旧应用。上游与派生 UI 已在同一主机、同一 Chromium、同一视口/主题矩阵中真实运行并留存截图。

这只是 WA-023 当时的 UI 移植预览，不单独表示真实 Application Service、模型、稿件保存或事实核查完成，也不表示 Electron 安装包可用。后续 WA-011 至 WA-015 已接入业务闭环，WA-025 已完成本地 Web 自动行为与量化视觉回归；Electron 仍待 WA-017/018。

## 2. 上游可运行证据

隔离 checkout：`%USERPROFILE%\.codex\upstreams\deepseek-harness-0d1f500`

- `git rev-parse HEAD`：`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，detached、工作树干净。
- 上游 `pnpm-lock.yaml` SHA-256：`ca131858949bd12b2acfc227b1af7dfa3c8d65e74b234824d5c741e6421010a1`。
- `corepack pnpm@11.7.0 install --frozen-lockfile --ignore-scripts`：PASS，1288 packages；未执行上游 install scripts。
- 首次直接 `build:web` 因 preview worker 尚未生成而失败，按真实结果保留；随后 `build:lib` PASS、再次 `build:web` PASS、`@deepseek-ai/dsh-web-frontend build:preview` PASS，生成 7.20 MB `vfs-image.tar.gz`。
- 参考页面实际运行在本机 `127.0.0.1:4173`，未作为 Writing Agent 产品依赖。
- 上游 preview 控制台有两个可复现的可选端点 404：`/open-in-app/apps` 与 `/plugins/events`；页面主体仍可用。该结果不写成“零错误”。

## 3. 派生实现

| 范围 | 产物 |
|---|---|
| Web 入口 | `apps/web/index.html`、Vite config、production/mock 双构建 |
| UI composition | `packages/ui/src/shell/WritingAgentShell.tsx`、自有 CSS、品牌与图标 |
| 精确上游切片 | `packages/ui/src/upstream/` 下 10 个登记文件 |
| Bridge | `packages/client-bridge/src/protocol.ts` 与 `mock-bridge.ts` |
| 预览能力 | hero、项目/会话导航、消息/工具状态、composer、停止、主题/字号设置、只读稿件右栏、窄窗收放 |
| 正式边界 | production 只显示“客户端桥接尚未接入”，不会自动启用 Mock |

Mock 握手明确返回 `mock: true`、`persistsUserProjects: false`；跨项目 session 选择拒绝，取消后迟到结果不追加。派生页没有动态网络请求，Chromium 控制台最终复验为 0 error / 0 warning。

## 4. 浏览器与画面对照

环境：Windows 10/11 用户代理、HeadlessChrome 152.0.0.0、deviceScaleFactor 1。

| 场景 | 上游证据 | 派生证据 | 结论 |
|---|---|---|---|
| hero light 1440×900 | `upstream-hero-light-1440x900.png` | `derived-hero-light-1440x900.png` | 三列壳/中心 composer/侧栏节奏保留；品牌与写作文案按白名单替换 |
| chat light 1440×900 | `upstream-chat-light-1440x900.png` | `derived-chat-light-1440x900.png` | 对话、工具状态、底部 composer 和滚动区域可用 |
| settings light/dark 1440×900 | `upstream-settings-*-1440x900.png` | `derived-settings-*-1440x900.png` | 设置两栏结构、主题切换和 Esc 关闭通过 |
| chat dark 1440×900 / 1280×800 | 对应 `upstream-chat-dark-*` | 对应 `derived-chat-dark-*` | dark token 与两视口通过 |
| 窄窗 900×800 | 无新增上游截图 | `derived-narrow-expanded-light-900x800.png` | 自动折叠后可手动展开，修复首轮发现的窄窗 toggle 缺陷 |
| 只读稿件右栏 | 上游右栏结构参考 | `derived-preview-dark-1280x800.png` | 右栏占位与关闭通过；不冒充可编辑/已保存 |
| production | 不适用 | `production-fail-closed-1280x800.png` | 未接正式 Bridge 时 fail closed |

所有截图位于 `output/playwright/wa023/`，完整 SHA-256 在同目录 `SHA256SUMS.txt`。内容 fixture 的领域替换、品牌、安全裁剪和写作扩展见 `UI_CHANGE_ALLOWLIST.md`；本轮不以内容不同计算宽松像素阈值。

## 5. 自动检查

```powershell
npm run check:ui
```

覆盖：

- strict TypeScript；
- 7 项 Bridge/column 测试；
- production 与 mock 两套 Vite 构建；
- production bundle 不含 Mock 标记、旧 UI/Tauri、外部 DSH 端点或 `$DSH_HOME`；
- 10 个 copied file 的 SHA-256、registry、许可、品牌排除与目标目录完整性；
- production 仅保留 fail-closed 入口，mock bundle 明确保留预览标识。

## 6. 验收映射

| 验收 | WA-023 基线结果 | 证据/边界 |
|---|---|---|
| AT-30 来源、许可、上游测试 | `PASS` | 固定 commit、10 个 exact copy/hash、MIT notice、上游真实 build、来源测试 |
| AT-31 无旧应用/外部 DSH 启动 | `PASS` | 独立 mock 启动、醒目标识、production fail closed、bundle/source 扫描 |
| AT-32 明暗关键页面对照 | `PASS_BASELINE_SCOPE` | 同主机/浏览器/视口/状态类别截图，差异白名单；量化像素阈值已由 WA-025 收口 |
| AT-36 网络与身份 | `PASS_WEB_BASELINE_SCOPE` | 自有品牌、0 动态请求、无上游端点/Mock production 泄漏；desktop appId/更新/安装包留到 WA-017/018 |

## 7. 未完成与下一步

- WA-011：把同一 `ClientBridge` 类型接到已完成的 Application Service，提供真实 snapshot/send/cancel/readback。
- WA-024：补齐稿件/证据/版本/核查/导出等关键写作页面。
- WA-025：对完整页面做同 fixture 自动交互、可访问性、XSS/URL、流式/reconnect、像素差阈值与 desktop 网络/身份终验。
- 未 commit、push、开 PR、发布或修改生产环境。
