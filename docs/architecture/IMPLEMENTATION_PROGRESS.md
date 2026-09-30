# Writing Agent 1.0 实施进展
> **2026-09-30 发布准备：** README 改为桌面/Claude Skill 双入口，更新快速开始、差异表、Release 操作与草稿；旧说明和 rc.6 门禁保留归档。补齐搜索和对话可读性测试入口，25 项定向测试及文档/镜像检查通过。rc.57 成品复制到本机 TEMP 短路径后启动 smoke 通过，不能外推干净机安装与升级。尚未暂存、提交、推送或公开发布，门禁仍 CLOSED。见[发布准备记录](../launch/RELEASE_PREPARATION_2026_09_30.md)。
> **2026-09-29 rc.57 搜索设置：** 增加 Parallel 免费开关、Tavily Key 和纯模型复核风险说明；完整/专项事实核查共用配置。安装包已生成到 output/desktop，专项/分发配置 22 项测试、包内版本与边界校验通过；隔离启动两次遇 Electron GPU 子进程崩溃，尚未完成成品启动/安装验收。Parallel 真实检索与 MiniMax 纯模型复核通过，联网全流程受 MiniMax 529 高负载影响，Tavily 真实 Key 待验证。记录见 [搜索设置](../testing/FACT_SEARCH_SETTINGS.md)，不提升整体最终验收状态。
> **2026-09-29 rc.56 标题选择连续性：** 修复旧讨论干扰明确标题选择、正文编辑后选择被作废以及旧快照恢复冲突。真实 MiniMax 6 次请求验证旧/新候选选择交接及否定/模糊认可反例；正文和原项目未变，事实门禁未放行。589 项相关回归及成品启动通过。详见 [rc.56 记录](../testing/RC56_TITLE_SELECTION_CONTINUITY.md)，不提升整体最终验收状态。
> **2026-09-29 rc.55 逐阶段确认补齐：** 共创模式补上集中修订、语言终审各自确认；修复恢复提示要求旧版本但当前权限已更新的冲突。老任务重试先补确认、不重写已保存正文。真实 MiniMax 在故障副本中 11 次请求验证恢复、自然认可与标题等待，无新增工具失败，原项目未写入；完整回归通过。详见 [rc.55 记录](../testing/RC55_STAGE_CONFIRMATION_RECOVERY.md)，不提升整体最终验收状态。
> **2026-09-28 rc.54 语义确认：** 修复“认同”“认可；”误入反复讨论及提纲否定误放行；方向、共创检查点、标题、配图与偏好入口使用上下文语义决策，程序绑定版本和授权。600 项自动测试通过；真实 MiniMax 在故障项目隔离副本中从“认同”进入集中修订并保存，原项目无写入。详细范围、真实测试失败过程及保留授权边界见 [rc.54 记录](../testing/RC54_CONTEXTUAL_CONFIRMATION.md)。不提升整体最终用户验收状态。
> **2026-09-25 rc.36 交互与核查恢复：** 确认摘要正常渲染，真实素材临时展示，运行记录按阶段/专家职责组织；保留已选标题但失效旧事实结论，工具权限与纠正契约一致。读者模拟平台与 humanizer 显式呈现，专项核查补齐授权原文。最终真实模型与成品原生 UI 专项通过，失败过程保留，原项目无写入、未自动安装，不上调整体验收状态。见 [rc.36 记录](../testing/RC36_CONVERSATION_AND_FACT_RECOVERY.md)。
> **2026-09-24 rc.35 项目删除修复：** 删除只保护目标项目正在执行的任务，等待确认不再误拦；错误码跨 Electron 边界保留并显示原因。隔离真实数据及成品 UI 验证通过，安装包位于 output/desktop。未操作原项目、未自动安装，整体用户验收状态不变。见 [rc.35 记录](../testing/RC35_PROJECT_DELETE.md)。
> **2026-09-24 rc.34 逐位审校交接：** 共创模式每位审校各自暂停、核对、确认；异议留在当前专家，公开讨论由程序保存，后续主笔接收作者取舍。专家显著标识和单一输入框已通过最终打包客户端实测。rc.34 位于 output/desktop，未自动安装、未修改原项目。工程、真实模型及失败证据见 [rc.34 记录](../testing/RC34_STEPWISE_REVIEW.md)，不提升整体用户验收状态。
> **2026-09-24 rc.33 打包交付：** 公开阶段流式保存改造已生成 NSIS 安装包，位于指定 `output/desktop`。桌面检查及 33 项测试、分发检查、包内版本核验、独立 TEMP 启动通过；未自动安装、未改原项目，未解决边界及整体验收状态不变。见 [证据与边界](../testing/STREAM_STAGE_HARNESS_SAVE.md)。
> **2026-09-24 公开阶段流式保存改造（未发布）：** 面向作者的文本直接流式输出，程序原文调用现有保存管线，不再由模型二次序列化；减少已完整材料的重复读取。两次真实提纲输出及隔离桌面保存/停止通过，保留追问、确认、CAS、事实门禁。尚有可选写法过度追问问题，未生成新 Setup；见 [专项证据](../testing/STREAM_STAGE_HARNESS_SAVE.md)。
> **2026-09-24 rc.32 首条交流保存修复：** 普通文字回复后缺少工具保存时，切换为 required 保存请求，不再 auto 重复聊天。首字流式与跨保存请求预览保留；取消、授权及方案确认校验不变。5 次真实 MiniMax 请求、最终打包原生保存/停止与工程回归通过。见 [rc.32 记录](../testing/RC32_INTAKE_SAVE.md)，不提升整体用户验收结论。
> **2026-09-24 rc.31 前置沟通修复：** readiness 从执行段级改为阶段/版本级；失败核查回导演决定内部修订、复核或真实作者问题，保留事实导出门禁。持久 finish 直接收尾，消除追加模型确认空转。真实缺料追问与比喻争议重放、最终打包桌面专项通过，详情与未确认事项见 [rc.31 记录](../testing/RC31_STAGE_READINESS.md)。rc.31 可安装复测，不升级整体最终用户验收结论。
> **2026-09-23 rc.30 调用保护修复：** 用户显式继续按执行段刷新保护基线，保留累计历史；旧受保护写作任务恢复原专家，不重复确认标题。核查使用核心枚举和有效证据清单，纠错按任务隔离，调度与结构化核查要求实际工具调用，普通自由交流保持 auto。真实 MiniMax 故障副本重放和打包桌面恢复/停止验证通过，原项目未修改。见 [rc.30 记录](../testing/RC30_FACT_RESUME.md)；不将核查技术流程完成等同于内容质量签收，整体状态不变。
> **2026-09-23 rc.29 审校等待体验：** 补齐编辑/发布/读者审校流式成果，共用七种文本成果契约；累计计时跨请求保持，任务计数与本轮请求数分开，ready 前隐藏调度工具。运行时 216 等回归和三个打包客户端场景通过，详见 [rc.29 记录](../testing/RC29_REVIEW_STREAMING.md)。没有真实模型请求或原项目写入，不上调整体验收状态。
> **2026-09-22 rc.28 确认去重：** 普通共创确认合并至已保存成果末尾，不再复制提纲/初稿/审校内容或另设决策卡片。三阶段投影回归、历史缺产物回退、原生流式保存/重开无重复通过；异常与标题选择入口保留。见 [rc.28 记录](../testing/RC28_INLINE_CONFIRMATION.md)，不改变工作流完成或整体用户验收状态。
> **2026-09-22 rc.27 专家成果流式：** 修复提纲等专家普通文本被隐藏、content 字段先到时等待 stage、保存后另起消息及长文回顶问题。实际提纲离线原生回放、content-first/上翻/停止验证通过；安装包与被测程序一致，原项目写入与商业模型请求均为 0。详见 [rc.27 记录](../testing/RC27_EXPERT_STREAMING.md)，整体仍为 BLOCKED_CORE_WORKFLOW，WA-010 IN_PROGRESS。
> **2026-09-22 rc.26 等待体验：** 主对话以真实请求状态显示正在处理的事项、等待计时和停止入口；双适配器改为首次内容/流停滞时限，补齐安全诊断。原生 74 秒流式任务完成、90 秒停滞和主动停止通过，见 [rc.26 记录](../testing/RC26_WAITING_AND_TIMEOUT.md)。旧错误字段不足以确定超时来源的归因已更正；商业模型质量和整体验收状态不变。
> **2026-09-22 rc.25 恢复入口补修：** 纯超时重试不再伪造新作者指令，保留原专家任务。真实 bridge 红绿回归及打包客户端隔离恢复通过，已保存研究复用、提纲待确认，原项目不变、真实模型 0 次。系统日志确认长时记录含睡眠，最后 60.231 秒为客户端截止，未证实 MiniMax API 故障。见 [rc.25 记录](../testing/RC25_RETRY_ASSIGNMENT.md)；不调整超时阈值，整体验收状态不变。
> **2026-09-22 rc.24 工具诊断说明：** 补齐 24 个写作工具展示，区分 Agent 与工具；记录新调用角色、标明旧记录来源或未知，展示实际保存状态并修正执行段统计粘连。Runtime 192、Bridge 58、Conversation 54、UI 60、Desktop 33 与用户记录隔离桌面两种尺寸通过；不调用真实模型、不改原项目。见 [rc.24 记录](../testing/RC24_TOOL_DIAGNOSTICS.md)，整体验收状态不变。
> **2026-09-22 rc.23 主对话流式补修：** 补齐被遗漏的普通文本增量，需求交流允许文本先行、工具校验保存，首字前有明确反馈；原有专家私有文本和持久化边界不放宽。最终打包 MiniMax 三组真实请求均在结束前持续更新，本轮含复现/探针共 7 次真实请求，原项目不变；模型首字延迟仍有波动。详见 [rc.23 记录](../testing/RC23_STREAMING_VERIFICATION.md)，不替代整体用户验收。
> **2026-09-22 rc.22 恢复说明：** 实际事件证明用户 `ok` 已生效，后续模型请求超时而非确认失败。分离模型中断与外部工具风险提示，恢复按钮直接可见，旧成果不重复展开，小窗口页签返回恢复定位。UI 60、Bridge 54、Desktop 33 与最终打包隔离桌面三种尺寸通过；本机失败 fixture 1 次请求、真实模型 0 次、原项目不变。详见 [rc.22 记录](../testing/RC22_RECOVERY_EXPLANATION.md)，未宣称外部超时消除或整体最终验收通过。
> **2026-09-22 rc.21 恢复与诊断：** 以 rc.19 真实失败 run 取证，修复恢复后同版本材料强制重读、同角色状态陈旧、重复注入及纯超时恢复的任务丢失；不提高调用上限或放宽事实/授权门禁。运行详情按恢复段、专家任务、工具及具体材料版本、逐请求状态呈现，默认摘要、按需展开。Runtime 192、Conversation 50、Bridge 52、UI 60、Desktop 33 及最终隔离打包桌面通过，原项目未写、真实模型 0 次。详见 [rc.21 记录](../testing/RC21_RECOVERY_DIAGNOSTICS.md)。外部超时与真实写作质量仍需现场验收，整体验收状态不变。
> **2026-09-22 rc.20 流式与输入体验：** 主对话展示真实增量的允许内容，未保存状态与持久成果区分；修复发送焦点与预写交接，明确项目/会话入口，方向总结结构化并清理内部字段。隔离打包桌面两种尺寸通过，0 次真实模型调用、原项目不变，详见 [rc.20 记录](../testing/RC20_STREAMING_INTERACTION.md)。安装后真实模型节奏仍待现场复测；不升级整体业务验收结论。
> **2026-09-21 rc.19 对话信息分层：** 主对话保留交流、成果和重要问题，技术调用归运行详情；可直接阅读当前稿件，完整导出迁入稿件面板，阅读标题与已选发布标题一致。打包 Electron 两种窗口尺寸专项通过，原项目不变、真实模型 0 次。详见 [rc.19 记录](../testing/RC19_CONVERSATION_PRESENTATION.md)，不升级整体业务验收结论。
> **2026-09-21 rc.18 回复可见性：** 连续“继续”的回复已保存但被自动滚动到页尾隐藏。现跟随最新消息，运行记录直接展示本轮回复摘要；真实打包红绿复现、正常及小窗口、历史阅读和切页回归通过。详见 [rc.18 证据](../testing/RC18_REPLY_VISIBILITY.md)。不代选标题、不改正文，整体验收状态不变。
> **2026-09-21 rc.17 单一主对话：** 取消检查点额外输入框；标题/提纲/缺口在主对话强调展示，普通认可不代选标题，明确选择后接续核查；修正作者交流被误标为交付失败。打包后的旧会话隔离验收已通过，正文不变，真实模型 0 次。详见 [rc.17 记录](../testing/RC17_SINGLE_COMPOSER.md)。原生升级、真实模型交互和整体最终验收仍独立记录。
> **2026-09-21 rc.16 桌面反馈补修：** rc.15 用户复测暴露 DesktopClientBridge 丢失 feedback，后台收到空消息却被泛化成网络提示。已完成红绿回归和完整历史副本重放，并在打包后的实际 Electron 窗口点击通过，证据见 [rc.16 专项记录](../testing/RC16_DESKTOP_FEEDBACK_FIX.md)。本轮 0 次真实模型调用，原项目写入 0；不据此改变整体验收状态。
> **2026-09-21 rc.15 标题交流修复：** 不再用正文首段冒充共创标题；独立标题专家保存候选，卡片与主对话都能接住自然语言意见。旧检查点可恢复，明确选择前不进入核查，正文不变。真实 MiniMax 4 次重放合计 14 次请求，最终标题交流场景通过；候选质量仍需用户修改/选择及后续核查，不能当成完整交付通过。回归与失败记录见 [rc.15 专项记录](../testing/RC15_TITLE_CONVERSATION_FIX.md)，WA-010 与整体验收状态不变。
> **2026-09-21 rc.14 研究截断修复：** 指定失败记录确认 Anthropic adapter 默认 4096 导致研究工具 JSON 被截断。MiniMax-M3 改用官方推荐 128K，保留显式配置；截断单独分类、在原调用限制内最多完整重试一次，主对话和历史错误显示更明确。Runtime 187、迁移 15、Conversation 43、Legacy parity 43 及 UI/Bridge/Desktop 回归通过，独立工作区真实研究 **1 次**请求保存成功，原项目写入 0。详见[专项证据](../testing/RC14_OUTPUT_TRUNCATION_FIX.md)，不等同于完整写作或最终验收通过。
> **2026-09-21 rc.14 模型设置简化：** 参考 cc-switch 内置 15 个静态供应商模板，选择后填写 Key 与模型即可；保留自定义和旧配置，防止跨供应商误带 Key。设置小窗口与旧自定义 Anthropic 参数丢失一并修复。工程及隔离 UI 证据见 [rc.14 记录](../testing/RC14_PROVIDER_PRESETS.md)。没有新增真实模型调用，不宣称全部供应商已实连或整体最终验收通过。
> **2026-09-21 rc.13 澄清保存修复：** 最新用户失败由模型复制原文时引号变化触发；改为工程层绑定持久用户来源、统一显示待确认语义，严格授权校验不变，不提高调用上限。原失败参数离线精确重放及授权的 2 轮真实 MiniMax 回复保存通过，见 [rc.13 记录](../testing/RC13_INTAKE_PROVENANCE_FIX.md)。原生安装后回到原会话仍待用户复测；不据此宣称完整主旅程或最终验收通过。
> **2026-09-21 rc.12 原版能力迁移：** 21 角色专业方法进入独立专家请求；主对话连续讨论、局部改稿确认、标题与分发文案选择、独立核查、7 份风格参考和配图策划确认已接通。用户授权的 3 组 MiniMax 场景及真实浏览器专项通过，见 [rc.12 验证](../testing/RC12_LEGACY_PARITY.md)与[逐项状态](../implementation/LEGACY_PARITY_MIGRATION.md)。允许开始本轮桌面体验测试，不宣称原版全部能力迁移或最终用户验收完成；WA-010 保持 IN_PROGRESS，开放式搜索/风格自动盲测等剩余项明确保留。
> **2026-09-20 rc.11 交付入口修复：** 正式导出直接放入主对话，系统另存为、路径回执和文件夹定位形成闭环；版本绑定事实门禁不变。工程与隔离 UI 证据见 [rc.11 记录](../testing/RC11_CONVERSATION_EXPORT.md)，原生窗口人工体验待复测，不上调整体验收状态。
> **2026-09-20 rc.10 定向修复：** 真实对话形成建议时因模型被要求生成内部元数据导致连续格式校验失败；改为业务偏好契约，由工程层构造材料引用及授权状态。见 [rc.10 记录](../testing/RC10_PROPOSAL_CONTRACT_FIX.md)。真实模型验证未完成，不上调验收状态。
> **2026-09-20 rc.9 定向修复：** rc.8 澄清回复已保存后多发收尾请求导致内部上限误报；已改为持久回复完成即结束，保留取消/权限/防失控保护。根因和红绿回归见 [rc.9 记录](../testing/RC9_INTAKE_COMPLETION_FIX.md)。不升级整体业务验收结论。
> **2026-09-20：CR-003 对话优先改造。** 新项目无需必填字段，后台形成可确认简报并在同会话衔接写作；实现与边界测试见 [CR003 结果](../testing/CR003_CONVERSATION_RESULTS.md)。候选软件可用于针对性复测，不代表完整真实写作、交互质量或最终业务验收通过。WA-010 保持 IN_PROGRESS。
> **2026-09-19 当前状态：BLOCKED_CORE_WORKFLOW。** WA-010 从完成重新打开，旧 20/25（80%）与 READY 结论撤回；其余任务暂不重新认证，不能据此换算产品完成百分比。下面 rc.6 及测试矩阵为历史工程证据，不证明导演/独立评审或缺口交互已实现。当前实施依据：[CR-002](../../writing-agent-1.0-prd-v1.1-dsh-ui/docs/implementation/CR002_INTERACTIVE_COLLABORATION.md)、[分批计划](../plans/2026-09-19-interactive-collaboration.md)。

