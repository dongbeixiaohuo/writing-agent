# 模型供应商预设

更新：2026-09-21，桌面候选 rc.14。用户要求：参考 cc-switch 内置主流供应商的配置，选择供应商后只填 API Key 与模型名称，并保留自定义入口。

## 实现范围

- 15 个本地静态预设，不需要下载配置、登录 cc-switch 或安装其他工具。
- 选择预设自动填写基础地址、协议和配置名称。模型 ID 仍由用户按自己的账号填写，不静默替换成某个“最新模型”。
- 国内、国际、聚合平台分组，明确账号地区和通用 API/编程套餐的区别。
- “自定义供应商 / 私有网关”继续开放协议、HTTPS 基础地址、模型和高级配置；预设也可转为自定义。
- 仍是一份当前生效配置，不新增多配置收藏、自动轮换、套餐代购或代理服务。
- 选择本身不保存、不验证、不发送请求。点击“保存并验证连接”才走原有 Host 与凭据管理器链路。

## 参考来源与适配

参考 [cc-switch](https://github.com/farion1231/cc-switch)，固定 commit `fdbe3a85b269ed40695ded5981b6ba8288d30ac3`：

- [OpenCode 预设](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/opencodeProviderPresets.ts)
- [Claude 预设](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/claudeProviderPresets.ts)
- [统一供应商模板](https://github.com/farion1231/cc-switch/blob/fdbe3a85b269ed40695ded5981b6ba8288d30ac3/src/config/universalProviderPresets.ts)

本次参考供应商分类和公开连接参数，使用自有 typed catalog 与表单逻辑；未复制上游组件、SDK 实现、图片、商标或套餐推广/返佣链接。上游 MIT 许可证已核对，未把整个 cc-switch runtime 打入产品。

OpenAI 兼容适配器追加 `/chat/completions`；Anthropic 兼容适配器追加 `/messages`。因此表中 Anthropic 地址显式包含 `/v1`，不能把 Claude Code 环境变量地址和本应用底层 HTTP 地址机械等同。当前仅适配这两种协议，不暗示支持专用 Responses、Vertex、Bedrock 或 OAuth 登录。

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
2. 更换供应商/地域时清空未保存的 Key 和模型名称；修改自定义地址或协议也清空 Key，避免把凭据误发给另一个端点。转自定义保留原协议、地址、模型，仍要求重新填写 Key。
3. 编辑草稿后禁用“验证已保存配置”，避免旧配置验证通过被误认为当前编辑配置成功。保存仍由用户明确提交。
4. 设置分页切换保留未提交内容；读取配置完成前及保存/验证过程中禁用表单，避免异步覆盖输入。
5. Key 优先使用 Windows 凭据管理器；失败时延续已有 session fallback。不把 Key 加进 JSON 配置、URL、日志、截图或浏览器存储。
6. 浏览器仍不得直接调用模型。静态地址位于 `packages/client-bridge/src/provider-presets.ts`，Host 统一验证与发起请求，CSP/IPC/HTTPS 边界不变。分发检查不再仅凭 `api.deepseek.com` 字符串误判上游运行时混入，同时新增 renderer 不得使用 fetch/XMLHttpRequest/WebSocket 的源码检查。
7. 自定义页面可编辑协议、地址、模型、配置名称和工具支持；相同规范化 Anthropic 端点已保存的 `authHeader`、`anthropicVersion`、`defaultMaxOutputTokens` 由 Host 保留，但不在此页编辑。切换端点或协议不会继承这些参数；内部配置接口显式提交且校验通过的值优先。不会把旧 HTTP 放行选项自动继承到新配置。

代码：`packages/client-bridge/src/provider-presets.ts`、`packages/ui/src/shell/WritingAgentShell.tsx`。维护时修改静态表即可；如供应商需要新协议或额外认证参数，不得仅加地址并宣称支持。
