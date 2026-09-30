# rc.53 接手核对记录

日期：2026-09-28。核对基线：`next/runtime` / `1adfb21`。范围：阅读其他 Agent 的更新、核对当前实现及自动测试、建立下一步工作基线。本次不修改业务代码。

## 提交与当前工作区

- `961b66d` 已归档 rc.37–rc.42 的供应商、桌面与阶段循环修改；`e81ada7` 停止跟踪旧 `writing-agent-app` 客户端。
- 本次主要核对 `e81ada7..1adfb21`：rc.43–rc.53 共 11 次提交，涉及 69 个文件，增加 2325 行、删除 204 行。
- 开始检查时，已跟踪文件和暂存区均无改动。根目录中的其他业务报告、pentest 脚本、临时目录和 PRD 压缩包是既有未跟踪文件，不属于本次提交。
- 当前桌面版本为 `1.0.0-rc.53`，Electron 44，Bridge 协议 20；根 package 的 `0.11.0` 为原仓库版本，不能据此判断桌面版本。

## 已核对的变化

| 范围 | 当前实现与影响 | 主要代码位置 |
|---|---|---|
| 对话内切换模型 | `ModelSwitchMenu` 读取轻量供应商摘要，在对话内切换已保存模型；切换时 Host 校验凭据，活动运行由 Host 拒绝切换 | `packages/ui/src/shell/WritingAgentShell.tsx`、`apps/desktop/src/application-host.ts` |
| 模型编辑与设置 | 存量编辑默认收起预设选择，编辑器滚入可视区；新供应商改为分组下拉；验证时间持久化、模型目录提供可点击候选、打开配置文件位置 | `packages/ui/src/shell/ProviderSettings.tsx`、`apps/desktop/src/provider-profile.ts` |
| DeepSeek 与错误提示 | 三种 adapter 均支持供应商附加请求字段；匹配 DeepSeek 端点时补充关闭 thinking；上游错误摘要净化、限长并遮蔽请求 Key 后展示。rc.45 已纠正 rc.43 的“不支持 Responses”推测，旧推测不能继续当根因 | `packages/model-adapters/*`、`apps/desktop/src/provider-profile.ts`、`docs/testing/RC45_MENU_DEEPSEEK_CARRY_POLL.md` |
| 预设协议 | 已有 Anthropic Messages 端点的多个供应商家族优先展示该变体，存量 Chat/Responses 配置仍可识别；这不代表所有供应商账号已经实测 | `packages/client-bridge/src/provider-presets.ts` |
| 跨轮承接 | 同会话的失败、取消或中断运行可承接连续完成的阶段标记；事实核查结果不直接承接；新轮导演从当前进度继续 | `packages/application/src/workflow-tools.ts`、`packages/application/src/collaboration.ts` |
| 核查与重复失败 | 研究保存时即使用事实核查账本校验；illustrative 条目允许空引句；同工具同错误三次暂停为 `TOOL_FAILURE_LOOP`；核查专家可重读已记账 HTTPS 来源 | `packages/writing-core/src/index.ts`、`packages/application/src/fact-web.ts`、`packages/runtime/agent/src/index.ts` |
| 作者表达与标题 | 核查指令聚焦外部可证伪事实，减少对感受与文学表达的机械核查；标题选择接受更多自然表达、版本参数错误能得到具体反馈 | `packages/writing-pack/src/expert-instructions.ts`、`packages/application/src/publication-choice.ts` |
| 流式与性能 | 空闲轮询按项目事件变更刷新；rc.53 另跟踪临时流状态并按约 200ms 节流刷新，修补 delta 不持久化导致快照不更新的问题；凭据状态有 10 秒缓存 | `packages/client-bridge/src/application-bridge.ts`、`packages/runtime/credentials/src/index.ts` |
| 主对话与桌面 | 新增角色署名、会话定位条、会话悬停预览，移除侧栏无动作入口；回复下一步主要由提示词约束；生产模式点关闭弹出最小化/退出/取消 | `packages/ui/src/shell/WritingAgentShell.tsx`、`apps/desktop/src/main.ts` |

以上为代码和现有记录核对结果，不替代真实模型与安装后的桌面验收。

## 本次实际验证