更新时间：2026-09-28

本地集成分支：`next/runtime`  
记录口径：只有产物存在且对应验证完成，任务才标为 `COMPLETE_LOCAL`；远端 CI、PR、Release 和人工验收单独记录，不以本地通过替代。

## 2026-09-28 rc.53 接手核对

当前代码基线已更新至 `1adfb21`（桌面 `1.0.0-rc.53`，Bridge 协议 20）。rc.43–rc.53 的模型切换、供应商适配、跨轮承接、证据账本校验、重复失败保护、流式刷新及桌面交互已完成本次代码核对。重新执行的 591 项现有测试和 runtime/web/desktop TypeScript 检查通过。

专项核对另确认了提纲否定回复误判、截断重试上限记录/计算不完整两个未解决问题，下一步优先处理。完整范围、证据与待验收项见 [rc.53 接手核对记录](../testing/RC53_HANDOVER_REVIEW_2026-09-28.md)。以下旧日期段落与任务账本保留为历史记录，不作为当前桌面版本或最终用户验收结论。

## 2026-09-19 rc.7 工程测试更新

R2/R3 已实现导演独立请求、同稿隔离评审、持久任务绑定、返工与缺口交互，并完成自动回归。真实 MiniMax-M3 的材料不足追问和提纲修改通过；完整写作仍未通过，暴露的返工恢复和无效返工预算问题正在收口。提供协议 v18 的隔离桌面工程测试入口，但 `BLOCKED_CORE_WORKFLOW`、WA-010 `IN_PROGRESS` 保持不变，不恢复最终用户验收就绪。详见 [当前证据](../testing/CR002_DESKTOP_EXPERIENCE_RESULTS.md)及[测试入口](../testing/CR002_DESKTOP_TRYOUT.md)。

