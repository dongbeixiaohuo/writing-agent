# Writing Agent UI 主题、品牌与 Slot 扩展指南

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-024  
适用范围：DSH 派生 Web/Desktop 同一 production composition

## 1. 目标与边界

本项目保留 DSH 的主题 token、三列布局、基础控件和交互语义，在自有仓库内提供静态、可审计的扩展点。它不是 DSH 插件系统，也不是在线主题/插件市场。扩展与基础 UI 一起编译；production 不下载或执行远端 UI 代码。

四类调整入口如下：

| 调整内容 | 唯一入口 | 禁止进入 |
|---|---|---|
| 产品名、助手名、About 标题 | `packages/ui/src/brand/config.ts` | runtime、数据库实体、模型请求 |
| token 别名、字号与布局偏好 | `packages/ui/src/theme/config.ts` | agent loop、领域门禁、各页面散落硬编码 |
| Slot/面板契约 | `packages/ui/src/extensions/contracts.ts` | Provider、SQLite、事实判断 |
| 写作面板及注册表 | `packages/writing-ui/` | 基础 shell 的业务状态机、动态远端加载 |

`packages/ui/src/upstream/` 的精确上游副本没有因 WA-024 改写；原 CSS 标识、许可和 hash 映射继续由 `upstream-sources.json` 管理。本地派生层集中在 `brand/`、`theme/`、`extensions/`、shell composition 与 `packages/writing-ui/`。

## 2. Composition 结构

```text
apps/web/src/main.tsx
  ├─ createDefaultWritingUiRegistry()
  ├─ WritingAgentShell                   # 通用布局、导航、对话、设置、Slot host
  └─ ClientBridge                        # 唯一状态/命令边界

packages/writing-ui
  ├─ registry.ts                         # 静态注册、排序、重复/悬空引用校验
  └─ WritingWorkbenchPanel.tsx           # 稿件/差异/版本/核查/交付
```

默认注册表只有 `writing.workbench`。基础 shell 不再实现事实核查、修改接受或导出规则，只把 `bridge`、当前 `snapshot` 和 `closePanel` 交给面板。门禁状态仍由 Application/Storage 投影；浏览器不计算 `passed`。

面板实例 key 为 `panelId:projectId`。切换项目会重新挂载面板，清除编辑框、选中页签和错误等局部状态；领域状态仍从新项目的 bridge snapshot 读取。移除扩展会创建新的不可变 registry，不修改全局数组或其他页面。

## 3. 品牌、主题与布局

- 默认品牌：`WRITING_AGENT_BRAND`；用 `createBrandConfig({...})` 做局部覆盖，空名称会被拒绝。
- 默认主题：`WRITING_AGENT_THEME`；只覆盖 DSH/Writing Agent CSS 自定义属性，不改运行时。
- 明/暗/系统模式：`UiSettings.theme`；通过 Client Bridge v16 写入受保护 Host。
- 默认布局：`WRITING_AGENT_LAYOUT`；集中保存侧栏、右栏和自动折叠阈值，不改变 `computeColumns` 的上游几何契约。
- 正文字号与主题模式保存在当前 workspace 的 `.writing-agent/ui-settings.json`。文件只含 schema、主题模式和字号，无 Key、路径、正文或材料；临时文件写入后原子替换。损坏或未知值 fail closed，不静默伪造偏好。

恢复默认外观使用现有设置页选择“跟随系统”和“标准”字号；命令经过 `/api/v6/command/update-settings`，重开 bridge 后仍从 Host 读取同一值。Mock 只在内存中变化，不写真实工作区。

## 4. 新增内部扩展

扩展是一个稳定 ID 加若干 contribution：

- `right-panel`：提供面板 ID、标签和纯 React render 函数。
- `conversation.actions`：在会话标题栏提供面板入口。
- `sidebar.primary`：在左侧主导航提供面板入口。

每个 launcher 必须引用同一 registry 中存在的 panel。扩展 ID、contribution ID 重复，或 launcher 引用不存在的 panel，启动前即抛出稳定错误。注册表按 `order`、再按 ID 排序。

新增正式功能时：

1. 在 `packages/writing-ui` 定义面板，只消费 `ClientBridge`/snapshot。
2. 给 panel 和 launcher 使用稳定、命名空间化 ID。
3. 将扩展加入 `DEFAULT_WRITING_UI_EXTENSIONS`。
4. 测试重复 ID、悬空 panel、项目切换及卸载后其他页面不变。
5. 更新 UI 差异白名单、来源/许可说明和 production 分发检查。

不得在 render 中直连 Provider、写 SQLite/文件、执行 HTML/脚本、加载远端插件，或复制事实门禁算法。

## 5. 隔离演示

`packages/writing-ui/examples/demo-sidebar-extension.tsx` 展示三项源码级调整：替换品牌、覆盖主题别名、从 `sidebar.primary` 打开一个只读 `right-panel`。它只读取选中项目 ID，不是 1.0 功能。

```powershell
npm run ui:dev:extension-demo
# 浏览器打开 http://127.0.0.1:4174/extension-demo.html
```

演示使用独立 HTML 入口与 `dist/extension-demo`。正式 `apps/web/src/main.tsx` 只调用 `createDefaultWritingUiRegistry()`，不 import 示例；`tests/check_ui_distribution.mjs` 会同时验证 production 不含示例 ID/文案、demo 构建确实包含它。

## 6. 验证

```powershell
npm run check:ui
python "$env:USERPROFILE\.agents\skills\webapp-testing\scripts\with_server.py" --server "npm run ui:dev:extension-demo" --port 4174 -- python tests/wa024_ui_playwright.py
```

自动检查覆盖：注册/撤销快照、重复/悬空引用、主题/品牌集中配置、设置跨 bridge 持久化、真实 Web Remote 写回、production/demo 构建隔离、项目切换局部状态清除，以及 Chromium 中默认工作台和演示侧栏的挂载/卸载。

## 7. 非目标

- 不提供在线主题市场、插件下载、热更新或第三方代码执行。
- 不恢复旧 `writing-agent-app` 页面或 Tauri 链。
- 不为演示新增正式产品功能或数据表。
- WA-024 未改写 DSH 基础视觉；完整视觉阈值、双主题/双视口和 bridge 一致性矩阵已由 WA-025 验收，结果见 `docs/testing/UI_BASELINE_RESULTS.md`。
