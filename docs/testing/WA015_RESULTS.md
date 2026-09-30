# WA-015 本地实施与验收结果

日期：2026-09-17  
状态：`COMPLETE_LOCAL`  
任务：完成第二协议、Key 安全、网络与诊断边界

## 1. 交付结果

- 新增 Anthropic-compatible Messages adapter，与既有 OpenAI-compatible adapter 共用 provider-neutral stream/tool/usage/error 合同；支持 `tool_use`/`tool_result`、命名 SSE、完整/增量 tool input、取消、usage 缺失和稳定错误分类。
- provider 配置升级到 schema v2，可选择 `openai_compatible` 或 `anthropic_compatible`，只保存 `managed:<id>` / `env:<NAME>` 引用；旧 OpenAI schema v1 仍只读兼容。CLI 与本地 Web 使用同一个 parser、CredentialBroker 和 provider factory。
- CLI 新增 `credential set/inspect/delete` 与显式 `doctor`。Key 不进入参数、配置或输出；`doctor` 用受控工具探测认证、模型、stream、tools 和 usage，不执行业务工具。
- 新增 Windows Credential Manager backend，以 `WritingAgent/1.0/<id>` 作为应用域；系统库不可用或写入失败时只回退当前进程内存，不写普通文件。
- 新增 `SecureWebFetcher`：完整 DNS answer 必须公开，真实 TLS 连接固定到已检查地址，每次 redirect 重新验证；文本类型、UTF-8、字节/字符和跳转数均有上限，HTML 去主动内容并标记为无指令权威的不可信外部文本。
- 新增 allowlist 诊断包：先生成文件清单/hash/排除项和 `confirmationHash`，再凭同一 hash 原子导出 ZIP；Key、正文、材料、prompt、tool result、私人路径、原始日志和 exception message 不进入包。
- 扩充派生 UI 安全审计：renderer 无直接 provider/外部 endpoint、上游遥测/更新/账户提交、危险 HTML、任意新窗口或动态脚本执行；Local Web CSP、同源 loopback 和 capability 边界继续成立。

详细合同见 `docs/architecture/MODEL_PROTOCOL_MATRIX.md` 与 `docs/architecture/SECURITY_AND_DIAGNOSTICS.md`。

## 2. 自动与实机验证

| 范围 | 证据 | 结果 |
|---|---|---|
| Anthropic protocol | tool use/result 两轮、完整/增量 JSON、usage 有/无、auth/quota/429/5xx、流截断、JSON 截断、abort | PASS（7 项 fixture） |
| 两协议配置/探测 | schema v1→v2、两个 adapter factory、明文引用拒绝、无 tools 预检、Anthropic CLI doctor loopback | PASS |
| 凭据 | system/session/env broker、失败脱敏、应用域 target、无明文 transport；CLI 导入/删除不回显 | PASS |
| Windows 系统库 | 一次性假凭据实际 `write → read == input → delete → read null` | PASS_LOCAL_REAL_OS；目标已删除 |
| 网络/HTML | 私网/metadata/混合 DNS、redirect、pinned address、体积/MIME/UTF-8、active HTML、提示注入权威 | PASS |
| 诊断包 | 恶意额外字段忽略、排除项预览、未知成本为 null、错误确认不写文件、冲突不覆盖、ZIP 内容复核 | PASS |
| run 预算 | 模型/工具/重试/重大修订共用持久预算，达到上限前停止并保留已有产物 | PASS（WA-009 回归） |
| renderer/Host | 源码无外部 provider/遥测/更新/危险 HTML；CSP 与同源 loopback 断言 | PASS_CURRENT_WEB_SCOPE |

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-18 | `PASS` | 工作区/逐文件授权、路径穿越、敏感文件、symlink/junction 和 sibling 越界均有负向测试；错误不回显绝对路径 |
| AT-19 | `PASS_LOCAL_BOUNDARY` | 私网/metadata/混合 DNS/重定向在请求前阻断；已检查地址固定到实际连接；HTML 主动内容移除，提示注入固定 `instructionAuthority=none` |
| AT-20 | `PASS_FIXTURE` | 两协议覆盖错误 Key、额度、无 tools、JSON/SSE 截断、429/Retry-After、5xx、reset/abort；无假 success，adapter 无隐藏重试 |
| AT-25 | `PASS` | 诊断包固定 allowlist、排除项可预览、确认 hash 必须一致；解压复核无 Key、私人正文/prompt/path/raw error，目标冲突不覆盖 |
| AT-26 | `PASS_REGRESSION` | 共用 run 预算的模型/工具/重试/重大修订上限继续通过，usage/价格未知不记 0 |
| AT-36 | `PASS_CURRENT_WEB_SCOPE` | UI/正式 bundle 无上游默认遥测、更新、账户/反馈提交或 provider 直连；Node runtime 仅按用户配置调用模型 endpoint |
| AT-38 | `PASS_CURRENT_WEB_SCOPE` | React 文本渲染、无危险 HTML API/远程导航/动态脚本；Local Web CSP/Origin/capability 通过；Electron preload/安装包仍待 WA-017/018/025 |

## 4. 验证命令

```powershell
npm run check:runtime
npm run check:ui
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py
git diff --check
```

最终结果记录：Node 24.18.0 下 runtime 130/130；UI 10/10；Bridge/Host 9/9；UI/来源 Python 9/9；M0 Python 12/12；legacy 共运行 234 项，其中 233 通过、1 条既有条件跳过；production dependency audit 0 vulnerabilities；需求包 25 个任务、38 个验收场景一致性检查 PASS。没有删除、跳过或改写失败测试来获得通过。

## 5. 未宣称内容

- 本轮没有获得真实 Key/费用授权，因此没有访问真实 provider、调用付费模型或验证具体商业模型；两种协议均以本机 wire fixture 验证，真实项明确为 `NOT_RUN_REQUIRES_KEY_AND_COST_APPROVAL`。
- Windows Credential Manager 实机验证使用随机一次性假凭据并已精确删除；尚未在干净 Windows、域策略或非 Windows 环境验收。
- 诊断包目前为 runtime library 合同，尚未增加 UI 预览/导出面板；UI 接入不得扩大 allowlist。
- renderer 安全结论覆盖当前 Local Web；Electron 容器、preload、导航、安装包及进程扫描仍由 WA-017/WA-018/WA-025 完成。
- 未执行 commit、push、PR、Release 或生产部署。