## 历史结论（已由 CR-002 撤回就绪判断）

按 PRD 的 25 个 P0 任务等权、且必须满足各自外部 Definition of Done 的严格口径，当前仍为 20/25（80%）：WA-018/019/021/022 受外部环境、参与者和发布授权阻塞，WA-020 依赖它们而未签收。这个数字不再用来代表产品主旅程完成度。

真实用户安装试用持续推翻“后台能力已接入就等于产品可用”的结论；此前曾把 rc.6 误判为达到 `READY_FOR_FINAL_USER_UAT`；该判断已被 CR-002 撤回。除四步引导建稿、角色化共创、现稿修改、三种 HTML 排版和自动跟随外，新基准明确要求：主对话是普通用户的主工作窗口，历史项目即使尚无会话也能被选中并开启新对话，选中态清晰，阶段成果、完整稿件和所有需要用户处理的阻断必须在主对话直接出现；“稿件与版本”只是追溯与精调工作台。项目删除必须在项目列表可发现且采用精确名称确认。Windows 升级还必须把“移除旧版 → 安装新版”两个真实阶段展示给用户。状态恢复不等于最终用户已经签收。

交互恢复已完成源码、自动矩阵和真实环境闭环：Client Bridge v17 将共创反馈与显式项目选择贯穿 UI/Web/Desktop/Application Bridge；已有正文的新 run 强制先读当前版本；生产包四步建稿通过；MiniMax-M3 实际完成三个带意见的检查点、九阶段现稿压缩、事实 `passed`、TXT/杂志 HTML 导出与重启读回，终态 `distanceFromBottom = 0`。桌面文件级验收还发现并修复了 Desktop IPC 丢失 `layoutPreset` 的问题。真实用户数据库中的 `test` 经只读检查确认是“简报已确认、1 份材料、0 个会话”，rc.6 已将该状态作为合法项目入口而不是错误。

