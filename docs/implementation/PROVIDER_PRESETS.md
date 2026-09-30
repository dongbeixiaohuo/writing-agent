# 模型供应商预设

更新：2026-09-26，桌面候选 rc.41。保留 rc.14 的 15 个预设；rc.37 增加供应商列表和旧项目切换；rc.38 分离列表/凭据检查，增加 OpenAI Responses；rc.39 导入 cc-switch Codex 元数据；rc.40 修正套餐身份和共用地址错误归并；rc.41 修复搜索反馈和输入卡顿，精简同服务双协议。

## 实现范围

- 保留 110 个本地配置身份供旧配置识别；新增选择展示 100 项，其中 10 组同服务 Chat/Responses 默认只展示 Responses（不是 100 家公司或独立地址）。不需要下载配置、登录 cc-switch 或安装其他工具。
- 选择预设自动填写基础地址、协议和配置名称。模型 ID 仍由用户按自己的账号填写，不静默替换成某个“最新模型”。
- 每个选项显示供应商、账号地区、服务/套餐类型及协议；支持组合关键词搜索、地区和服务类型筛选。按量/额度通用 API、Coding Plan、Token Plan、Agent Plan、Step Plan、共享 API/套餐入口分别标明。资料未拆分地区的入口统一标“不区分国内 / 国际”，不从域名推断可用性或账号权益。第三方明确告知内容和 Key 的接收方。
- 搜索立即显示匹配数量和可点击结果，不需要再打开下拉框；结果先展示 12 项，可继续展开。过滤不会修改正在编辑的配置，也不会把不匹配的旧选项混入结果。
- “自定义供应商 / 私有网关”继续开放协议、HTTPS 基础地址、模型和高级配置；预设也可转为自定义。
- 可保存多个供应商，每个供应商可维护多个模型 ID；全工作区只有一项当前生效选择。不会自动轮换或修改已有稿件。
- 旧项目等待确认时也能换模型，后续消息、确认、重试使用新选择，保留项目、会话和阶段结果。真正执行中的请求仍须先结束或停止。
- 可选“获取可用模型”由 Host 查询目录；不支持目录的服务可以手动输入，不把目录存在等同于工具调用验证通过。
- 选择本身不保存、不验证、不发送请求。点击“保存并验证连接”才走原有 Host 与凭据管理器链路。
- 打开设置仅返回本地配置摘要，不读取任何 Key、不探测模型。点击编辑才检查指定供应商的凭据，表单先展示可编辑字段；未知凭据状态不显示为“丢失”或“验证成功”。切换/保存仍重新验证所需凭据，不依赖 UI 状态授权。

## 参考来源与适配

### rc.49：Anthropic Messages 统一默认与截断修复（当前规则）

- **统一体验**：DeepSeek、Kimi 国内/国际、智谱 GLM 国内/国际（Z.AI）、千问国内/国际、火山豆包、SiliconFlow 国内/国际新增 Anthropic Messages 协议变体（端点取自同一固定 commit 的 `claudeProviderPresets.ts`，认证按源 `ANTHROPIC_AUTH_TOKEN` 使用 Bearer）。这些家族的选择界面默认只显示 Anthropic 变体——用户只填 Key，不再选择协议和地址；Chat/Responses 变体保留在完整目录中用于存量配置识别，但从新选择中隐藏。OpenAI、Gemini 和聚合平台没有 Anthropic 端点，保持原有默认。MiniMax 国内/国际本来就是这个协议，无需变体。
- **截断根因与三连修复**：DeepSeek Anthropic 端点默认开启 thinking，推理会把 `max_tokens` 预算烧光（实测两次 `MODEL_OUTPUT_TRUNCATED` 且 `partialTextLength=0`，即零可见文本）；且截断恢复重试当时不提升输出上限（`nextOutputTokenLimit` 等于原限），同预算重试必然再次截断。修复：anthropic 适配器同样消费 `extraBody`；`deepseek-anthropic` 变体及 DeepSeek 全协议预设声明 `thinking: {type: 'disabled'}`；`withPresetExtraBody` 匹配放宽为"规范化端点"（覆盖用户手工保存的 Anthropic 配置，端点 `/v1` 后缀归一）；截断恢复重试把输出上限一次性 ×2（封顶 65536），并把升级后的值记入事件。
- `RESPONSES_PREFERRED_OVER_CHAT` 收缩为 OpenAI / OpenRouter 两组；其余家族的偏好由 `ANTHROPIC_PREFERRED_PRESETS` 接管（含 Zhipu Coding 的 Chat → Coding Anthropic）。目录 120 项，新选择可见 99 项。
- 未验证边界：除 DeepSeek（用户实测工作中）与 MiniMax（生产使用中）外，其余 Anthropic 端点均为配置元数据收录，未逐账号验证；DeepSeek Anthropic 端点对 `thinking: {type: 'disabled'}` 参数的接受依据是其跨 API 的统一 thinking 开关文档与用户现象的端点级推断，若端点不认该参数会以明确上游错误呈现。

