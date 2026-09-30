# WA-006 模型接口与首个 provider 验证结果

状态：`PASS_LOCAL`  
日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- 在 `packages/runtime/llm` 建立 provider-neutral 的消息、参数、能力、usage、错误与流式事件合同。公开事件覆盖 `text_delta`、`tool_call_delta`、`tool_call_complete`、`usage`、`completed` 和 `error`；每条流只有一个成功或失败终态，并记录 provider、model 与 adapter version。
- 建立确定性 `MockModelProvider` 和文本成功、工具成功、鉴权失败协议夹具；不配置 API Key 即可复现文本、usage、工具增量、错误与运行中 abort。
- 工具参数增量仅供显示和诊断。只有完整 JSON 对象通过请求内对应的 JSON Schema 后才生成 `tool_call_complete`；未知工具、冲突 ID/名称、截断 JSON、schema 不匹配、结束原因冲突均不会产生可执行调用或成功终态。
- 在 `packages/model-adapters/openai-compatible` 实现第一个真实协议适配器：使用 Node 24 原生 `fetch` 调用 `/chat/completions`，严格解析 SSE 与 `[DONE]`，支持流式文本、并行工具片段、usage、tool result 回传、timeout 和 abort。
- adapter 每次请求通过 `credentialRef` 调用凭据解析器，Key 只进入 Authorization header，不进入模型消息、事件、普通错误或测试请求体。HTTP endpoint 默认拒绝，只有显式 `allowInsecureHttp` 才启用，供本机/受控兼容服务使用。
- adapter 不做隐藏重试（`maxRetries = 0`）；401/403、模型不存在、额度不足、429、5xx、网络、超时、用户取消和响应截断映射为稳定错误码。未知价格始终为 `cost: null`，不显示为 0。
- 提供 `probeModelConnection`：由显式调用触发一次受控请求，区分鉴权、网络、模型、流和工具阶段，并如实报告 usage 是否返回。工具探测只注册无副作用 probe schema，不执行任何业务工具；unknown tools 仅能在包内标记的 probe 请求中测试，普通生成仍 fail closed。

本项没有实现 agent loop、业务工具执行、请求快照持久化、run 预算或稿件保存；这些分别属于 WA-007、WA-008、WA-009 及后续 Application Service 任务。

## 2. TDD 记录

按公开 `ModelProvider` seam 完成三条竖切：

1. 先写 mock 文本、usage、未知成本和取消测试；初始失败为 `packages/runtime/llm/src/index.js` 不存在，补最小合同与 mock 后通过。
2. 先写分块工具参数、JSON/schema 校验、截断、无 tools 能力测试；初始失败为 fixture schema 不认识 `tool_call_delta`，补统一流归一化和 Ajv 校验后通过。
3. 先写本机真实 HTTP/SSE、多轮 tool-call/result、HTTP 错误分类与凭据缺失测试；初始失败为 adapter 不存在。实现后又由类型检查发现仓库旧 `openai@4` 与 `node-fetch@3` 类型闭包冲突，改用 Node 24 原生 `fetch`，保留零隐藏重试并增加严格 `[DONE]` 截断检测。

随后补写运行中 abort、mock 错误夹具和连接能力探测测试；分别先暴露“取消后被误判为截断”和缺少 probe 入口，再修正为单一 `ABORTED` 终态及内部受控 probe。

## 3. 需求与验收映射

| 条目 | 本地证据 | 结果 |
|---|---|---|
| F03 | 统一消息/事件、文本流、工具 ID/参数、结束原因、usage、取消、稳定错误；OpenAI-compatible 首个适配器；连接探测区分主要失败阶段 | `PASS_LOCAL_PROTOCOL` |
| F12 | usage 缺失时不伪造；价格未知为 `null`；adapter 零隐藏重试 | `PASS_LOCAL_BOUNDARY`，run 级调用/重试/工具预算仍归 WA-009 |
| AT-02 | 本机 SSE 服务先返回 `read_material` 工具调用，完整校验后以相同 call ID/name 回传 tool result，再收到流式正文 | `PARTIAL_PASS`：provider 往返通过；尚未执行真实业务工具或保存稿件 |
| AT-20 | 错误 Key、额度不足、无 tools、工具 JSON 截断/schema 错误、429、5xx、SSE 截断和 abort 均有负向测试；每个 HTTP 场景只收到一次请求 | `PARTIAL_PASS`：provider 边界通过；run 总预算与有限重试待 WA-009 |

## 4. 验证命令

### `npm run check:runtime`

结果：PASS。

- TypeScript `strict` / `noEmit`：PASS。
- Node test runner：27 项通过，0 失败；其中 WA-006 新增 15 项，覆盖 mock、工具安全、连接探测和 OpenAI-compatible 本机协议。

### `npm run check:m0`

结果：PASS。

- Node 24 `node:sqlite` foundation smoke：PASS。
- M0 架构、来源和 legacy fixture：11 项通过。
- runtime 类型检查与 27 项测试：PASS。

所有 provider 协议测试都连接 `127.0.0.1` 临时服务或 deterministic mock；没有读取真实 Key，没有访问真实模型 endpoint，也没有产生模型费用。

## 5. 来源、依赖与边界

- 实现采用固定 DSH 快照中“provider-neutral 合同、adapter 自有 wire、单一终态、截断不成功”的已审计设计约束，但没有复制 DSH 源文件；`upstream-sources.json` 中相关组件仍保持 `audited_planned`，`THIRD_PARTY_NOTICES.md` 不虚报源码已移植。
- 新增直接依赖 `ajv@8.20.0`，用于在可执行边界校验工具 JSON Schema。OpenAI-compatible adapter 不依赖现有 `openai@4` SDK，避免其旧 Node fetch 类型闭包和 SDK 内部重试改变预算语义。
- provider/model 能力探测结果目前作为报告返回，尚未接设置存储和 UI；持久化与选型由后续 Application Service/设置任务完成。
- 尚未进行维护者授权的真实 provider 工具往返、远端 CI、代理环境、企业兼容 endpoint 或长时间流稳定性测试；这些结果不能由本机 fixture 代替。