当前候选是 Electron 44、协议 v17 的 unsigned NSIS `1.0.0-rc.6`：111,340,408 字节，SHA-256 `11bfd315eeaca79ac548ac2cfc47cea5028341bce901ff6397a9d726e00531fa`。打包后启动握手退出码 0、stderr 为空；零会话历史项目、新建对话、删除精确确认和项目隔离的实际桌面专项全部 `PASS`。rc.4 → rc.5 正常登记/缺失登记升级及两阶段可见安装页仍是升级机制的已验证证据；rc.5 → rc.6 精确原位升级因用户当前应用正在运行而未由自动脚本擅自关闭，留给最终用户验收。最终自动矩阵为 Runtime 142/142、迁移 15/15、UI 42/42、Bridge 33/33、Desktop 23/23、Python 241 通过/1 跳过，文档与交付包检查通过。独立干净机、OpenAI-compatible 商业端点、12 例三组人工评分、5 位参与者、代码签名决定、维护者签收和公开发布仍未完成。

## 任务账本

2026-09-19 CR-002 R1 增量：必要信息判断、缺口提问/等待、持久答复恢复、主对话回答入口已实现，恢复上下文及起始现稿绑定已补牢，独立规格/代码质量复核和本地自动验证通过；[结果与未完成项](../testing/CR002_R1_RESULTS.md)。R1 不包含独立导演/专家运行，故 WA-010 保持 IN_PROGRESS，产品保持 BLOCKED_CORE_WORKFLOW。

