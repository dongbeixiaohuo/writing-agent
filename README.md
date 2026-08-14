# 写稿Agent v0.10.0

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Desktop App](https://img.shields.io/badge/Desktop%20App-Windows%20Preview-2f6f4f)](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/app-preview-0.1.0)
[![Writing Workflow](https://img.shields.io/badge/Writing%20Workflow-Stage%20Driven-1f6feb)](https://github.com/dongbeixiaohuo/writing-agent)

把写作从“一次性吐全文”，改成“分阶段策划、证据留痕、审稿、去 AI 味、导出终稿”的流水线。

你拿到的不只是文章，更是一套能反复复用、能中断继续、能回头复盘的写作生产线。

它适合这几类人：

- 想写长文、观点文、公众号文章，不想再靠一把梭 prompt 碰运气
- 想让 AI 写作过程可中断、可修改、可复盘
- 不只想拿到一篇文，而是想把写作变成稳定、可控、可积累的工作流

当前实测可用模型：

- `DeepSeek-V3.2`：默认推荐，最适合低成本先把完整流程跑明白
- `智谱 GLM`：已实测，不分伯仲
- `MiniMax`：已实测，不分伯仲

---

## 桌面预览版

现在可以直接下载 `Writing Agent App` 的 Windows 预览版：

- [下载 Writing Agent App 预览版 0.1.0](https://github.com/dongbeixiaohuo/writing-agent/releases/download/app-preview-0.1.0/Writing.Agent.App_0.1.0_x64-setup.exe)

桌面应用源码位于：

- `writing-agent-app/`

如果你只想直接使用桌面应用，优先下载上面的安装包。  
如果你想查看或参与源码开发，可以直接看仓库里的 `writing-agent-app/` 目录。

---

## 快速入口

- 下载桌面应用：[桌面预览版](#桌面预览版)
- 先看完整样本：[工资的一半，是你受的气折算的 Demo](#完整-demo工资的一半是你受的气折算的)
- 再看当前版本：[最新更新](#最新更新)
- 先判断模型成本：[模型与 Coding Plan](#模型与-coding-plan)
- 想直接部署：[完整版安装](#完整版安装)
- 想按新手路径一步步装：[给新手的完整安装与使用说明](#给新手的完整安装与使用说明)

---

## 先看一个完整样本

如果你只想先判断这个仓库值不值得收藏，不要先看安装，先看这个真实样本：

[`demo/工资的一半，是你受的气折算的/`](demo/工资的一半，是你受的气折算的/)

这不是只放一篇成品，而是把整条写作链路都放出来了，包括：

- 选题和约束：[01_theme.md](demo/工资的一半，是你受的气折算的/01_theme.md)
- 观点定牙齿：[01b_position.md](demo/工资的一半，是你受的气折算的/01b_position.md)
- 伤疤和证据：[02_scar_tissue.md](demo/工资的一半，是你受的气折算的/02_scar_tissue.md)、[02_evidence_ledger.json](demo/工资的一半，是你受的气折算的/02_evidence_ledger.json)
- 结构和开头：[03_outline.md](demo/工资的一半，是你受的气折算的/03_outline.md)、[05c_opening_hook.md](demo/工资的一半，是你受的气折算的/05c_opening_hook.md)
- 草稿和去 AI 味：[draft_v1.md](demo/工资的一半，是你受的气折算的/draft_v1.md)、[draft_v1_humanized.md](demo/工资的一半，是你受的气折算的/draft_v1_humanized.md)
- 审稿和传播测试：[pre_publish_review.md](demo/工资的一半，是你受的气折算的/pre_publish_review.md)、[wechat_reader_test.md](demo/工资的一半，是你受的气折算的/wechat_reader_test.md)
- 事实核查：[fact_claims.json](demo/工资的一半，是你受的气折算的/fact_claims.json)、[fact_check_report.md](demo/工资的一半，是你受的气折算的/fact_check_report.md)
- 纯文本候选稿：[draft_v1_humanized_clean.txt](demo/工资的一半，是你受的气折算的/draft_v1_humanized_clean.txt)
- 运行态记录：[run_manifest.json](demo/工资的一半，是你受的气折算的/run_manifest.json)（事实结论同时绑定正文与锁定标题 SHA-256）

建议浏览顺序：

```text
01_theme.md
-> 01b_position.md
-> 02_scar_tissue.md + 02_evidence_ledger.json
-> 03_outline.md
-> 05c_opening_hook.md
-> draft_v1.md
-> draft_v1_humanized.md
-> fact_claims.json + fact_check_report.md
-> draft_v1_humanized_clean.txt
```

如果你看完这套 Demo 觉得“这不是一次性吐全文，而是一条可复盘的生产线”，那这个仓库的核心价值你已经看到了。

---

## 完整 Demo：工资的一半，是你受的气折算的

下面不是虚构示例，是这个仓库里一篇真实跑完的文章项目。

- Demo 目录：[`demo/工资的一半，是你受的气折算的/`](demo/工资的一半，是你受的气折算的/)
- 文章标题：`工资的一半，是你受的气折算的`
- 主题：`工资的一半是“技术溢价”，一半是“情绪折价”`
- 核心判断：`你的工资不是你值多少，而是市场价减去组织税之后剩下的数`
- 完整过程文件都在这个目录里，包含选题、立场、伤疤、证据账本、大纲、开头赛马、草稿、审稿、传播测试、事实核查和纯文本稿

这套 Demo 主要传达这些信息：

- 这是一条完整生产线，不是只放终稿
- 默认发布出口仍然是 `_clean.txt`，也可以在最后一步额外导出公众号排版 `.html`
- 这个样本真实包含调研阶段的事实证据账本，以及交付前的事实声明和核查报告
- 核查报告保留了 2 条黄色修改建议、0 条红色问题，展示工作流如何暴露风险；正式发布前仍应处理黄色建议
- 该历史样本使用的“记忆大师风格”目前标记为 `legacy_unverified`；可以参考方向，但不代表已完成跨样本风格验证
- 中间产物本身就能证明“可调度、可中断、可复盘”

最关键的几个文件：

- [01b_position.md](demo/工资的一半，是你受的气折算的/01b_position.md)：先把文章的“牙齿”定下来，避免后面越写越软
- [02_scar_tissue.md](demo/工资的一半，是你受的气折算的/02_scar_tissue.md)：不是堆资料，而是打捞致命场景、隐秘代价、荒诞细节
- [02_evidence_ledger.json](demo/工资的一半，是你受的气折算的/02_evidence_ledger.json)：给数字、引文和历史材料建立可追踪的证据账本
- [04_share_map.md](demo/工资的一半，是你受的气折算的/04_share_map.md)：不是只做共情，而是设计读者为什么愿意转发
- [05c_opening_hook.md](demo/工资的一半，是你受的气折算的/05c_opening_hook.md)：先赛马开头，再锁定起手式
- [pre_publish_review.md](demo/工资的一半，是你受的气折算的/pre_publish_review.md)：发布前追问和红队挑刺
- [wechat_reader_test.md](demo/工资的一半，是你受的气折算的/wechat_reader_test.md)：该历史样本记录公众号私域场景；v0.10.0 新项目会按公众号、头条或知乎切换测试矩阵
- [fact_check_report.md](demo/工资的一半，是你受的气折算的/fact_check_report.md)：把通过项、黄色建议和红色问题分级留痕
- [draft_v1_humanized_clean.txt](demo/工资的一半，是你受的气折算的/draft_v1_humanized_clean.txt)：去 AI 味后的纯文本候选稿

如果你只看最终效果，这篇 Demo 的发布出口就是：

```text
demo/工资的一半，是你受的气折算的/draft_v1_humanized_clean.txt
```

---

## 最新更新

首页前部只保留最近主线版本，历史版本不再堆在前面。

### v0.10.0 平台增长闭环与双版本事实门禁

这一版把流程从“正文写得可信”继续推进到“标题也可信、平台用得上、发布后能复盘”：

- **事实放行同时绑定标题与正文**：Stage 10.5 显式核查锁定标题、最终分发文案和正文；`run_manifest.json` 同时记录两份 SHA-256，任何一边改动都会让旧结果变成 `stale`
- **标题接入证据与立场**：`title-designer` 正式读取 `01b_position.md` 和 `02_evidence_ledger.json`，区分结构数字与事实数字，禁止凭空制造金额、比例、年龄或年份
- **平台字段真正参与交付**：标题阶段同步给出 3 条公众号摘要、头条信息流导语或知乎回答导语；Stage 9 根据平台切换定性矩阵，不再拿微信群聊逻辑测试所有文章，也不伪造 CTR/完读率预测
- **模式 C 与记忆包进入机器契约**：选题生成、验证、交接 Stage 1 都写进 `collab_v2.json`；下游真实消费者显式依赖 `00_memory_packet.md`，动态正文占位符从 `run_manifest.json` 安全解析
- **风格档案有验证状态**：新增 `style_registry.json`；六六、耍大刀标记为已验证，其余 5 份历史档案降级为低置信度方向参考，不再冒充跨样本稳定风格
- **风格建模与登记状态闭环**：`style-modeler` 会先解析开发仓库或插件工作区的可写风格根目录；新档案由原子注册工具登记为 `legacy_unverified`，只有证据账本、陌生主题验证和独立盲测全部通过后，才能显式升级为 `verified`
- **发布后数据闭环**：可选 Stage 14 用 `publication_metrics.jsonl` 追加记录曝光、打开、完成阅读、分享等指标，并绑定标题/正文/封面版本、观察窗口和流量来源；单篇只产出假设，跨项目可比后才进入记忆候选
- **互动不靠骗评**：Share Map 和大纲新增真实讨论入口，明确禁止虚假二选一、强迫站队和“扣 1”式伪互动

升级后，v0.9.1 及更早项目即使已有正文哈希，只要缺少 `fact_checked_title_file` / `fact_checked_title_sha256`，也会被视为旧式未完整绑定状态，需要针对当前锁定标题与正文重新执行 Stage 10.5。完整说明见 [v0.10.0 Release Notes](.github/releases/v0.10.0.md)。

### v0.9.1 写作可信度与交付门禁补丁

这一版重点解决“文件看起来齐全，但可能不是用户确认的那一版”以及“去 AI 味时为了生动而补出假经历”两类风险：

- **事实结论绑定正文**：`fact_check_status` 同时记录被核查正文的文件名和 SHA-256；正文哪怕只改一个字，旧的 `passed` 都会自动变成 `stale`，不能继续生成 `_clean.txt`
- **Humanizer 不再造经历**：去 AI 味前必须读取 `01_theme.md` 和 `02_evidence_ledger.json`；只能强化已有真实素材，禁止新增第一人称亲历、金额、日期、人物、对话和无来源细节
- **Stage 6 改为语义门禁**：主题必须有用户确认的风格，证据账本必须是合法且字段完整的 JSON，标题和开头必须记录用户已锁定的选择；单纯创建非空占位文件不再算完成
- **自动清稿严格限定项目**：正常流程只接受 `--project` 或 Hook 明确传入的正文，不再跨 `articles/` 猜“最近修改的终稿”，避免并行项目串稿
- **网页主地址先过安全预检**：不仅图片 URL，用户给出的正文页面及每次跳转也会检查协议、凭据、DNS 和私网/保留地址；导航后还会复核 `window.location.href`
- **依赖与 CI 门禁更新**：生产依赖中的 high/moderate 漏洞已通过锁文件升级消除；CI 新增 high 级依赖审计与真实隔离插件安装，`npm run check` 也纳入工作流和文档契约校验

升级后，旧 `run_manifest.json` 中只有 `fact_check_status=passed`、却没有正文哈希绑定的项目会被视为 `stale`，需要重新执行 Stage 10.5。最低 Node.js 版本同步调整为 `18.17.0`。完整说明见 [v0.9.1 Release Notes](.github/releases/v0.9.1.md)。

### v0.9.0 运行时、安全与插件交付重构

这一版不只调整写作提示词，而是把“clone 能跑、plugin 也能独立跑、失败时不会越权交付”做成了可验证的运行时契约：

- **工作流契约统一**：Mode A/B/C 的阶段、必需产物和自动跳转全部由 `collab_v2.json` 约束；事实核查未通过时，自动清稿、配图和 HTML 交付都不会放行
- **插件真正独立运行**：插件脚本固定从 `${CLAUDE_PLUGIN_ROOT}` 调用，Node 依赖安装在 `${CLAUDE_PLUGIN_DATA}`，不再依赖用户工作区里恰好存在本仓库的 `scripts/` 或 `node_modules/`
- **网页与导出安全加固**：网页内容按不可信输入处理；图片下载增加内网地址、DNS 重绑定、跳转、MIME、体积和超时校验；HTML 导出增加 XSS 清理和原子写入
- **风格建模证据化**：稳定风格特征至少需要跨样本证据，单篇观察只作为候选；量化脚本修复句长中位数、段落和标点统计偏差
- **可发布验证链**：新增 Windows/Linux CI、107 项回归测试、Python 无落盘语法检查、插件严格校验、npm 打包预检和隔离工作区安装测试

本版同时将三个 Skill 目录对齐其 frontmatter 名称：

| 旧目录 | 新目录 |
|------|------|
| `风格建模` | `style-modeler` |
| `工作流导演` | `workflow-producer` |
| `公众号文章获取` | `web-article-extractor` |

正常 `git pull` 会完成目录迁移；如果你有自定义脚本、快捷命令或文档直接引用旧目录，需要同步更新路径。完整变更见 [CHANGELOG](CHANGELOG.md)，面向发布和升级的说明见 [v0.9.0 Release Notes](.github/releases/v0.9.0.md)。

### v0.8.1 风格提取重大升级：从"形似"到"神似"

如果你用过风格库功能，可能遇到过这种情况：让 AI 学一个作者的风格，学出来的东西看着眼熟——设问推进、具体案例、金句收尾——但换个话题一写，读者一眼就能看出"这不是那个人"。

问题出在提取方法上：之前的风格建模，很容易把"任何优秀公众号写手都会这么写"的通用公式，当成了"只有这个作者才这么写"的独有指纹。这一版重构了风格建模的整套方法论和工具链，并用新流程把风格库里的示范文件全部推倒重来：

- **量化指纹脚本**：句长、问句占比、段落长度这些节奏结论，过去全靠肉眼估。现在用脚本对样本实测——这一测就测出旧文件里两处纯凭印象写错的结论（"耍大刀风格"旧版写"短句为主"，实测平均句长其实是 32 字；"每2-3段设问"实测问句占比只有 3.4%）
- **区分性检验**：风格内核的每一条特征都要过两道关——"随便一个优秀写手是不是本来就这么做"、"是不是和风格库里其他作者撞脸了"。通不过的降级成"通用基线"，不再冒充作者独有指纹
- **判断库（观点指纹）**：新增"这个作者反复表达的实质判断是什么、价值排序是什么"——句式可以模仿，但一个人会得出什么结论，是仿不出来的
- **独立盲测验证**：仿写验证不再是自己写完自己打分（这样的分数必然虚高），改成拉一个完全没见过风格文件的独立 AI，把原文和仿写打乱顺序让它猜"哪个是仿的"。它猜错了，才算真的过关

用新流程重新提取的两份风格文件（[耍大刀风格](.claude/styles/耍大刀风格.md)/金错刀、[六六的风格](.claude/styles/六六的风格.md)/刘润）已经验证：独立盲测员被骗过，误把原文当成了仿写。六六风格这一轮还挖出一条此前完全没发现的硬指纹——**全篇零感叹号**，靠短句和逗号顿挫表达情绪，而不是靠标点抒情。

如果你之前觉得"风格学出来的文章有点像，但总差点意思"，这一版就是冲着这个问题去的。

### v0.8.0 个性注入与反模板（Fable 5 优化版）

这一版解决的问题，用一句话说：**之前的流程能保证文章"不像AI写的"，但保证不了"值得读"。**

此前的真实痛点：流水线跑完 14 个阶段、通过全部检查，成稿仍然是"第一个坑…第五个坑"式的对称排比清单文——数据是编的、案例是虚构的"老张"、风格只学了口头禅没学判断方式。这一版由 Claude Fable 5 对全链路做了一次针对性诊断和重构，把质量控制从"负向拦AI腔"升级为"正向产个性"：

- **真实素材采集（新增卡点）**：写作前强制向你要 1-2 条真实经历、真实观点或亲历细节；你说没有，全流程就禁止虚构"我一个朋友老张"式假故事。个性的唯一来源是真素材，现在从源头保证它存在
- **风格内核管道化**：立场、大纲、素材调研阶段现在都要先读风格文件的"判断方式"（作者首先看见什么、论证发动机），而不是等到动笔才贴口头禅——解决"形似神不似"
- **结构反模板**：大纲阶段硬性限制全文最多 1 处编号列表、相邻章节禁止同构，从结构层消灭AI排比，这是句子级规则管不到的最大模板味来源
- **素材防编造**：伤疤素材库禁止出现任何没有证据ID的数字和百分比，"少而真"压倒"多而假"
- **评审去通胀**：主编审稿新增"无聊段落淘汰"（每段必须有新信息/新观点/新画面）和"风格盲测对照"（与作者原文并排找露馅点）；微信读者测试必须回答"我在第几段想关掉"；复盘禁止给自己打分
- **写作用最强模型**：正文写作和去AI味两个最吃创造力的环节解除了模型钉死，改为继承会话模型
- **正文纯净**："分享指南"之类的模板产物不再混进终稿

如果你之前用这套流程写出来的文章总觉得"哪都对但没人想看完"，这一版就是冲着这个问题去的。

### v0.7.8 新增事实证据账本与发布前核查

- Stage 2 `research-expert` 现在会同步生成 `02_evidence_ledger.json`：数字、日期、机构、人名、公司名、报告、政策、网页链接等事实性内容都要有 `evidence_id`
- Stage 6 `writing-executor` 写作时必须读取证据账本：没有证据的内容只能写成观点或生活观察，不能伪装成“数据显示”“研究表明”“报告指出”
- 新增 Stage 10.5 `fact-checker`：在 Humanizer 之后、生成 `_clean.txt` 之前抽取正文事实 claim，反查证据账本和外部来源
- 遇到 `CONTRADICTED`、`BROKEN_LINK`、`NEEDS_USER_SOURCE` 或红色 `UNSUPPORTED`，流程会停机，禁止继续进入配图、纯文本终稿或 HTML 导出
- 同步补齐 `claude-runtime/` 和 plugin 分发目录，避免 clone 用户和 plugin 用户拿到不同工作流

这版解决的是“文章写得像人，但事实可能是错的”这个硬伤。现在流程会先要求事实有来源，再在最终提交前拦一次高风险幻觉。

### v0.7.7 新增公众号排版 HTML 导出

- 新增 `html-exporter` 末端导出器：最终 Markdown 定稿后，可以额外导出一份适合公众号排版和复制的 `.html`
- 内置 4 种默认版式可选：`经典正文（default）`、`精致长文（grace）`、`极简评论（simple）`、`现代杂志（modern）`
- 保留 `_clean.txt` 作为默认纯文本出口：你可以只拿纯文本，也可以同时拿纯文本和排版 HTML
- 收紧 Stage 12.5 契约、运行态记录和回归测试，让“是否导出 HTML、选择哪种版式”变成真实流程，而不是 prompt 口头约束

如果你关心的是“最后到底能交付什么”，这一版的答案很直接：**正文、可直接复制的 `_clean.txt`、可选的公众号排版 `.html`，都能稳定落地。**

### v0.7.6 深化生产骨架

- `research-expert` 从泛泛调研改成“伤疤打捞”，核心产物是 [02_scar_tissue.md](demo/工资的一半，是你受的气折算的/02_scar_tissue.md)
- `empathy-designer` 从共情点设计升级成“社交转发动机”，核心产物是 [04_share_map.md](demo/工资的一半，是你受的气折算的/04_share_map.md)
- 新增 `opening-tournament`，在正式写稿前先赛马开头，核心产物是 [05c_opening_hook.md](demo/工资的一半，是你受的气折算的/05c_opening_hook.md)

如果你只想知道仓库现在值不值得拉下来试，先看 `v0.10.0` 和 `v0.9.1` 这两节就够了。更老的版本记录去 [CHANGELOG](CHANGELOG.md) 或 Releases 看，不应该堵在首页前面。

---

## 模型与 Coding Plan

这个项目不一定非要跑 Claude 官方模型。对大多数人来说，更实用的是通过 Anthropic 兼容接口接第三方模型。

当前推荐逻辑很简单：

- 想最低成本先把完整流程跑通：`DeepSeek-V3.2`
- 已经有 `智谱 GLM` 或 `MiniMax` 套餐：直接用，也已经实测过，效果不分伯仲
- 每个月会高频写作、频繁审稿和反复改稿：直接考虑 `Coding Plan`
- 需要在多家兼容接口之间反复切换：上 [CC-Switch](https://github.com/farion1231/cc-switch)

为什么首页默认先写 `DeepSeek-V3.2`：

- 不是因为它明显强于另外两家
- 而是最早测试路径最便宜，先充 10 块钱就足够把这套流程从头到尾验证一遍

首页只保留一个简表：

| 场景 | 推荐 |
|------|------|
| 首次验证完整流程 | `DeepSeek-V3.2` 按量付费 |
| 已有其他平台套餐 | `智谱 GLM` / `MiniMax` 直接接入 |
| 中高频长期使用 | `Coding Plan` |
| 多模型来回切换 | `CC-Switch` |

完整的模型接入文档、Coding Plan 地址和选型建议，见下方 [模型和成本怎么选](#模型和成本怎么选)。

---

## 它和普通 AI 写作工具有什么不一样

普通 AI 写作：

- 一次性生成全文
- 改一轮就开始漂
- 风格、结构、审稿全混在一个大 prompt 里
- 很难知道文章为什么好，为什么差

写稿Agent：

- 先定主题和立场
- 再打捞场景、代价和细节
- 同步建立事实证据账本，给可核查内容留来源
- 再做大纲、分享触点、具象化和开头赛马
- 写完后还有主编审稿、发布前评审、微信传播测试、去 AI 味
- 去 AI 味之后先过事实核查闸门，红色问题不放行
- 最后输出 `_clean.txt` 终稿，并可按需额外导出公众号排版 `.html`

一句话说：

**它不是“让 AI 帮你写一篇文章”，而是“把写作拆成可调度、可中断、可复盘的流程”。**

---

## 适合谁，不适合谁

适合：

- 写公众号文章、长文观点文、行业评论的人
- 对“AI 味”“结构松”“标题软”“开头弱”敏感的人
- 想把 AI 写作纳入稳定工作流的人

不适合：

- 只想一句话秒出 300 字短文的人
- 不关心中间产物、只关心快的人
- 不想做任何确认和审稿的人

---

## 完整版安装

完整版不是只靠一个 Skill 在跑，它依赖整个仓库一起工作：

- `.claude/skills/`
- `.claude/agents/`
- `.claude/workflows/`
- `scripts/`

最短路径：

1. 先准备 `Node.js 18.17+`、`Python 3.11+` 和 `Claude Code`
2. clone 本仓库并执行 `npm ci`
3. 配好你要用的模型 API 或 Claude 账号
4. 一定在项目根目录启动 `claude`
5. 先用 [`demo/工资的一半，是你受的气折算的/`](demo/工资的一半，是你受的气折算的/) 理解流程，再开始正式写作

如果你已经准备直接跑完整版，继续看：

- [给新手的完整安装与使用说明](#给新手的完整安装与使用说明)

### 现在有两种交付路径

从这一版开始，这个项目同时支持两种使用方式：

| 方式 | 适合谁 | 运行根目录 |
|------|------|------|
| `git clone` 仓库 | 想直接拿完整项目、看 demo、参与开发的人 | 仓库根目录 |
| `plugin` 安装 | 不想先 clone 仓库，只想在任意工作目录里使用工作流的人 | 你的当前工作目录 |

两条路径的底层运行时现在共用一套唯一源：

- `claude-runtime/`

然后再分别同步到：

- 项目兼容层：`.claude/`
- 插件目录：`plugins/writing-agent/`

### 如果你是 `git clone` 用户

用法不变：

1. clone 仓库
2. 在仓库根目录执行 `npm ci`
3. 在仓库根目录启动 `claude`
4. 继续按项目内 `.claude/`、`scripts/`、`demo/` 这套方式使用

### 如果你是 `plugin` 用户

插件模式的目标是：

- 安装插件后，不需要先 clone 这个仓库
- 在任意正常工作目录启动 `claude`
- 插件会通过工作区自举脚本补齐最小运行目录

当前仓库里已经包含插件骨架：

- `plugins/writing-agent/`
- `.claude-plugin/marketplace.json`

安装方式只保留最简单这一条。

假设仓库地址就是：

- `dongbeixiaohuo/writing-agent`

那用户只需要执行：

#### 1. 添加 marketplace

```bash
claude plugin marketplace add dongbeixiaohuo/writing-agent
```

#### 2. 安装插件

```bash
claude plugin install writing-agent@writing-agent-marketplace
```

#### 3. 重新加载插件

```text
/reload-plugins
```

装完之后，在你想写文章的目录里启动 `claude` 就可以了。

如果已经安装旧版，先更新 marketplace，再更新插件：

```bash
claude plugin marketplace update writing-agent-marketplace
claude plugin update writing-agent@writing-agent-marketplace
```

更新完成后重启 Claude Code，或执行 `/reload-plugins`。从 v0.8.x 升级时，如果自定义内容直接引用过中文 Skill 目录，还需要按上面的目录映射改成英文名称。

插件第一次进入一个空工作目录时，会自动补齐最小运行结构：

- `articles/`
- `.claude/styles/`
- `.claude/workflows/`

工作区自举采用“只补缺失文件”的策略：如果工作区里已经存在同名样式或工作流，现有文件优先，插件不会覆盖。插件脚本不会复制进用户工作区，而是刷新到 Claude 提供的 `${CLAUDE_PLUGIN_DATA}/runtime/`；HTML、配图等 Node 依赖按插件自己的 `package-lock.json` 首次执行 `npm ci --omit=dev --ignore-scripts`，后续只有依赖清单变化才重装。这样既不会污染现有项目，也不会因插件升级继续调用旧脚本。

因此插件首次启动需要能够访问 npm registry，首次安装时间会比后续启动长；依赖成功安装后会持久缓存。离线环境应先在联网环境完成一次启动并保留对应的 `${CLAUDE_PLUGIN_DATA}`，不能只复制插件源码后假设依赖已经存在。

两种路径都要求本机可以直接执行：

```bash
node --version
npm --version
python --version
```

最低版本为 `Node.js 18.17+`、`Python 3.11+`。Python 脚本只使用标准库；Node 依赖以根目录和插件目录各自的 `package-lock.json` 为准，不依赖用户手工猜包名。

---

## 给新手的完整安装与使用说明

如果你对这些东西还不熟：

- GitHub 仓库怎么 clone
- Claude Code 怎么装
- Node.js 为什么要装
- 模型和 API 怎么配
- 怎么确认项目真的跑起来了

那就直接按这一节来，不需要先去翻别的文档。

---

## 三种安装方式

Claude Code 支持 macOS、Linux、Windows。你该选哪条路，取决于你的系统和习惯。

| 安装方式 | 命令 | 适用平台 | 推荐度 |
|------|------|------|------|
| Native Install | `curl -fsSL https://claude.ai/install.sh \| bash` | macOS / Linux / WSL | ⭐ 推荐 |
| Homebrew | `brew install --cask claude-code` | macOS | 适合已经在用 brew 的人 |
| WinGet | `winget install --id Anthropic.ClaudeCode -e` | Windows | Windows 首选 |

核心建议：

- 不确定选哪个：macOS / Linux 直接用 Native Install
- 已经是 Homebrew 用户：用 `brew` 更顺手
- Windows：先装 Git for Windows，再走 WinGet

---

## 为什么 Node.js 和 Python 都要讲

这点必须说清楚。

本仓库的锁定依赖要求 `Node.js 18.17+`。提前准备好 Node.js 的原因有两个：

- 如果你后面想走 `npm` 路线安装、升级或调试 Claude Code，Node.js 是硬前置
- 这个仓库本身带了 `package.json` 和一些基于 Node 的脚本、工具链，后面你大概率还是会用到 `node` / `npm`
- 工作流的校验、自举、清理和运行状态脚本使用 `Python 3.11+`

所以最稳的建议是：

- 先装好 `Node.js 18.17+`
- 再装好 `Python 3.11+`
- 再装 Claude Code
- 最后 clone 仓库、执行 `npm ci` 并启动项目

### Node.js 怎么装

**Windows：**

- 官网下载安装：[nodejs.org](https://nodejs.org/)
- 或者直接用 WinGet：

```powershell
winget install OpenJS.NodeJS.LTS
```

**macOS：**

- 官网安装包
- 或者：

```bash
brew install node
```

**Linux：**

- 推荐用 `nvm`
- 或者用你发行版自己的包管理器

装完先验证：

```powershell
node --version
npm --version
```

能看到版本号，再继续下一步。

---

## Claude Code 怎么装

### macOS / Linux

打开终端，运行：

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

这个脚本会自动下载 Claude Code，并把 `claude` 命令放到你的 PATH 里。

如果你是 Homebrew 用户，也可以直接：

```bash
brew install --cask claude-code
```

装完验证：

```bash
claude --version
```

### Windows

Windows 这里建议按“Git for Windows + WinGet”这条路走。

#### 1. 先装 Git for Windows

从 [git-scm.com](https://git-scm.com/) 下载也可以，直接 WinGet 更省事：

```powershell
winget install --id Git.Git -e
```

它会顺带给你 Git Bash。Claude Code 在 Windows 上需要这类 Unix 工具链支持，所以这一步不要跳。

#### 2. 安装 Claude Code

```powershell
winget install --id Anthropic.ClaudeCode -e
```

如果你不用 WinGet，也可以改走官方 PowerShell 安装脚本：

```powershell
irm https://claude.ai/install.ps1 | iex
```

#### 3. 验证安装

重新打开 PowerShell 或 Git Bash，运行：

```powershell
claude --version
```

看到版本号就说明装好了。

#### 4. Windows 使用建议

- 推荐用 PowerShell 或 Git Bash
- 不推荐直接在 CMD 里折腾
- 如果你装了便携版 Git，Claude Code 找不到 Git Bash，再单独配置 `CLAUDE_CODE_GIT_BASH_PATH`

---

## 五种用法，选哪个

Claude Code 装好之后，常见有五种用法：

| 环境 | 特点 | 适合谁 |
|------|------|------|
| 终端 CLI | 最原生、能力最完整 | 日常开发主力方式 |
| VS Code 扩展 | 在 VS Code 侧边栏里用 | 已经重度依赖 VS Code 的人 |
| Desktop App | 图形界面更直接 | 不熟终端、但想先上手的人 |
| Web | 浏览器直接使用 | 临时体验 |
| JetBrains 插件 | IntelliJ / WebStorm 等集成 | JetBrains 用户 |

这份 README 和本仓库的所有说明，默认都以 **终端 CLI** 为基准。

原因很简单：

- 这个仓库强依赖“当前项目目录”这个上下文
- `.claude/skills/`、`.claude/agents/`、`.claude/workflows/` 都更适合按 CLI 路径理解
- 就算你后面要用 VS Code 或 JetBrains，也建议先把 CLI 这条路摸熟

---

## 账号和钱的事

你有两条常见路径：

- 直接用 Claude 官方订阅登录 Claude Code
- 不走 Claude 订阅，改用 Anthropic 兼容接口接第三方模型

这两条路不是互斥的，只是适用场景不同。

### Claude 官方订阅

如果你打算直接用 Claude 官方账号，常见档位是：

| 方案 | 当前常见价格 | 适合谁 |
|------|------|------|
| Pro | `$20/月` | 轻量使用、学习、个人开发 |
| Max 5x | `$100/月` | 高频使用、每天长时间对话 |
| Max 20x | `$200/月` | 重度使用、多人或商业项目 |

这组价格和额度变动比较快，最终以 Anthropic 官方页面为准。

简单选法：

- 你只是想先体验 Claude 官方服务：先从 `Pro` 开始
- 你每天都在用，或者很容易撞额度：再升 `Max 5x`
- 你是团队或商业重度使用：再看 `Max 20x`

### 这个仓库更常见的实际路径

对这个项目来说，更常见的用法其实是：

- 用 Anthropic 兼容接口
- 接 `DeepSeek-V3.2`、`智谱 GLM`、`MiniMax` 这类第三方模型
- 用更低成本把长链路写作流程跑通

所以你不用把“Claude 官方订阅”和“第三方模型 API”理解成二选一。

---

## 模型和成本怎么选

这个项目的模型选择逻辑，不是“谁绝对最强”，而是“谁更适合你的使用方式”。

### 按量付费模型

| 模型 | 当前定位 | 什么时候用 | 获取 API Key | 官方文档 |
|------|------|------|------|------|
| **DeepSeek-V3.2** | 默认推荐 | 第一次完整验证流程、预算敏感、想先充少量金额试跑 | [DeepSeek 平台](https://platform.deepseek.com) | [接入文档](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) |
| **智谱 GLM** | 已实测同级 | 已有 GLM 套餐或更习惯智谱生态 | [智谱开放平台](https://open.bigmodel.cn) | [接入文档](https://docs.bigmodel.cn/cn/coding-plan/tool/claude) |
| **MiniMax** | 已实测同级 | 已有 MiniMax 套餐或更习惯 MiniMax 平台 | [MiniMax 平台](https://platform.minimaxi.com) | [接入文档](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api) |

这里要说清楚：

- `智谱 GLM` 和 `MiniMax` 都已经实测过，和 `DeepSeek-V3.2` 不分伯仲
- README 里先强调 `DeepSeek-V3.2`，不是因为它明显更强
- 只是因为最开始测试时它的按量成本最低，先充 10 块钱就足够把一整条链路从头到尾跑明白

### Coding Plan 包月套餐

如果你会频繁使用本项目，按量付费不一定最省心。下面这些地址本身就值得收藏：

| 平台 | 首月特惠 / 入门档 | 常见续费 | 适合谁 | 链接 |
|------|------|------|------|------|
| 阿里云百炼 | `¥7.9 / ¥39.9` | 约 `¥40 / ¥200` | 量大、价格低、入口稳定 | [阿里云百炼](https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan#/efm/index) |
| 腾讯云 | `¥7.9 / ¥39.9` | 约 `¥40 / ¥200` | 腾讯云用户 | [腾讯云](https://cloud.tencent.com/act/pro/codingplan) |
| 百度千帆 | `¥7.9 / ¥39.9` | 约 `¥40 / ¥200` | 千帆用户 | [百度千帆](https://cloud.baidu.com/product/codingplan.html) |
| 火山引擎 | `¥9.9 / ¥49.9` | 约 `¥50+` | 字节生态用户 | [火山引擎](https://www.volcengine.com/activity/codingplan) |
| 无问芯穹 | `¥19.9 / ¥40` | `¥40 / ¥200` | 追求更高配额的人 | [无问芯穹](https://cloud.infini-ai.com/platform/ai) |
| MiniMax | `¥29/月` 起 | `¥290/年` 起 | 已在 MiniMax 生态内 | [MiniMax Coding Plan](https://platform.minimaxi.com/subscribe/coding-plan) |
| 智谱 GLM | `¥30/月` 左右 | `¥411/年` 左右 | GLM 用户 | [智谱 GLM Coding](https://open.bigmodel.cn/glm-coding) |
| Kimi Code | `¥49/月` 起 | 以官方页为准 | 想看 Kimi 方案的人 | [Kimi Code](https://www.kimi.com/code) |

这些套餐的价格、额度和活动会变化，最终以各平台页面为准。这里保留完整地址，是为了方便收藏和后续比较。

### 怎么选最省事

- 每月少量使用：`DeepSeek-V3.2` 按量付费
- 每月持续写、持续改：优先看 `Coding Plan`
- 手上已经有 `智谱 GLM` 或 `MiniMax` 套餐：直接接，不需要为了 README 刻意换

### 模型切换怎么搞

如果你不想手改环境变量，推荐直接用：

- [CC-Switch](https://github.com/farion1231/cc-switch)

它适合这类场景：

- 你在 `DeepSeek-V3.2`、`智谱 GLM`、`MiniMax` 之间切换
- 你不想反复改 `ANTHROPIC_BASE_URL`
- 你不想每次都重新整理 API Key

---

## 说第一句话

装好了，模型也有了，先不要急着正式写文章。先让 Claude Code 证明它真的能理解这个仓库。

### 1. 进入项目目录

```powershell
git clone https://github.com/dongbeixiaohuo/writing-agent.git
cd writing-agent
```

### 2. 启动 Claude Code

```powershell
claude
```

如果你走 Claude 官方账号，第一次启动会引导你登录。

如果你走第三方兼容接口，先把 `settings.json` 配好再启动。

### 3. 先说这句话

进入对话后，直接试一句：

```text
先别写新文章，先解释 demo/工资的一半，是你受的气折算的 里每个阶段文件各自起什么作用。
```

这句话的好处是：

- 它能验证 Claude Code 读没读到当前项目目录
- 它能验证 `.claude/skills/` 是否被正确加载
- 它能让你立刻理解这套流程到底怎么工作

---

## 确认一切正常

按这个清单过一遍：

| 检查项 | 命令 / 操作 | 预期结果 |
|------|------|------|
| Node.js 可用 | `node --version` / `npm --version` | 能看到版本号 |
| Claude CLI 可用 | `claude --version` | 能看到版本号 |
| Claude 环境自检 | `claude doctor` | 没有关键错误 |
| 项目目录正确 | 在仓库根目录执行 `dir` / `ls` | 能看到 `.claude/`、`demo/`、`scripts/` |
| Skills 可见 | 启动 `claude` 后询问有哪些 skills | 至少能识别项目级 skills |
| Demo 可读 | 让它解释 `demo/工资的一半，是你受的气折算的/` | 能说明各阶段文件的作用 |
| 基础命令可跑 | 让它执行 `git status` 或 `dir` / `ls` | 能返回命令结果 |

如果这些都过了，就说明基础环境是正常的。

---

## 项目级加载逻辑

很多人会误以为：

- clone 了仓库 = 一定能跑完整流程

实际不是。

这个仓库的完整版依赖 4 层同时存在：

- skill 作为入口：`.claude/skills/`
- agent 作为执行单元：`.claude/agents/`
- workflow 作为协议：`.claude/workflows/`
- scripts 作为底层工具：`scripts/`

所以你必须做到：

1. clone 完整仓库
2. 在项目根目录启动 `claude`
3. 让这 4 层一起工作

少了其中一层，都不是完整链路。

### 双轨兼容后的真实结构

现在仓库里多了一层运行时唯一源：

- `claude-runtime/`

维护逻辑变成：

- 开发时优先修改 `claude-runtime/`
- 然后同步生成项目兼容层 `.claude/`
- 再同步生成插件目录 `plugins/writing-agent/`

对应命令：

```bash
npm run sync:claude-runtime
npm run check:claude-runtime
npm run check
```

第一条负责同步，第二条负责检查有没有漂移；`npm run check` 会继续执行 Python 回归、语法检查和插件严格校验，是提交或发布前的统一验证入口。

这样可以避免后续出现：

- `git clone` 用户拿到的是新逻辑
- `plugin` 用户拿到的还是旧逻辑

如果你在改运行时相关内容，例如：

- `skills`
- `agents`
- `styles`
- `workflows`
- `scripts`

那就不要只改 `.claude/` 或 `plugins/writing-agent/`，而是优先改 `claude-runtime/`。

---

## 推荐的新手使用顺序

如果你是第一次接触这类工具，我建议按这个顺序来：

### 路线 A：先看 Demo，再安装

1. 先看 [`demo/工资的一半，是你受的气折算的/`](demo/工资的一半，是你受的气折算的/)
2. 看明白 `01_theme.md -> draft_v1_humanized_clean.txt` 这条链路
3. 再决定你要走哪家模型和哪种费用方案
4. 最后开始安装和配置

### 路线 B：直接上完整版

1. 先装 Node.js
2. 再装 Claude Code
3. clone 仓库
4. 配模型或账号
5. 在项目目录启动 `claude`
6. 用 Demo 做第一轮验证

---

## 遇到问题了

### 1. `claude: command not found`

通常是：

- Claude Code 没装好
- PATH 没生效
- 终端没重开

处理方式：

- 重开终端再试
- 重新跑安装命令
- 再执行一次 `claude --version`

### 2. 代理或网络连不上

如果你在国内网络环境下访问 Anthropic 官方服务，可能需要代理。

**macOS / Linux：**

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

**PowerShell：**

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7890"
$env:HTTP_PROXY="http://127.0.0.1:7890"
```

如果你长期需要代理，把它写进你的 shell 配置里。

### 3. 安装时报权限错误

macOS / Linux 不要先上来就 `sudo`。

如果你走 Native Install 路线，先确认：

```bash
mkdir -p ~/.local/bin
```

然后重新执行安装脚本。

如果你走的是 `npm` 安装路径，优先修正本地 Node/npm 权限，而不是直接把所有东西用 `sudo` 装。

### 4. 我 clone 了仓库，为什么还是没有完整流程

优先排查这三件事：

1. 你是不是在项目根目录启动的 `claude`
2. `.claude/skills/`、`.claude/agents/`、`.claude/workflows/`、`scripts/` 是否都在
3. 你的仓库是不是拉到了最新版本

这套系统不是只靠一个 Skill 跑起来的，它依赖完整目录和项目内启动。

### 5. 怎么升级 Claude Code

先试：

```bash
claude update
```

如果你更习惯沿用安装时的包管理方式，再用下面这些命令：

**Native Install：**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Homebrew：**

```bash
brew upgrade --cask claude-code
```

**WinGet：**

```powershell
winget upgrade Anthropic.ClaudeCode
```

### 6. 想在 VS Code 里用

去 VS Code 扩展市场搜索 `Claude Code`，安装 Anthropic 官方扩展即可。

但建议先把 CLI 路线跑通，再切 IDE。

### 7. 不想用终端，想用桌面应用

可以直接去 [claude.ai/download](https://claude.ai/download) 下载 Desktop App。

但这套仓库仍然建议你至少先把 CLI 跑通，因为项目目录上下文、skills、agents、workflows 的理解都更直接。

---

## 如果你只想记住最重要的 4 句话

1. 先看 [`demo/工资的一半，是你受的气折算的/`](demo/工资的一半，是你受的气折算的/)，比先看安装说明更容易看懂项目价值。
2. `DeepSeek-V3.2` 是默认推荐，不是因为它压过另外两家，而是因为它最适合低成本先把整套流程跑通。
3. 完整版一定要在项目根目录启动 Claude Code，最后默认交付的是 `_clean.txt`，并可按需额外导出公众号排版 `.html`。
4. 新版会在调研阶段生成 `02_evidence_ledger.json`，最终交付前生成 `fact_claims.json` 和 `fact_check_report.md`，用来拦截错误事实和失效引用。