### rc.43：DeepSeek 改回 Chat Completions（真实账号证伪）

- cc-switch 资料声称 DeepSeek 官方端点原生支持 Responses（`apiFormat: openai_responses`），rc.38/41 明确标注未经过真实账号验证。2026-09-26 首次真实账号使用即被证伪：本应用 Responses 请求体在有效 Key 下被 `api.deepseek.com` 以 **HTTP 400** 连续拒绝两次（工作区 `request_snapshots` + `request.failed` 事件留证），连接测试同样失败。
- `cc-deepseek` 的 `apiFormat` 更正为 `openai_chat`，目录标签自动变为 Chat Completions；Chat 是 DeepSeek 主力文档 API，属于可验证路径。模型示例沿用源资料（`deepseek-flash`、`deepseek-v4-pro`），示例不代表账号已开通。
- `RESPONSES_PREFERRED_OVER_CHAT` 的 `deepseek → cc-deepseek` 配对保留，但语义变为"同身份去重"：隐藏无模型示例的旧 `deepseek` 条目，新选项只显示 cc 版 Chat 条目；其余 9 组仍为 Responses 偏好。存量 Responses 协议配置不自动迁移，按自定义连接显示，用户可手动改协议（改协议需重填 Key）。
- 教训：目录中"收录不代表连接已验证"的声明是真实的；任何 Responses 预设首次被真实账号证伪时，按同样方式更正 `apiFormat` 并在本文件留证，不做无法验证的静默兼容。（rc.45 补充：证伪的真实原因是 thinking 模式拒绝 `tool_choice="required"`，不是端点不支持 Responses；rc.49 起该家族默认进一步切换为 Anthropic Messages 变体。）

### rc.41：搜索反馈、性能和双协议选择（身份规则保留，DeepSeek 例外见 rc.43）

- 原搜索仅修改原生 select 的隐藏 options，画面却一直显示上次选择，造成“搜索无效”。现结果直接可见，搜索状态与凭据编辑表单分离，索引预计算；设置页移除全屏背景模糊以降低输入后的重绘成本。不是删除功能来伪装性能改善。
- `RESPONSES_PREFERRED_OVER_CHAT` 是显式配对：DeepSeek（rc.43 起为 Chat 去重例外）、千问北京/Qwen 新加坡、Kimi 国内/国际、火山方舟通用 API、OpenAI、OpenRouter、智谱/Z.AI Coding Plan，共 10 组。配对测试要求供应商/地区/套餐/档位/渠道一致；不能仅凭品牌或 URL 归并。
- 智谱/Z.AI 的通用 API 仍保留 Chat，因为目录中的 Responses 属于 Coding Plan；不能拿订阅账号代替通用 API。只有 Chat 的服务和 Anthropic 变体不变。
- 旧 Chat ID、模型、地址、Key、协议保持原样，仍可打开编辑；新建自定义 API 仍能选择 Chat，不自动迁移、不静默切换或降级。
- Responses 的功能覆盖更广，OpenAI 对新项目推荐使用它，但这不保证第三方实现和每个模型完全等价。目录偏好仅依据用户指定的固定 cc-switch 资料，不声称所有账号已联网验证。依据：[OpenAI 官方迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses)。本应用仍使用自己的 Harness；不会因为选择 Responses 就自动启用服务商内置工具或服务端历史保存。
- 地区内部值 `unspecified` 保留，展示改为“不区分国内 / 国际”，含义是目录不拆分入口，不是确认全球可用、境内外 Key 通用或数据驻留。显式国内/国际站继续分别标注。

### rc.40：产品身份与套餐边界（身份规则保留，选择列表由 rc.41 精简）

