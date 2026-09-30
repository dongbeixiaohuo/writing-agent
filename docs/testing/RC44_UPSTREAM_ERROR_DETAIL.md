# rc.44：失败提示携带上游返回的具体原因

日期：2026-09-26。范围：模型错误诊断信息链路（三个协议适配器、运行事件、桌面连接验证、对话时间线文案）；不修改写作工作流、事实门禁、存量项目数据或凭据。

## 需求与背景

rc.43 定位 DeepSeek 故障时发现：上游返回 HTTP 400，但本应用只保留状态码、丢弃错误正文，用户看到"请检查服务类型、API 地址和模型 ID"的泛化提示后无法判断真实原因（一度怀疑 Key 失效），需要事后挖库才能定位。用户明确要求：错误提示里保留上游返回的具体原因，让用户当场知道发生了什么。

## 安全设计决策

旧契约是"上游错误正文一律不出适配器"（防注入、防凭据回显、防正文泄入事件）。新契约改为**只放行净化后的 `error.message` 摘要**，其余正文字段仍一律不放行：

1. 只提取 JSON 错误体中 `error.message` 一个字段（非字符串则不留）；`debug`、堆栈、请求回显等其余字段继续丢弃（有测试钉住）。
2. 净化：剥离控制字符、压缩连续空白、截断到 240 字符（超出加省略号）。
3. 凭据遮蔽：请求实际使用的凭据若在正文中被原样回显，替换为 `***`（DeepSeek 类网关会回显打码 Key，恶意网关可能回显原文，遮蔽在适配器内完成，Key 不离开进程）。
4. 摘要只进入本地事件库和用户可见文案（React 文本节点，天然转义），不进入任何发往模型的上下文；重试/纠错消息仍只使用原有 toolSchemaFeedback 通道。

字段链路：适配器 `ModelError.providerDetail` → agent 运行时 `request.failed` 事件载荷 `providerDetail`（与既有 `providerHttpStatus`/`providerRequestId` 同级）→ 对话时间线"运行失败/写作模型"行 → 桌面连接验证结果 `providerDetail` → 设置页卡片与保存提示文案。

## 修改

- `packages/runtime/llm/src/types.ts`：`ModelError` 新增 `providerDetail?: string`（注释声明净化与用途边界）。
- `openai-compatible`：新增导出 `sanitizeProviderErrorDetail`（净化+截断+凭据遮蔽）；`mapHttpError` 提取 `error.message` 并接收遮蔽列表；请求路径传入实际凭据。
- `anthropic-compatible`：HTTP 错误映射与流内 `error` 事件同样提取并遮蔽（复用同一净化函数）。
- `openai-responses`：HTTP 错误（经 mapHttpError）与流内 `response.failed`/`error` 事件同样提取并遮蔽。
- `packages/runtime/agent`：`request.failed`（及共用载荷的 `request.outcome_unknown`）事件载荷新增 `providerDetail`。
- `application-bridge`：`modelFailureDetail(code, providerDetail?)` 在有摘要时追加"（上游返回：…）"；request.failed 行直接取当前事件，run.failed 行按 runId 取同 run 最近一次摘要。
- `desktop-bridge` / `application-host` / `onboarding`：连接验证失败视图新增 `providerDetail`，设置页文案同样追加"（上游返回：…）"。
- 桌面版本号 `1.0.0-rc.42` → `1.0.0-rc.44`（rc.43 为源码级修复未出包）。

## 已验证

- 三个适配器 22/22：新增净化/截断/遮蔽/缺省用例；既有"正文不泄漏"用例更新为新契约——`SECRET`/`C:\private` 等标记放在 message 之外字段断言仍不泄漏，message 内凭据断言被 `***` 遮蔽。
- 时间线端到端：`request.failed` + `run.failed` 事件后，两行均显示泛化提示 + （上游返回：…）。
- 连接验证文案：带 `providerDetail` 的失败视图输出追加摘要。
- 全套回归：runtime 250/250、UI 77/77、Bridge 61/61、Desktop 43/43；runtime/web/desktop TypeScript 通过。

## 未验证边界

- 诊断 ZIP 导出沿用既有 allowlist 脱敏管线；`providerDetail` 为净化摘要，但真实上游文本进入诊断包的行为未单独逐项复核，需要时按诊断包既有规则追加检查。
- 上游返回内容不可信：摘要虽然净化，仍是供应商控制文本，展示为纯文本、不执行、不进入模型上下文；若上游返回超长或无 message，自动降级为原有泛化提示。

## 打包验证（已完成）

- 直出 `output/desktop` 时撞上 rc.37 记录过的 `win-unpacked` 锁定（EPERM unlink，OneDrive 目录残留锁，非用户安装实例）；按既定规避改用隔离目录构建。
- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.44-x64.exe`，111,491,899 字节；SHA256 `8aafdfbd7d404f71de627485579f54b4e492b3bedca9f1c8ac36f905bfd43687`，已登记 `output/desktop/SHA256SUMS.txt` 并复算一致。
- 成品 smoke：隔离构建复制到短 TEMP 路径后启动，ready、协议 20、退出码 0、stdout/stderr 为空，1075 ms（`output/rc44/desktop-smoke.json`）；长 OneDrive 路径直启仍会触发已知 GPU 崩溃，规避方式与 rc.37–42 相同，不宣称该问题已修复。
- 两处 `resources/app.asar`（构建目录与 smoke 副本）SHA256 一致：`8d0a01819f044634493aa936f38d6dde0e4d30bb9517d5fd9a1954f52a5e2376`。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证，未触碰用户正在运行的已安装实例与真实凭据；真实 DeepSeek 账号下 Chat 配置（rc.43 更正）与上游摘要展示，待用户安装后实测确认。
