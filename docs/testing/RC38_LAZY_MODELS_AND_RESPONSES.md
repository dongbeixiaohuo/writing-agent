# rc.38：模型列表按需加载与 OpenAI Responses

日期：2026-09-25。范围：模型设置读取链路、第三种文字模型协议；不修改原项目或写作阶段门禁。

## 根因与变更

- 旧 `providerStatus` 等待所有供应商的 `inspect`，还对当前配置重复检查。Windows 每次 inspect 包含探测及读取两次后台 PowerShell 启动，列表必须等待。
- 测试先复现：两个供应商打开列表触发三次凭据检查，期望零次的测试失败；修改后通过。
- 设置改用 `providerStatus('summary')` 只读本地配置。编辑时 `providerDetails(id)` 仅检查指定凭据，表单先展示。未知状态不当成丢失或连接成功；取消/切换编辑对象/保存后忽略旧异步结果。Key 明文仍不返回 renderer。
- 保存/切换仍校验凭据，仅返回当前配置的凭据状态，不再检查全部供应商。诊断入口保留显式完整检查，移除当前条目的重复读取。
- 自定义协议增加 `OpenAI Responses`，配置 kind `openai_responses`；独立 adapter 实际 POST `/responses`，不是把协议名称换掉继续发送 Chat Completions。
- 支持真正的文字/工具参数增量、call_id 工具结果回传、usage、取消、超时和安全错误分类。SSE 缺终止、incomplete、failed 不释放未完成工具。原有 JSON Schema 工具验证保持生效。
- `store:false`；加密 reasoning 续接随已验证工具历史保留，仅相同协议/供应商/地址/模型可重放，不变成公开正文。重新建立 adapter 并 JSON 序列化历史后续接测试通过。不自动改动现有 MiniMax 配置或预设协议。

## 验证结果

| 检查 | 结果 |
|---|---|
| Windows 实际凭据后端、随机不存在测试引用 | 列表约 0.473 ms，单项 Key 检查约 2591 ms；没有读取用户 Key |
| 生产 renderer + 隔离 Host 浏览器交互 | 7 项通过；打开已保存列表零次 Key 读取，编辑一项一次读取；Responses 保存重开；无页面异常/外部 renderer 请求 |
| Responses 本机 HTTP/SSE fixture | 5 项通过，覆盖增量到达早于完成、工具往返、加密续接、截断/超限/失败、取消/超时/HTTP 错误及缺 Key |
| 运行时全量 | 243/243，包括三种 adapter 和写作、存储、恢复、门禁回归 |
| 桌面、UI、桥接 | 42/42、66/66、60/60 |
| TypeScript | desktop、web、runtime 通过 |
| 分发边界 | PASS，13 files |
| 实际打包 Electron | PASS，设置列表约 110 ms 可见；等待确认的旧项目可换模型，项目/会话/runId 保持；更换端点不复用旧 Key |
| packaged smoke | ready，协议 20，exit 0，约 766 ms |

证据：`output/rc38/settings-latency.json`、`output/playwright/provider-presets/result.json`、`output/rc38/native/rc38-961ea576-7c30-4f09-81d3-8c3861bde00a/result.json`、`output/rc38/desktop-smoke.json`。

速度为本机隔离实测，不保证所有机器相同。桌面界面夹具用虚构环境变量 Key；真实 Windows 后端耗时另以不存在的专用测试引用测量。UI fixture 的连接探测是合成结果，Responses 协议测试则使用真实 loopback HTTP/SSE；两者均不是付费账户实测。

## 交付与未验证边界

- `output/desktop/Writing-Agent-Setup-1.0.0-rc.38-x64.exe`，校验值见同目录 `SHA256SUMS.txt`。
- 在独立 `rc38-build` 打包，未覆盖运行中的旧 unpacked 客户端。为避开前轮发现的长路径启动问题，原生测试使用同包文件复制到短 TEMP 路径；app.asar 一致性按 SHA256 核对。
- 未执行安装器，未提交 commit、推送或发布 GitHub Release，未写原项目/配置，没有新增付费调用。
- Responses 未进行真实 OpenAI/第三方中转账户验证。服务端必须实际支持 Responses、流式和函数调用；不支持的账户或模型仍会在连接探测中明确失败。
- 不包含 Responses 内置联网工具、多模态或 OAuth；采样采用服务端默认值。安全边界与整体产品验收结论不因本轮测试而放宽。

诊断采用 diagnosing-bugs 的先复现后修改流程，界面按 webapp-testing 做真实 renderer/native 交互；Responses wire 格式依据 OpenAI 官方文档核对。