继续使用同一固定 commit；补读 [Claude 预设](https://github.com/farion1231/cc-switch/blob/da193d4f7a6ce3710623c312245c752376c0d036/src/config/claudeProviderPresets.ts) 和 [OpenCode 预设](https://github.com/farion1231/cc-switch/blob/da193d4f7a6ce3710623c312245c752376c0d036/src/config/opencodeProviderPresets.ts)，不额外搜索商业推荐或复制 SDK。

- `provider-offerings.ts` 独立记录身份：供应商品牌、国内/国际/不区分地区、套餐类型、个人/企业档位、接入渠道。地区用于识别账号入口，**不是数据驻留承诺**。所有官方条目必须经过显式分类；未分类新增官方条目会失败，不能按名称正则猜测。
- 移除 `Coding` 名称正则与“协议+地址相同就合并”规则。AICoding 是第三方平台，不因此变成 Coding Plan；BytePlus 明确为国际 Coding Plan。仅保留已核对的 SiliconFlow 同身份别名归并。
- 智谱国内、Z.AI 国际：通用 Chat API 保留；Coding Plan 各有 Chat、Responses、Anthropic 三种独立协议选项。新增的两个 Chat base 为 `/api/coding/paas/v4`；两个 Anthropic base 为 `/api/anthropic/v1`；原 Responses `/api/v1` 标为 Coding Plan，不再含糊。
- 新增千问国内 Coding Plan Anthropic：`https://coding.dashscope.aliyuncs.com/apps/anthropic/v1`。源资料未给该条目的模型示例，不借用其他套餐的模型列表。新 Anthropic 套餐按源 `ANTHROPIC_AUTH_TOKEN` 配置 Bearer，仅匹配 ID+地址+协议才应用；旧连接认证参数原样保留。
- 腾讯国内/国际个人、企业 Pro、企业 Lite 共六种身份保留，即使共用端点，也不合并或跨档位推荐模型。选择预设不能开通或切换账号权益。
- MiniMax 国内资料指向 Token Plan，国际指向 Coding Plan，均使用 API/套餐共用地址。明确“按账号与 Key 权益计费”，不捏造专用套餐地址、不保证套餐可用于本应用。
- 现为 16 个原有及 OpenAI Responses 选项 + 90 条源资料 - 1 个同身份别名 + 5 个补充协议选项 = 110。这个数字只是覆盖统计，不作为产品验收标准；回归测试检查地区、套餐、档位、协议、地址和模型示例的组合。
- 旧显示名称、Key、模型、地址不自动改写。设置卡片显示“预设参考”，不声称已验证购买权益；已存 ID 匹配时仅代表所选目录项。仅有共用地址而无法识别身份的旧配置显示“自定义连接 · 地区/套餐未确认”。这也适用于 rc.39 被归并但没有明确档位身份的配置。
- 修改预设地址后立即撤销该预设的套餐说明和离线模型示例，显示自定义连接。筛选不会静默切换当前选项或发送 Key。保存后连接测试仍只检验连接，不检验套餐扣费方式。
- KAT-Coder 需要 `${ENDPOINT_ID}`，Azure 需要资源和版本参数，OAuth 需要登录能力；不提供看似可用的一键 API Key 预设，也不宣称“已支持全部供应商”。

社区新增预设应提交：固定来源及日期、明确地区/未知、服务类型和档位、真实 API 格式、完整基础地址、认证方式、模型示例与限制。不得用名称猜协议或套餐；共享地址不等于共享账号权益；不自动回退到其他域名。必须补身份覆盖、旧配置保留和 Key 隔离测试。

### rc.39：导入历史（归并规则已由 rc.40 替代）

只读取用户提供的 [codexProviderPresets.ts](https://github.com/farion1231/cc-switch/blob/da193d4f7a6ce3710623c312245c752376c0d036/src/config/codexProviderPresets.ts)，固定 commit `da193d4f7a6ce3710623c312245c752376c0d036`（该文件最后修改于 2026-09-23）。未另行搜索供应商网站。抽取名称、主地址、API 格式及模型 ID 示例，不执行上游 TS，不复制身份提示词、代码工具、思考档位、上下文长度、促销链接或代理逻辑。

- 源文件 93 条：收录 90 条 API Key 接口资料；排除 OpenAI Official / xAI OAuth 两条登录配置，以及需要资源名和 api-version 参数的 Azure 模板。
- `apiFormat: openai_chat` → 本产品 `openai_compatible`；`openai_responses` → `openai_responses`。不能只看源配置的 `wire_api=responses`：Chat 预设在 cc-switch 中经本地路由转换，本产品直接使用 Chat adapter。
- 未显式声明 `apiFormat` 的条目按源 `generateThirdPartyConfig` / TOML 中的 Responses 协议提取；收录不等于厂商认证或账户连通性验证。
- 当时将 90 条资料按“协议 + 主地址”合并为 87 个接口，保留原 15 项后共 102 项。此规则错误地合并了腾讯不同档位，rc.40 已移除，**不能继续用于新增预设**。
- 旧 Chat/Anthropic 预设、ID 和持久配置完全保留；新增 MiniMax、DeepSeek、Kimi、千问等 Responses 变体，不静默迁移任何存量 Key、地址或模型。每个预设可见实际 API 格式与请求地址。（其中 DeepSeek 变体经真实账号证伪，rc.43 已改回 Chat。）
- 模型 ID 只作离线提示，不自动填入、保存或当作账号已开通目录。主地址以源文件为准，不复制候选地址并自动重试，以免把 Key 发往未选择的端点。
- 源数据为 `packages/client-bridge/src/cc-switch-codex-presets.ts`；归并和产品文案为 `provider-presets.ts`。MIT 版权说明随安装包分发，来源与哈希登记于 `upstream-sources.json`。

### rc.14 原有预设依据（保留，不代表本轮重新在线核验）

参考 [cc-switch](https://github.com/farion1231/cc-switch)，固定 commit `fdbe3a85b269ed40695ded5981b6ba8288d30ac3`：

- [OpenCode 预设](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/opencodeProviderPresets.ts)
- [Claude 预设](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/claudeProviderPresets.ts)
- [统一供应商模板](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/universalProviderPresets.ts)

本次参考供应商分类和公开连接参数，使用自有 typed catalog 与表单逻辑；未复制上游组件、SDK 实现、图片、商标或套餐推广/返佣链接。上游 MIT 许可证已核对，未把整个 cc-switch runtime 打入产品。

OpenAI Chat Completions 追加 `/chat/completions`；OpenAI Responses 追加 `/responses`；Anthropic Messages 追加 `/messages`。自定义 API 可选择三者；现有预设协议不自动变化，基础地址不要重复填写具体接口路径。表中 Anthropic 地址显式包含 `/v1`，不能把 Claude Code 环境变量地址和本应用底层 HTTP 地址机械等同。不支持 Vertex、Bedrock 或 OAuth 登录。

Responses 使用独立 adapter 与 `openai_responses` 配置，`stream:true`、`store:false`，支持文字增量、函数参数流、工具结果回传、加密推理续接和 usage。续接只在同协议/供应商/地址/模型范围重放，不显示为正文。使用服务端默认采样，不发送运行时通用 temperature；不支持 stop。Responses 专有内置工具/图片输入不在本次文字写作适配范围。实现依据 [官方迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses) 和 [函数调用](https://developers.openai.com/api/docs/guides/function-calling)。本地协议验收不等于已验证用户的具体 OpenAI/中转账户。

| 预设 | 协议 | 基础地址 |
|---|---|---|
| MiniMax 国内 | Anthropic | `https://api.minimax.cn/anthropic/v1` |
| DeepSeek | OpenAI | `https://api.deepseek.com` |
| 阿里云百炼/千问 北京 | OpenAI | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi 国内 | OpenAI | `https://api.moonshot.cn/v1` |
| 智谱 GLM 通用 API | OpenAI | `https://open.bigmodel.cn/api/paas/v4` |
| 火山方舟/豆包 通用 API | OpenAI | `https://ark.cn-beijing.volces.com/api/v3` |
| OpenAI | OpenAI | `https://api.openai.com/v1` |
| Anthropic/Claude | Anthropic | `https://api.anthropic.com/v1` |
| Google Gemini | OpenAI | `https://generativelanguage.googleapis.com/v1beta/openai` |
| MiniMax 国际 | Anthropic | `https://api.minimax.io/anthropic/v1` |
| 阿里云百炼/Qwen 新加坡 | OpenAI | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Kimi 国际 | OpenAI | `https://api.moonshot.ai/v1` |
| Z.AI 通用 API | OpenAI | `https://api.z.ai/api/paas/v4` |
| 硅基流动 国内 | OpenAI | `https://api.siliconflow.cn/v1` |
| OpenRouter | OpenAI | `https://openrouter.ai/api/v1` |

API 参数与官网资料交叉核对于 2026-09-21，不代表全部真实账户已连接验收：

- [MiniMax 国内](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)、[国际](https://platform.minimax.io/docs/api-reference/text-anthropic-api)：国内文档现用 `api.minimax.cn`，与 cc-switch 固定快照的 `api.minimaxi.com` 不同。本应用新预设按当前官方文档；已有旧地址原样保留为自定义，不自动迁移。
- [DeepSeek](https://api-docs.deepseek.com/zh-cn/)、[阿里云百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)：百炼官方仍允许现有共享域名；业务空间专属域名可转自定义填写，API Key 须与地域一致。
- [Kimi 国内](https://platform.kimi.com/docs/get-api-key)、[国际](https://platform.kimi.ai/docs/overview)、[智谱 API 示例](https://docs.bigmodel.cn/cn/best-practice/case/ai-search-engine)、[Z.AI](https://docs.z.ai/guides/overview/quick-start)。
- [火山方舟工具调用](https://www.volcengine.com/docs/82379/1958524?lang=zh)、[OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat)、[Claude API](https://platform.claude.com/docs/en/api/overview)。
- [Gemini OpenAI 兼容](https://ai.google.dev/gemini-api/docs/openai)、[硅基流动](https://docs.siliconflow.cn/docs/userguide/quickstart)、[OpenRouter](https://openrouter.ai/docs/quickstart)。

## 配置及安全边界

1. 打开设置时按现有协议及精确地址识别预设，只影响显示，不改配置名、地址、模型或 Key。未知/旧域名保持自定义，不通过名称或子域名模糊匹配。
2. 更换供应商/地域时清空未保存的 Key 和模型名称；修改地址或协议也清空输入 Key。只有相同规范化协议及地址的已保存配置允许留空沿用 Key。新供应商或新端点必须填 Key。
3. 列表中的验证针对当前生效配置；编辑区明确使用“保存并验证连接”，未保存的模型下拉选择须点击“使用此模型”才生效。
4. 设置分页切换保留未提交内容；列表不等待 Key 检查。编辑表单先展示本地字段，选中供应商的 Key 在后台检查；取消、切换编辑对象或保存后忽略迟到结果。保存/验证时禁用表单。
5. Key 优先使用 Windows 凭据管理器；失败时延续已有 session fallback。不把 Key 加进 JSON 配置、URL、日志、截图或浏览器存储。
6. 浏览器仍不得直接调用模型。静态地址位于 `packages/client-bridge/src/provider-presets.ts`，Host 统一验证与发起请求，CSP/IPC/HTTPS 边界不变。分发检查不再仅凭 `api.deepseek.com` 字符串误判上游运行时混入，同时新增 renderer 不得使用 fetch/XMLHttpRequest/WebSocket 的源码检查。
7. 自定义页面可编辑协议、地址、模型和显示名称；高级设置保留配置标识。相同规范化 Anthropic 端点已保存的 `authHeader`、`anthropicVersion`、`defaultMaxOutputTokens` 由 Host 保留，但不在此页编辑。切换端点或协议不会继承这些参数。不会把旧 HTTP 放行选项自动继承到新配置。
8. 桌面 `provider.json` 升级为 schemaVersion 3 目录，条目内仍为模型适配器原有 v2 配置。读取旧 v1/v2 文件不修改文件或 Key；首次保存才升级。新 Key 使用独立托管引用，不覆盖其他供应商。CLI 配置格式不变；升级后不保证旧客户端能读取新目录格式。
9. 目录请求只发往用户填写的 HTTPS 地址，禁止重定向，15 秒超时、1 MiB 响应上限。目录失败不改当前配置，不要求用户必须联网拉目录。

代码：`packages/client-bridge/src/provider-presets.ts`、`packages/client-bridge/src/cc-switch-codex-presets.ts`、`packages/ui/src/shell/ProviderSettings.tsx`、`apps/desktop/src/provider-profile.ts`。维护源数据时同步固定 commit、来源哈希和覆盖测试；如供应商需要新协议或额外认证参数，不得仅加地址并宣称支持。本次不实现截图中的 Bedrock、插件、Agent 预设和配置文件编辑等独立功能。
