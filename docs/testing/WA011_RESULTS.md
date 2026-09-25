# WA-011 自有写作服务、事件流与本地 Web Bridge 结果

执行日期：2026-09-17  
分支：`next/runtime`  
结果：`PASS_LOCAL_IMPLEMENTATION`

## 1. 结论

WA-011 已在本地完成：DSH 源码派生 UI 的 production 入口现通过 Client Bridge v2 读取真实 `WritingApplicationService` 投影，可启动草稿、停止运行、显示简报/持久事件/已保存稿件、识别重启后的 interrupted run，并在用户明确操作后从已保存边界继续。Mock 仍保留为独立构建，不写真实项目，也不会成为 production fallback。

本地 Web Host 只绑定 `127.0.0.1` 随机端口，实施 Host/Origin/协议版本/短期 capability/client generation 五层校验。浏览器不持有数据库、文件路径、Provider 实例或 Key；正式模型请求只能由启动器注入的 runtime 配置发出。

## 2. 关键产物

| 范围 | 产物 |
|---|---|
| Application Service | 项目投影、材料脱敏摘要、session/run/event/artifact 查询、`startDraft/cancelDraft/resumeDraft/recoverWorkspace` |
| 进程内 Bridge | `packages/client-bridge/src/application-bridge.ts` |
| Web Host/Remote | `local-web-host.ts`、`web-bridge.ts` |
| v2 类型闭包 | `protocol.ts`、生成的 `generated/protocol.d.ts`、`tsconfig.protocol.json` |
| 正式入口 | `apps/web/src/main.tsx`、`apps/web/server/main.ts`、`npm run web:local` |
| UI 状态 | 真实/Mock 标识、简报摘要、持久时间线、稿件版本、停止、恢复提示与显式继续 |
| 契约说明 | `docs/architecture/CLIENT_BRIDGE_PROTOCOL.md` |

## 3. 自动验证

`npm run test:bridge` 的 7 项集成测试覆盖：

1. 真实 SQLite/Application Service 投影，不泄漏材料正文或源路径。
2. 相同 operationId 不重复启动；同 ID 不同输入 fail closed。
3. 取消先持久化，Provider 迟到正文不成为 ArtifactVersion。
4. 项目切换后旧 generation 的完成结果不覆盖当前项目。
5. 进程重开恢复最新正文、interrupt 状态，并可显式继续。
6. loopback 随机端口、Host/Origin/协议/capability/generation 拒绝路径和 token-free 日志。
7. Browser Remote 经真实 Host 调用 Application Bridge；重连只读回已保存稿件，不重复 run。

`npm run check:ui` 还覆盖 typed declaration 生成、7 项 Mock/布局测试、production/mock 双构建、正式包无 Mock/旧 Tauri/上游端点/固定调试端口/localStorage，以及固定上游源码 hash/许可检查。

整体验证：`npm run check:m0` 通过（11 项基础检查 + 83 项 runtime）；`npm run check` 通过（231 项 Python/工作流/同步/插件检查，1 项既有环境条件跳过）；`npm audit --omit=dev --audit-level=high` 为 0 vulnerability；需求包自检的 25 项 backlog/38 项验收引用和依赖图全部通过。

手工启动冒烟使用 production 构建和示例真实 Provider 配置完成：启动器返回随机 `http://127.0.0.1:<port>`；index 200 且有 CSP；握手为 protocol v2、`mock=false`、`persistsUserProjects=true`；空 workspace snapshot 为 ready；随后正常停止，端口不再监听。未设置或输出 API Key，未调用模型。

## 4. 验收映射

| 验收 | 本任务结果 | 边界 |
|---|---|---|
| AT-04 | `PASS_WA011_SCOPE` | 已提交正文重开恢复；未完成 run 变为 interrupted；显式继续有测试 |
| AT-10 | `PASS` | cancel 持久化后释放迟到 Provider 结果，正文版本数仍为 0 |
| AT-25 | `PASS_BRIDGE_SCOPE` | snapshot/Host 日志无 Key、材料正文、私人路径或 capability；完整诊断包仍由 WA-015/018 汇总验收 |
| AT-31 | `PASS` | production UI 由自有 Host 独立启动，不用旧应用/外部 DSH；Mock 单独标识 |
| AT-35 | `PASS` | 重连不启动 run；旧 generation、跨项目 session、协议错配和 operationId 复用均拒绝 |
| AT-36 | `PASS_WEB_SCOPE` | production 无上游遥测/更新/账户端点；模型只由用户配置 runtime 发出；WA-025 已复验 Web，Desktop appId/更新仍属 WA-017/018 |

## 5. 未宣称内容

- 没有真实 Provider Key，未发起付费模型请求；当前证明的是实际 Application Service/SQLite/Host/Remote 闭包和确定性 Provider 行为。
- UI 当前消费既有项目/简报；项目创建、材料管理、块级编辑/锁定/差异属于 WA-012 及后续写作页面。
- 事实门禁与正式导出仍分别属于 WA-013/014；草稿完成不显示为可发布。
- 本地 Web 不是 LAN/公网服务；没有 TLS、多用户、账户或远程部署承诺。
- Electron preload/IPC、appId、数据目录和 Windows 安装包仍由 WA-017/018 验收。
- 未 commit、push、开 PR、发布或修改生产环境。
