# rc.14：研究阶段输出截断修复

日期：2026-09-21。范围为用户在导演安排“研究与证据”之后的 `MODEL_RESPONSE_INVALID`，以及模型输出上限配置。与同版[供应商预设](RC14_PROVIDER_PRESETS.md)一起交付，不上调整体最终验收状态。

## 现场证据与根因

只读检查指定失败 run `c6cfef24-97b4-4a60-899a-3a4616df3e12`：北京时间 2026-09-21 01:04:06 开始，01:04:35 失败。前 3 次请求依次完成材料读取、充分性检查和导演派工；第 4 次是独立研究专家请求。

- 实际请求快照 `max_tokens = 4096`，输出 usage 正好为 4096。
- 底层原始错误为“模型在工具参数完成前达到输出上限”，被笼统归类为 `MODEL_RESPONSE_INVALID`。
- 工具参数 JSON 未结束，因此不能执行保存；该 run 没有写入研究结果或正文。
- 应用请求没有显式指定上限，来源是 Anthropic-compatible adapter 硬编码的 4096 默认值，不是用户指定预算、余额不足或材料缺失。

原数据库未被修改。失败后的原始响应字节没有持久化，不能声称重放了同一段截断响应；离线夹具重现其 `max_tokens` 终止原因和未闭合工具 JSON，真实验证则复用同一业务场景。

## 修复与约束

按系统化调试流程先核对现场证据，再编写失败回归并修复，不通过放宽 JSON 校验、调用次数或事实门禁来掩盖截断。

1. 按准确模型 ID 选择输出默认值。MiniMax-M3 为 **131072（128K）**；支持的 MiniMax-M2 系列为 65536。已核对的 Claude Fable 5.1、Opus 5、Sonnet 5、Opus 4.6、Sonnet 4.6 为 131072，Haiku 4.5 为 65536。资料核验日期为 2026-09-21。
2. 优先级为请求显式值 → 自定义配置显式值 → 已知模型默认 → 未识别模型兼容默认 4096。未知私有别名不猜测能力，不对所有供应商强行发送 128K；OpenAI-compatible 仍在没有显式值时省略上限参数。
3. 请求快照记录真正的 wire 上限，并附上 `request/configuration/model_default/adapter_default` 来源，便于追溯。
4. `max_tokens` 终止统一识别为 `MODEL_OUTPUT_TRUNCATED`，包括普通文本截断；残缺工具参数一律不执行，保留 provider request ID。
5. 当前专家任务最多完整重试一次；上限不自动翻倍，不升到模型理论最大值，不接续半段 JSON，不重跑已保存的前置阶段。计入已有模型请求/重试限制，取消和专家上下文隔离不变。
6. 主对话显示正在重新生成完整结果；若仍失败明确说明输出截断。仅对“旧代码 + 精确旧错误消息”的历史记录做显示映射，不改历史数据库，不把其他格式错误一并改名。

128K 是单次输出允许的上限，不是每次必须生成的长度，也不等于一次必然使用 128K Token。上下文窗口与输出上限是不同参数。本次没有声称所有模型都支持 128K。

来源：[MiniMax Messages API 参数](https://platform.minimax.io/docs/api-reference/text-chat-anthropic)（M3 推荐 131072，最大 524288；M2 系列推荐 65536）、[Claude 模型表](https://platform.claude.com/docs/en/models/overview)、[Claude 上下文与输出上限](https://platform.claude.com/docs/en/build-with-claude/context-windows)。

## 回归与独立复核

- 先观察输出默认值、截断分类、恢复及 UI 的失败测试，再确认修复转绿。
- SSE wire 夹具覆盖未闭合 JSON、`max_tokens`、usage 4096、`message_stop`，验证没有 `tool_call_complete` 且保留 provider request ID；普通非法 JSON 仍为格式错误。
- 恢复覆盖成功一次、重复截断、显式请求/配置上限不被覆盖、零重试额度、单请求额度、取消、专家切换和混合限流。混合“限流 → 截断 → 限流”只进入 provider 3 次，记录 2 次重试，没有额外第 4 次请求。
- 只读复核 Agent 使用 `gpt-5.6-sol / high`，负责跨层错误分类、隔离和调用上限检查。发现的 request ID 丢失和混合重试基数问题均先红后绿修复，增量复核无剩余 P1/P2 阻断；没有额外真实模型调用。
- 最终 `check:runtime`：类型检查、Runtime **187**、迁移 **15**、Conversation **43**、Legacy parity **43** 全部通过。
- 最终 `check:ui`：类型检查、UI **53**、Bridge **43**、三种构建、分发边界与 Python 来源/安全检查 **11** 全部通过。
- 最终 `check:desktop`：类型检查、桌面 **32**、生产构建和 **13** 文件分发边界全部通过。

## 获授权的真实研究验证

用户授权最多 2 次真实 MiniMax-M3 请求，本次实际 **1 次**，没有追加连接探测。使用现有凭据代理，新建独立工作区；原项目写入次数为 **0**，不更改凭据或原稿件。

脚本：`tests/ux/rc14_research_replay.ts`。仅从指定失败 run 读取其材料、已确认简报及派工；前三次已完成调用通过确定性夹具重放，不收费。专家研究使用真实 provider，完成后由测试夹具暂停，不继续提纲或正文。

| 检查项 | 实测 |
|---|---|
| 真实请求上限 | 131072，来源 `model_default` |
| 真实请求数 | 1，未触发恢复重试 |
| 研究结果 | 保存为 evidence，共 2352 字符 |
| 运行错误 | 无 `request.failed` 或 `tool.failed` |
| 终态 | `waiting_user`，由测试专用导演暂停；不是产品失败，也不是整篇文章完成 |
| 原稿件保护 | 原项目写入 0；新测试项目也未生成正文 |

持久结果读回包含 3 类机制、4 个虚构案例骨架、3 类代价、3 类写法风险，明确虚构示意范围。内容中仍有较绝对的因果措辞和具体时间表述，需要后续编辑与事实审校；本次不把可保存等同于稿件质量通过，也未批准正式发布。

证据（含业务场景，仅本地保存，不用于公开分发）：

- `output/rc14-research-replay/real-o3KcMB/result.json`
- 研究版本：`e74933cb-74b2-4208-a0bd-22c91e70abe6`，内容 SHA-256：`f3de35226283acb11eaf32c7d8497c401d9a80fd41b6f03fea04fe27bffefaf9`。
- `output/rc14-research-replay/offline-PlW2qg/result.json`：模拟截断 → 完整重试 → 持久化通过，0 次真实请求。
- 第一次离线夹具 `offline-z0AXKl` 因复制旧材料版本 ID 失败，0 次真实请求；修正测试夹具映射后重跑通过，失败证据保留。

报告中 `run.modelRequestCount = 5` 包括 3 次离线前置调用、1 次真实研究和 1 次测试暂停，不等于收费 5 次。报告 `lastUsage` 仅为流中最后一条 usage，不将 inputTokens=0 当作实际免费输入或完整账单；本次不提供费用推算。真实成功回复未达到 4K，不能凭它单独证明截断必然消失；根因证据、确定性截断回归与真实场景验证分别成立。

## 交付边界

该样例通过不代表任意长稿都可一次完成。现有请求超时策略未在本次扩展，未做 128K 实际输出的长时性能验证。原生安装、原会话继续及完整写作仍需用户体验复测；WA-010 保持 `IN_PROGRESS`。

最终安装制品和启动证据统一记录在 [rc.14 制品记录](RC14_PROVIDER_PRESETS.md#安装制品)。用户复测说明位于 `output/desktop/rc14-测试说明.md`。
