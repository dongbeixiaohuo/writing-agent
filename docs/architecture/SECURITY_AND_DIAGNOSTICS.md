# 凭据、网络、内容与诊断安全边界

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-007 / WA-009 / WA-011 / WA-015  
最后核验：2026-09-17

## 1. 凭据生命周期

应用配置、模型请求快照、SQLite 业务表、Bridge、日志和诊断包只携带 `managed:<id>` 或 `env:<NAME>` 引用，不保存明文 Key。模型 adapter 在发请求前通过 `CredentialBroker` 解析引用，Key 仅进入当前进程的认证 header，不进入消息上下文或可重放 payload。

Windows 首发实现使用 Credential Manager：

- target 固定为 `WritingAgent/1.0/<id>`，ID 只允许有限 ASCII 字符，不能路径穿越；
- 通过 `CredWriteW`、`CredReadW`、`CredDeleteW` 读写当前用户安全存储；
- Node 与受限 PowerShell 子进程之间只通过 stdin/stdout 传递 base64，Key 不进入命令参数、环境变量或临时文件；
- 原生 buffer 使用后清零，子进程输出有体积和超时限制，原始 Win32 错误不进入用户消息；
- 系统库不可用或写入失败时仅保存在当前进程内存，并返回 `system_unavailable` / `system_write_failed`；不会退化为明文 JSON、SQLite 或工作区文件；
- CLI 的 `credential set --from-env` 是一次性迁移入口，成功后应删除临时环境变量。`inspect` 只返回元数据，`delete` 只删除精确 ID。

这符合 Microsoft 对 Windows 应用使用 Credential Manager API、避免记录密码和敏感信息的建议，参见 [Handling Passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords) 与 [CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)。当前 UI 设置页只显示 provider label 和 credential reference，没有 Key 输入框、账户登录或上游 onboarding；后续若增加 UI 输入，必须调用同一 broker，且不能进入 React 持久状态、URL、localStorage 或 Bridge snapshot。

## 2. 文件和网络读取

文件工具只接受工作区根、项目受控目录或用户逐个导入的真实文件；路径穿越、敏感文件名、符号链接/junction 和越界 sibling 均拒绝。错误只返回稳定代码，不回显真实绝对路径。

`SecureWebFetcher` 对网页来源执行以下顺序：

1. 只接受无内嵌凭据的 HTTPS URL，拒绝 localhost、私网、link-local、metadata、保留和映射地址。
2. 解析完整 DNS answer；任一地址不公开则拒绝。
3. 实际 TLS 连接通过自定义 lookup 固定到已检查地址，保留原 hostname/SNI，防止校验后 DNS rebinding。
4. 301/302/303/307/308 不自动继承首个决定；每一跳先解析相对 URL、去 fragment、重新做 DNS/私网检查，再发下一个请求。
5. 不发送 cookie、Authorization 或用户自定义 header；`Accept-Encoding: identity`，有超时、重定向数和 byte 上限。
6. 只接受 UTF-8 `text/plain`、`text/html`、`application/xhtml+xml`。其他 MIME、过大 body、非 2xx 和非法编码均在暴露正文前失败。

网页正文统一标记 `external_untrusted`、`instructionAuthority=none`。HTML 在无脚本模式解析，移除 script/style/iframe/object/embed/link/meta/template/noscript/svg/math；事件属性和标签不会作为 HTML 进入 UI 或模型工具权限层。提示注入文本可以作为来源内容被引用，但没有改变系统指令、申请权限或调用工具的权威。

## 3. 派生 UI 与 Local Web Host

- renderer 和 `packages/ui` 不含直接 provider URL、遥测、分析、自动更新、账户提交、任意 `window.open`、`eval`、`new Function` 或 `dangerouslySetInnerHTML` 路径。
- 浏览器只通过 `WebClientBridge` 访问已校验的 `127.0.0.1` 同源 Host，并使用 `credentials: same-origin`；provider 网络只发生在 Node runtime。
- Local Web Host 使用随机 loopback 端口、一次性 bootstrap capability、内存 session capability、精确 Host/Origin/protocol/generation 校验。
- CSP 固定 `script-src 'self'`、`connect-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、`form-action 'none'`，并设置 `X-Frame-Options: DENY`、`nosniff` 和 `no-referrer`。
- production bundle 不含 Mock、旧 Tauri、外部 DSH host、local/sessionStorage 或上游默认 endpoint。设置中的反馈、账户、遥测、更新和在线插件入口保持删除。

这些边界由 `tests/test_ui_upstream_sources.py` 和 `tests/check_ui_distribution.mjs` 同时检查源码与正式 bundle；当前没有引入新的 UI 视觉差异。

## 4. 诊断包

诊断导出分两步：

```text
allowlisted snapshot
  -> preview manifest + per-file SHA-256 + confirmationHash
  -> user confirms exact hash
  -> ZIP atomically published without overwrite
```

可选 section 只有 `application`、`provider`、`runtime`、`security`。每个 section 重新构造固定字段，不序列化传入对象；额外字段、原始日志、exception message 和 provider body 即使存在也会被忽略。manifest 固定声明排除：

- API Key 与 credential value；
- 文章、材料正文；
- 完整 prompt 与 tool result；
- 私人/绝对路径；
- 原始日志与异常消息。

provider 只保留 ID、协议、模型、声明能力、连接状态和稳定错误码；runtime 只保留聚合计数、预算、停止原因和 nullable usage。cost 为 `unknown` 时 amount/currency/pricing/verifiedAt 全部为 `null`，不伪造 0。security 只保留边界开关与存储方式。

导出前必须提交与预览完全相同的 `confirmationHash`。ZIP 先在目标目录写入权限受限的随机临时文件并 `fsync`，再以 hard link 原子发布；文件名不能含路径，目标已存在时拒绝，临时文件始终清理。压缩包本身不含输出目录或个人路径。

## 5. 明确限制

- Credential Manager 实机闭环只在本次 Windows 开发机用一次性假凭据验证；未在干净 Windows、企业域策略或非 Windows 系统验收。
- 默认安全网页 transport 已做单元/类型验证，本轮未访问公网；代理、自定义 CA 和企业 TLS 场景尚未验收。
- 诊断包目前是 runtime library 合同，尚未增加 UI 选择/预览页面；未来 Bridge 接入必须保持相同 allowlist 和确认 hash，不能把 raw log 直接下载。
- WA-017 已完成 Electron renderer/preload 隔离、固定 IPC、自定义协议、导航和安装包扫描；当前开发机安装/启动/卸载通过。独立干净 Windows 与人工全旅程仍由 WA-018 终验。