| 任务 | 状态 | 关键产物 | 已验证 | 未宣称内容 |
|---|---|---|---|---|
| WA-001 基线审计 | `COMPLETE_LOCAL` | `BASELINE_AUDIT.md` | 根回归、旧桌面前端检查、只读 schema/计数 | 未读取正文或 Key；Rust 编译因环境缺失不写 PASS |
| WA-002 上游与许可 | `COMPLETE_LOCAL` | `UPSTREAM_MAP.md`、`FRONTEND_UPSTREAM_MAP.md`、`upstream-sources.json`、`THIRD_PARTY_NOTICES.md` | 固定 commit、tree OID、许可和 registry 自动检查；WA-023 后两项前端切片为 `ported_verified` | 其余 runtime/desktop 仍为计划项，不冒充已移植 |
| WA-003 legacy 夹具 | `COMPLETE_LOCAL` | `tests/fixtures/legacy/`、`BASELINE_RESULTS.md` | legacy manifest/SQLite schema/fact gate 负向测试 | 夹具不含私人正文、Key 或真实客户数据 |
| WA-004 架构与 CI | `COMPLETE_LOCAL` | `docs/architecture/adr/0001`–`0005`、M0 CI lane、`check:m0` | Node SQLite 冒烟、11 项 M0 测试、226 项整仓测试、同步/插件检查、production audit 0 | 远端 GitHub Actions 未运行；无 commit/push/PR/Release |
| WA-005 存储/领域基础 | `COMPLETE_LOCAL` | `packages/writing-core`、`packages/storage`、`WA005_RESULTS.md` | 类型检查；12 项 runtime/schema/恢复测试；AT-05/06/23/27/28 本地映射 | 远端 CI 未运行；物理磁盘满用确定性 `SQLITE_FULL` 注入，不冒充真实磁盘压测 |
| WA-006 模型协议/首个 provider | `COMPLETE_LOCAL` | `packages/runtime/llm`、`packages/model-adapters/openai-compatible`、`WA006_RESULTS.md` | 类型检查；15 项 mock/工具/连接/SSE 测试；F03/F12 与 AT-02/20 边界映射 | 未调用真实模型；AT-02 的工具执行/稿件保存和 AT-20 的 run 总预算仍待后续任务 |
| WA-007 工具注册与权限 | `COMPLETE_LOCAL` | `packages/runtime/tools`、`WA007_RESULTS.md` | 类型检查；24 项注册/权限/材料/版本/路径/网络/模块测试；F04 与 AT-02/18/19/25 边界映射 | 无 agent loop/实际网页抓取/写入工具；材料 port 尚未接持久化 |
| WA-008 自有循环/session/request snapshot | `COMPLETE_LOCAL` | `packages/runtime/agent`、`packages/runtime/session`、`apps/cli`、SQLite schema v2、`WA008_RESULTS.md` | 真实两轮 mock 工具闭环、正文版本提交、重启离线重建、篡改拒绝、v1 备份迁移、OpenAI wire payload 等价、独立性源码闭包 | 未调用真实付费模型；AT-24 发行包/进程终验待 RC；WA-009 的预算/取消/恢复未提前实现 |
| WA-009 取消/恢复/预算 | `COMPLETE_LOCAL` | `packages/runtime/recovery`、runtime operation ledger、SQLite schema v3、CLI `inspect/replay/resume`、`WA009_RESULTS.md` | 持久取消与迟到输出丢弃；真实子进程强退恢复；unknown outcome 阻断；四类预算；发出事务故障注入；v1/v2 备份迁移 | 未调用真实付费模型；远端 CI 未运行；CLI resume 只完成对账/授权并标记可继续，后续实际任务接管归 Application Service |
| WA-010 中性写作能力包/文章闭环 | `IN_PROGRESS`（CR-002 重新打开） | `packages/writing-pack`、`packages/application`、CR-002、R1 实施计划 | 原阶段工具/保存/核查运行证据保留；不再称为独立审校或完整业务迁移 | 缺口交互、导演委派、评审上下文隔离须按 C02 重新取证；真实模型/桌面主旅程仍待复验 |
| WA-023 DSH UI 基线 | `COMPLETE_LOCAL` | `packages/ui`、`packages/client-bridge`、`apps/web`、`UI_CHANGE_ALLOWLIST.md`、`WA023_RESULTS.md`、截图/hash | 10 个 exact copy 来源校验；7 项 UI 单测；production/mock 双构建；Chromium 明暗/双视口/窄窗/设置/发送/右栏；完整矩阵由 WA-025 收口，Electron 安装包由 WA-017 收口 | 该任务自身只代表 Mock 基线；真实接线与桌面分发由后续任务分别完成 |
| WA-011 Application Service/事件流 Bridge | `COMPLETE_LOCAL` | Application 投影与 run lifecycle、Client Bridge v2、Local Web Host/Remote、生成声明、production 启动器、`CLIENT_BRIDGE_PROTOCOL.md`、`WA011_RESULTS.md` | 7 项 Bridge/Host 集成测试；取消迟到结果、重启恢复/继续、generation/重连/幂等；随机 loopback、Host/Origin/capability/协议；正式/Mock 双构建与真实启动冒烟；Desktop 后续由 WA-017 收口 | 未调用真实付费模型；完整诊断包已由 WA-015 扩展；独立干净机 RC 仍待 WA-018 |
| WA-012 块级修改/锁定/差异/冲突 | `COMPLETE_LOCAL` | `BodyDocument`/revision/lock 领域合同、SQLite schema v5、Client Bridge v3、稿件与版本右栏、`REVISION_CONTRACT.md`、`WA012_RESULTS.md` | 86 项 runtime；8 项 UI、8 项 Bridge/Host、7 项 UI/来源 Python 检查；AT-08/09/10/27/33 本地映射；实际 Chromium 面板/版本/项目隔离检查；WA-025 已复验真实编辑链 | 未调用真实付费模型；当前为 Markdown 整块编辑且不自动三方合并；正文 heading 可锁，独立 title Artifact 编辑入口仍未实现；事实/来源只读查询已由 WA-013 接入；无远端 CI/发布 |
| WA-013 事实门禁/失效/来源 | `COMPLETE_LOCAL` | `fact-check-v2` TS 领域合同、SQLite schema v6、TS/Python 差分、Client Bridge v17、“核查与来源”右栏、`FACT_CHECK_CONTRACT.md`、`WA013_RESULTS.md` | 真实模型先阻断 partial 主张；11 处修改后旧快照 stale，专项重查 passed；partial/none/red 文案与程序门禁一致 | 来源边不证明现实事实绝对正确；无外部检索、远端 CI 或发布 |
| WA-014 工作备份/统一正式导出 | `COMPLETE_LOCAL` | `writing-core` 统一导出门禁、SQLite schema v7 `exports`、Application/CLI、Client Bridge v17、“备份与交付”页签、三种 HTML 排版、`EXPORT_CONTRACT.md`、`WA014_RESULTS.md` | 真实模型 blocked 时正式按钮禁用；重查 passed 后 TXT/HTML 同快照导出；三种排版内容/hash 与 Bridge 透传通过，杂志 HTML 已在协议 v16 真实 provider 旅程中读回 | 未对外发布或上传 |
| WA-015 第二协议/Key/网络/诊断 | `COMPLETE_LOCAL` | Anthropic-compatible adapter、schema v2 provider config、Windows Credential Manager/CLI、SecureWebFetcher、脱敏诊断包、`MODEL_PROTOCOL_MATRIX.md`、`SECURITY_AND_DIAGNOSTICS.md`、`WA015_RESULTS.md` | Anthropic wire/error/abort；Windows 假凭据实机写读删；DNS pin/redirect/HTML；诊断 ZIP；MiniMax-M3 Anthropic-compatible 真实连接与共创通过；Electron 边界由 WA-017 收口 | OpenAI-compatible 商业端点、独立干净机与其他模型仍待验收；无远端 CI/发布 |
| WA-016 Legacy 只读迁移 | `COMPLETE_LOCAL` | `packages/legacy-migration`、CLI `migrate scan/apply/rollback`、`LEGACY_MIGRATION_GUIDE.md`、`MIGRATION_RESULTS.md` | 15 项迁移测试与 3 项静态边界；两类合法合成来源；扫描/空间/目标预检、源/目标备份及复验、中断重试、旧 passed/风格降级、Bridge 打开、精确回退；Electron 发行闭包后续由 WA-017 收口 | 未迁移真实客户库或 Key；未做真实满盘/企业 ACL/旧应用并发写；干净机完整迁移旅程仍待 WA-018 |
| WA-017 Windows 桌面分发 | `COMPLETE_LOCAL` | `apps/desktop`、Desktop Bridge v17、rc.6 NSIS/校验和/安装及升级测试脚本、`WA017_RESULTS.md` | rc.6 打包后协议 v17 renderer/IPC/SQLite handshake 通过且 stderr 为空；rc.4 正常/缺失登记→rc.5 已验证两阶段进度、数据/快捷方式保留和卸载机制 | rc.5→rc.6 精确原位升级、独立干净机、其他 Windows/硬件/辅助技术待最终验收；当前候选 unsigned |
| WA-018 RC 38 项验收 | `BLOCKED_EXTERNAL` | `RC_RESULTS.md`、`apps/desktop/scripts/run_rc_validation.ps1`、真实 UAT 报告 | 本机自动矩阵、Anthropic-compatible MiniMax-M3 Quick/Deep、事实阻断/重查/导出与安装器均有真实证据 | AT-01 独立干净机和 OpenAI-compatible 商业端点仍未执行，维护者不能最终签收 |
| WA-019 质量与 5 人上手 | `BLOCKED_EXTERNAL` | 三组 A/B/C 盲评工具、12 例夹具、`QUALITY_AND_USABILITY.md`、`UX_TEST_LOG.md` | 三组随机化/评分/否决/汇总自动测试；维护者探索式真实桌面测试与代表性文章闭环通过 | 正式实验仍为 0/12 三组文章、0/5 独立参与者；不宣称总体质量提升 |
| WA-020 文档与发布材料 | `IMPLEMENTED_NOT_VERIFIED` | README、`QUICKSTART_1_0.md`、演示/PR/Release 草稿、Issue/PR 模板 | 所有草稿明确未发布、无假下载入口 | 依赖 WA-018/019；最终资产/模型/质量数据待回填 |
| WA-021 发布门禁 | `BLOCKED_EXTERNAL` | `RELEASE_GATE.md`、本地 SHA256、签收清单 | 本地产物/来源/回退已审计 | 真实模型、质量/用户实验、签名决定和维护者签收未完成 |
| WA-022 主线与 Release | `BLOCKED_EXTERNAL` | 本地 PR/Release 草稿 | 未执行远程写入，符合授权边界 | 需 WA-021 关闭且维护者明确授权；无 commit/push/PR/tag/Release |
| WA-024 集中主题/品牌与写作 Slot | `COMPLETE_LOCAL` | `brand/config.ts`、`theme/config.ts`、Slot contracts、`packages/writing-ui`、Client Bridge v6 持久设置、独立 extension demo、`UI_EXTENSION_GUIDE.md`、`WA024_RESULTS.md` | UI/registry 16/16；Bridge/Host/设置 12/12；三构建分发隔离、源码边界；Chromium 挂载/卸载/默认工作台/跨项目状态；WA-025 完成视觉/协议复验，WA-017 完成 Desktop 身份/安装包 | 演示不是正式功能；未做在线市场/动态插件；无远端 CI/公开发布 |
| WA-025 UI 视觉/Bridge 一致性验收 | `COMPLETE_LOCAL` | `UI_BASELINE_RESULTS.md`、更新后的 allowlist、确定性 fixture/Host/Playwright 脚本、截图/hash/JSON 报告、真实 UAT 截图 | 基线覆盖明暗/system、双视口、锁定/差异/门禁失效/项目隔离/设置持久化；rc.4 主对话专项、rc.5 两阶段安装页和 rc.6 项目生命周期专项均有截图与报告 | Firefox/WebKit、200% OS 缩放、屏幕阅读器、远端 CI 与最终用户签收未执行 |
| P0-F 连续共创体验恢复 | `BLOCKED_CORE_WORKFLOW` | 既有导航/成果展示/版本工作台和安装证据保留 | 页面和固定共创检查点有历史证据，但材料不足时仍能一口气跑完，不能证明连续交互 | 必须先通过 CR-002 的缺口交互、独立任务、返工与交付语义验收，再申请最终用户签收 |

