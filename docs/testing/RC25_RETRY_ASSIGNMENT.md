# rc.25：桌面重试保留专家任务与超时归因

日期：2026-09-22。范围：修复桌面“重试这一步”丢失未完成专家任务；核对用户最近一次模型超时。不调整模型配置、超时阈值、系统电源设置或原项目。

## 真实记录与归因边界

> rc.26 补充更正：旧 runtime 会剥离持久错误中的 HTTP status，因此不能仅凭缺少 status 排除服务商 HTTP 错误。60 秒整次截止是确认存在的代码缺陷，但旧请求的确定性来源仍缺证据。见 [rc.26 归因更正](RC26_WAITING_AND_TIMEOUT.md)。

只读检查 run `5cd97c26-27c9-44f0-afdd-0be9bdd8f377`。请求快照确认 provider `minimax`、model `MiniMax-M3`、adapter `anthropic-messages-v1`，出错角色为 `outline`。研究成果已经保存，提纲请求未得到可提交的完成结果。

| 请求 | 北京时间 | 记录时长 | 核实结果 |
| --- | --- | --- | --- |
| `68e8ee28-633c-4b36-9191-83e85ba59fd8` | 15:50:36.849 → 16:41:14.745 | 3037.896 秒 | 请求期间 Windows 睡眠，不能视为服务商计算耗时 |
| `c1f011e8-430a-46d5-a9b5-39f75629aae7` | 16:42:35.625 → 16:43:35.856 | 60.231 秒 | 客户端整次请求超时触发，未记录服务商 HTTP 错误 |

Windows System 日志：Power-Troubleshooter 事件 1 记录 SleepTime `2026-09-22T07:50:51.7109733Z`、WakeTime `2026-09-22T08:41:14.4619874Z`；Kernel-Power 42 在北京时间 15:50:59 记录进入睡眠；Kernel-Power 507 在 16:41:14 记录从休眠恢复；Kernel-General 1 记录唤醒时系统时钟追平约 3012.779 秒。最后的 60.231 秒请求位于唤醒之后。

两次错误 payload 均只有 `code=TIMEOUT`、`message=模型服务响应超时`、`retryable=true`，没有 HTTP status 或 providerRequestId。当前配置没有显式 timeoutMs；Anthropic adapter 默认 `60_000`，用 `AbortSignal.timeout` 限制整次请求，不是“持续无输出 60 秒”。该 adapter 的本地 timeout catch 正好产生这三个字段；HTTP 408 路径会保留 status。

结论：确实在调用 MiniMax-M3 时中断，但不能确定是 MiniMax API 故障。第一段长时主要包括本机睡眠；最后一次是客户端 60 秒截止。现有证据不能进一步区分服务商响应慢、网络链路阻滞或响应未完成。本轮不以一次新的成功探针替代历史归因，也不擅自修改超时阈值。

## 恢复缺陷与修复

`ApplicationClientBridge.resumeRun` 无条件生成“从已保存状态继续写作”。Application 将这句当成新的作者指令，导致 `recoverPendingAssignment` 不成立。底层已有的纯传输恢复能力因此没有在桌面入口生效；此前仅测 application 入口，漏掉了 bridge 的默认参数。

现在仅对 `retry_unknown` 且用户未提供新反馈的情况，不再生成 userInstruction，保留原专家分派。用户确实提出修改、普通阶段确认等路径保留原语义。协议仍为 v20，无数据库迁移。

恢复不承诺仅有一次模型调用：导演可能先读取已保存的输入版本并重新检查可写性，再续接尚未完成的专家任务。已保存的研究不重新生成；未完整收到并持久化的那次模型回复仍需重新请求，不能从服务商未返回的中间 token 接续。授权、版本检查及共创确认不跳过。

## 验证

采用 systematic-debugging、test-driven-development、webapp-testing、verification-before-completion；没有委派子 Agent。

- 新增真实 Application Bridge 回归：提纲超时 → 桌面 resumeRun → 保留研究版本 → 提纲分派总数仍为 1 → 保存提纲并等待确认。先撤回本轮修复复现 `2 !== 1`，再恢复修复通过。
- Runtime / Bridge / Conversation / UI 四套测试通过；Runtime / Web / Desktop 类型检查通过。Desktop 33 项、生产构建及 13 文件分发边界通过。
- 打包 rc.25 原生 Electron：从原 SQLite 只读备份，实际点击“重试这一步”，仅请求本机 SSE fixture。实际顺序：导演读取已保存研究 → 检查可写性 → 原提纲专家提交。没有重新分派，没有 read_material，没有研究专家重跑。
- 同一 run 续接；研究版本与内容 hash 不变；正文版本不变；只新增提纲及其阶段记录；终态 `waiting_user / CO_CREATION_CHECKPOINT`，等待作者确认，不自动开始正文。
- 隔离证据：`output/rc25-retry-assignment/rc16-00c10885-51f9-40a1-b10c-b2e9375c6f24/`（result.json、前后截图、Electron stderr）。已查看恢复后的截图。
- 原项目版本及目标 run 事件序号前后相同，真实模型调用 0 次。未关闭用户当前安装的应用。
- 另一次尝试用历史 rc.24 临时目录做原生红测，因目录中 exe 已不存在而未启动；不计入验证。缺陷的红测以真实 bridge 自动回归为准。

## 交付与未验证项

安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.25-x64.exe`，111457861 字节，SHA256 `8af195cf1741ceb0fee640f6b1415e069d235e9e8aa76b90e347dc7ee2b3ca4f`，与同目录 `SHA256SUMS.txt` 一致。最终 app.asar 与隔离测试副本一致：`9fc4c03d1c70ef6ce48773986bdeb090c2ecc8e96f4789ee8a9b5ebd7304cba6`。

未自动安装、改原项目、调整超时配置、提交代码或公开发布。真实 MiniMax 后续请求能否顺利完成、文章质量与安装升级体验仍需用户复测；本轮修复不代表服务商超时消失。整体 `BLOCKED_CORE_WORKFLOW`、WA-010 `IN_PROGRESS` 不变。