| 命令 / 检查 | 结果 |
|---|---|
| `npm run check:runtime` | PASS：runtime 261、migration 15、conversation 67、legacy-parity 59；包含 runtime TypeScript 检查 |
| `npm run test:ui` | 78/78 PASS |
| `npm run test:bridge` | 63/63 PASS |
| `npm run test:desktop` | 44/44 PASS |
| `node --import tsx --test packages/application/test/fact-web.test.ts` | 4/4 PASS；该文件未列入当前 `test:runtime` 脚本，因此单独执行 |
| `npx tsc --noEmit -p apps/web/tsconfig.json` | PASS |
| `npx tsc --noEmit -p apps/desktop/tsconfig.json` | PASS |
| `git diff --check` | PASS |

合计 591 项现有测试通过。日志在本机 `output/review-rc53-{runtime,ui,bridge,desktop}.log`，不纳入 Git。

实际复算 `output/desktop/Writing-Agent-Setup-1.0.0-rc.53-x64.exe`，大小 111499817 字节，SHA256：

`283d9a3dc1cba97483aef94b55239c1df299032f6a148e51725a12f309345bf7`

与 rc.53 记录一致。阅读既有 `output/rc53-desktop-smoke.json`：ready、协议 20、退出码 0、957ms。这是其他 Agent 已生成的启动证据，本次未重跑安装器或桌面 smoke，未调用真实模型。

## 确认的未解决边界

### P1：否定回复可能被当作提纲确认

位置：`packages/application/src/collaboration.ts:16-25`，使用点在提纲转初稿的门禁。

通过读取当前源码中的 `outlineApproved` 定义、TypeScript 转译后在隔离 VM 直接执行，得到：

| 作者回复 | 函数结果 |
|---|---|
| 方向可以 | true |
| 不同意 | true，错误 |
| 不认可 | true，错误 |
| 还没确认 | true，错误 |
| 可以，但是开头要改 | false |

肯定词按子串匹配，否定词表未覆盖以上回复。导演请求进入初稿时，这些否定回复不能被当前门禁正确拦下。rc.53 的正向测试覆盖了“方向可以”，未覆盖这些反例。这里验证的是实际判定函数，未声称已重放真实模型整轮。

下一步应先补否定、暂缓和含混表达的行为用例，再调整确认逻辑；明确拒绝或未决定不能触发下一阶段。

### P1：截断重试的输出上限记录与计算不完整

位置：`packages/model-adapters/openai-compatible/src/index.ts` 的 `snapshotRequest`、`packages/model-adapters/openai-responses/src/index.ts:75-79`、`packages/runtime/agent/src/index.ts:754,784-785`。

本次直接构造两个实际 adapter 并调用 `snapshotRequest`，不发网络请求：未显式设置 `maxOutputTokens` 时，Chat 的请求体 `max_tokens=32768`，Responses 的 `max_output_tokens=32768`，但两者 `snapshot.outputTokenLimit` 都缺失。运行时重试从该快照或用户显式参数取上限，均为空时就不升限。因此“截断后上限翻倍”在这两种默认配置下没有生效依据。

另外，重试公式 `Math.min(current * 2, 65536)` 会把已经为 131072 的上限降成 65536。当前 Anthropic adapter 为 MiniMax-M3 等模型提供 131072 默认值，确实存在这个输入范围。该点由源码计算确认，未消耗真实模型制造截断。

下一步应统一记录实际生效的输出上限，并保证重试不会降低已有上限；同时覆盖默认值、显式值和超过 65536 的情况。

## 下一步工作的边界

1. 优先解决上述确认误判与截断恢复问题，再回到完整共创旅程验收。
2. 对跨轮阶段承接补查输入变化、已有更新版本和显式重新写作的场景；当前承接入口按同会话历史状态选取，不能仅凭已有正向用例认定所有新任务都适合承接。
3. 对 rc.53 流式修复做长会话下的持续输出、中文输入与滚动联合验证；约每秒五次完整快照重建的实际成本仍待测量。
4. 将 `fact-web.test.ts` 接入常规测试入口；核对来源读取的“完整 URL 匹配”契约与当前 `ledger.includes(url)` 子串实现。此处为代码审阅待验证项。
5. 新预设账号兼容性、生产关闭弹窗、安装升级及真实桌面交互仍沿用各 RC 文档标明的未验证范围。

本次结论是已接手 rc.53 代码基线、现有回归通过且遗留项已定位；不标记最终用户验收完成。