## WA-004 已固定的关键决定

- Application Service 是 CLI/Web/Desktop 的唯一写边界；`writing-core` 与 UI/provider/容器解耦。
- 新 runtime 使用 Node 24.15+ 与内置 `node:sqlite`，经 StoragePort 隔离；根 legacy 包继续保持 Node 18.17+，现有 CI 仍用 Node 20。
- 新桌面路线为 DSH 同源 Electron 最小壳；不恢复旧 Tauri，不携带 DSH/Claude 外部宿主。
- legacy 只做 dry-run/确认/备份后的只读来源迁移；`working_copy` 与 `publication` 是不同命令和文件语义。
- DSH UI 按可执行竖切闭包直接源移植；保留来源/Slot/typed bridge 边界，旧 UI 禁止进入依赖闭包。

## 验证入口

- M0 架构与基础环境：`npm run check:m0`
- WA-005 类型与存储：`npm run check:runtime`
- WA-006 模型协议与 adapter：`npm run check:runtime`，详见 `docs/testing/WA006_RESULTS.md`
- WA-007 工具注册与权限：`npm run check:runtime`，详见 `docs/testing/WA007_RESULTS.md`
- WA-008 自有循环与请求快照：`npm run check:runtime`，详见 `docs/testing/WA008_RESULTS.md`
- WA-009 取消、恢复与预算：`npm run check:runtime`，详见 `docs/testing/WA009_RESULTS.md`
- WA-010 中性写作能力包与文章闭环：`npm run check:runtime`，详见 `docs/testing/WA010_RESULTS.md`
- WA-023 DSH UI 源码基线：`npm run check:ui`，详见 `docs/testing/WA023_RESULTS.md`
- WA-011 Client Bridge/Local Web：`npm run test:bridge`、`npm run check:ui`，详见 `docs/testing/WA011_RESULTS.md`
- WA-012 块级修订/锁定/差异：`npm run check:runtime`、`npm run test:bridge`、`npm run check:ui`，详见 `docs/testing/WA012_RESULTS.md`
- WA-013 事实门禁/失效/来源：`npm run check:runtime`、`npm run check:m0`、`npm run test:bridge`、`npm run check:ui`，详见 `docs/testing/WA013_RESULTS.md`
- WA-014 工作备份/正式导出：`npm run check:runtime`、`npm run check:m0`、`npm run test:bridge`、`npm run check:ui`，详见 `docs/testing/WA014_RESULTS.md`
- WA-015 第二协议/Key/网络/诊断：`npm run check:runtime`、`npm run check:m0`、`npm run check:ui`，详见 `docs/testing/WA015_RESULTS.md`
- WA-016 Legacy 只读迁移：`npm run test:migration`、`npm run check:runtime`、`npm run check:m0`，详见 `docs/testing/MIGRATION_RESULTS.md`
- WA-017 Windows 桌面分发：`npm run check:desktop`、`npm run desktop:package`、`apps/desktop/scripts/test_desktop_installer.ps1`、`apps/desktop/scripts/test_desktop_upgrade.ps1`，详见 `docs/testing/WA017_RESULTS.md`
- WA-018 本地 RC 矩阵：`apps/desktop/scripts/run_rc_validation.ps1`，详见 `docs/testing/RC_RESULTS.md`
- 最终用户签收旅程：`docs/testing/FINAL_USER_UAT_CHECKLIST.md`
- WA-019 质量/易用性：`python -B -m unittest tests.test_writing_evaluation`，详见 `docs/testing/QUALITY_AND_USABILITY.md`
- WA-024 集中主题/品牌与写作 Slot：`npm run check:ui`、`npm run check:m0`，详见 `docs/testing/WA024_RESULTS.md`
- WA-025 UI/Bridge 一致性：`python -X utf8 tests/ui-baseline/scripts/wa025_ui_playwright.py --serve-static --upstream-dist <fixed-upstream-dist>`、`npm run test:bridge`、`npm run check:ui`，详见 `docs/testing/UI_BASELINE_RESULTS.md`
- 整仓 legacy 回归：`npm run check`
- 需求包一致性：`python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py`
- WA-004 详细结果：`docs/testing/WA004_RESULTS.md`
- WA-005 详细结果：`docs/testing/WA005_RESULTS.md`
- WA-006 详细结果：`docs/testing/WA006_RESULTS.md`
- WA-007 详细结果：`docs/testing/WA007_RESULTS.md`
- WA-008 详细结果：`docs/testing/WA008_RESULTS.md`
- WA-009 详细结果：`docs/testing/WA009_RESULTS.md`
- WA-010 详细结果：`docs/testing/WA010_RESULTS.md`
- WA-023 详细结果：`docs/testing/WA023_RESULTS.md`
- WA-011 详细结果：`docs/testing/WA011_RESULTS.md`
- WA-012 详细结果：`docs/testing/WA012_RESULTS.md`
- WA-013 详细结果：`docs/testing/WA013_RESULTS.md`
- WA-014 详细结果：`docs/testing/WA014_RESULTS.md`
- WA-015 详细结果：`docs/testing/WA015_RESULTS.md`
- WA-016 详细结果：`docs/testing/MIGRATION_RESULTS.md`
- WA-017 详细结果：`docs/testing/WA017_RESULTS.md`
- WA-018 RC 状态：`docs/testing/RC_RESULTS.md`
- WA-019 质量与上手状态：`docs/testing/QUALITY_AND_USABILITY.md`
- WA-021 发布门禁：`docs/testing/RELEASE_GATE.md`
- WA-024 详细结果：`docs/testing/WA024_RESULTS.md`
- WA-025 详细结果：`docs/testing/UI_BASELINE_RESULTS.md`

## 记录规则

1. 后续每项任务更新本表时，同时链接具体实现、测试结果和已知跳过项。
2. `READY` 只表示依赖已满足，不表示代码已存在。
3. 本地完成、远端 CI 通过、人工 UI 验收、安装包验收和公开发布分别记录。
4. 上游源码只有在 registry 存在 copied file/hash 且测试通过后，才允许改为 `ported_verified`。
