# 模型协议与能力矩阵

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-006 / WA-015  
最后核验：2026-09-17

## 1. 当前支持面

| 配置 kind | 协议/入口 | 认证方式 | 工具往返 | 流式完成条件 | usage | 本地证据 | 真实授权测试 |
|---|---|---|---|---|---|---|---|
| `openai_compatible` | Chat Completions，`/chat/completions` | `Authorization: Bearer` | `tool_calls` → `role=tool` | 有合法 finish reason 且收到 `[DONE]` | reported / unknown | 6 项本机 SSE fixture PASS | `NOT_RUN_REQUIRES_KEY_AND_COST_APPROVAL` |
| `anthropic_compatible` | Messages，规范化 Base URL 后追加 `/messages` | `x-api-key`；可配 Bearer | `tool_use` → `tool_result` | `message_start` → content blocks → `message_delta` → `message_stop` | reported / unknown | 7 项本机 SSE fixture PASS | `NOT_RUN_REQUIRES_KEY_AND_COST_APPROVAL` |

两条 adapter 都实现同一个 `ModelProvider` 合同，UI、Application Service 与 AgentRuntime 不按厂商分叉。工具必须有稳定 ID、完整 JSON object 并通过声明的 JSON Schema 后，才会产生 `tool_call_complete`；部分 JSON、未知工具、结束原因不一致或截断流都 fail closed。

Anthropic-compatible 映射依据当前官方 Messages 工具块和 SSE 事件结构：系统消息移到顶层 `system`，输出上限使用 `max_tokens`，工具 schema 使用 `input_schema`，历史工具结果放入 user `tool_result`。参考 [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)、[handling tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) 与 [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)。兼容端点若偏离这些语义，必须由显式 `doctor` 探测或单独 adapter 处理，不能靠宽松解析假成功。

## 2. 配置与凭据引用

schema v2 的共同字段为：

```json
{
  "schemaVersion": 2,
  "kind": "openai_compatible | anthropic_compatible",
  "providerId": "provider-profile-id",
  "baseURL": "https://provider.example/v1",
  "credentialRef": "managed:profile-id",
  "model": "tool-capable-model-id",
  "tools": "supported",
  "usage": "reported | unknown"
}
```

- `managed:<id>` 从系统安全存储解析，是新配置的默认方式。
- `env:<NAME>` 只作为开发、迁移或受控测试引用；配置里仍不出现 Key。
- schema v1 OpenAI `credentialEnv` 继续只读兼容，并立即归一化成 `env:<NAME>`；不会被当作明文 Key。
- Anthropic 可附加 `anthropicVersion`、`authHeader` 和 `defaultMaxOutputTokens`。默认版本头为 `2023-06-01`，默认认证头为 `x-api-key`。
- Anthropic SDK 风格地址若为 host 根路径或以 `/anthropic` 结尾，配置解析会自动补成 `/v1`；例如 `https://api.minimaxi.com/anthropic` 规范为 `https://api.minimaxi.com/anthropic/v1`，adapter 再追加 `/messages`。已经显式带版本路径的地址保持不变。
- base URL 禁止内嵌用户名、密码、query 或 fragment；HTTP 仅限显式 `allowInsecureHttp` 的本机 fixture/开发场景。

配置示例位于 `examples/writing-pack/real/`。`apps/cli` 与 `apps/web/server` 使用同一 parser、CredentialBroker 和 adapter factory，不再分别维护协议分支。

## 3. 显式连接探测

```powershell
npm run runtime:cli -- doctor --provider-config '<private-provider-config.json>'
```

`doctor` 是用户显式发起的真实网络请求，依次验证配置/凭据解析、认证、模型、stream 和受控工具调用；不执行任何业务工具。模型已声明 `tools=unsupported` 时在网络调用前返回 tools 阶段失败。探测结果仅含 provider/model/adapter、能力、稳定错误码和 provider request ID，不含 Key、请求正文或原始错误正文。

错误边界覆盖：

| 条件 | 稳定结果 |
|---|---|
| 错误/缺失 Key | `AUTH_FAILED`，不重试 |
| 余额、credit、quota 或 spend limit | `QUOTA_EXCEEDED`，不重试 |
| 响应正文明确说明模型不存在/不可用 | `MODEL_UNSUPPORTED`，不重试 |
| 普通 API 路由 404 | `INVALID_REQUEST`，提示检查服务类型和 API 地址；不得误报为模型不存在 |
| 已声明无 tools | tools 阶段 `MODEL_UNSUPPORTED`，不发请求 |
| 429 | `RATE_LIMITED`，携带可用的 `retryAfterMs` |
| 408/超时 | `TIMEOUT`，允许上层在预算内决定重试 |
| 5xx/overloaded | `PROVIDER_UNAVAILABLE`，允许上层在预算内决定重试 |
| transport reset | `NETWORK_ERROR` |
| SSE 截断、未知事件、工具 JSON 截断 | `MODEL_RESPONSE_INVALID`，不产生工具完成或假成功 |
| 用户取消 | `ABORTED`，丢弃迟到输出 |

adapter 的 `maxRetries=0`；它不隐藏 SDK 重试。安全重试只由 AgentRuntime 执行，并计入同一个 run 的模型请求和重试预算。provider 不报告 usage 时不发 usage 事件；token 和价格保持未知，成本不会写成 0。

## 4. 验证边界

- 本地 fixture 验证使用一次性 loopback HTTP server；只有测试配置显式允许不安全 HTTP。
- Windows Credential Manager 使用一次性假凭据完成过真实写入、读回和精确删除，测试目标已删除。
- 本轮没有读取真实 Key，没有访问真实 provider，没有产生付费调用，也没有验证任何具体商业模型名称。
- 真实 provider 兼容性与费用只能在维护者提供合法配置并明确授权后记录；未运行项保持 `NOT_RUN`，不能由 fixture PASS 替代。
