# rc.32：首条交流有回复却触发调用保护

日期：2026-09-24。针对当前故障的可复测候选，不代表整体验收通过。

## 取证与根因

只读检查用户库中 `3c7dbca4-934e-4db1-bc1d-bb83b4512de1`（本地 9/24 00:44，“写一个人天天内耗怎么办”）。四次 request.completed 均为正常普通文字，0 次工具调用。后续请求快照显示程序反复追加“必须调用 respond_writing_intake”，但 toolChoice 始终为 auto，系统提示又始终要求先普通文字回复。四次均未提交状态，触发 4/4 内部保护。第五份 prepared 快照没有实际请求；不能把快照数量误认为付费调用次数。

这是应用的保存续接契约缺陷，不是这四次 MiniMax 请求超时或账户额度不足；与 rc.31 的导演 finish 空转是不同入口。

## 修改

- 首次需求交流仍允许 auto：普通文字或工具中的 reply 均可流式展示。
- 普通回复结束但尚未保存时，应用进入保存模式：下一请求 required，仅开放 respond_writing_intake；系统提示切换为只保存，不再要求先写另一版回复。
- 保存指令明确不是作者确认、材料或授权；proposal/confirmation/CAS 等现有校验不变。
- 保存成功即结束；未提高 4 请求/2 工具保护。提供方忽略必选工具、真实参数错误、网络异常仍可能失败，不保证所有外部行为都成功。
- intake 预览跨本轮保存请求保留同一消息，工具参数不能把完整预览倒退成半句；停止、失败、执行段结束后清除。不会把预览当持久内容。

## 验证

先红测：新增用例重现 4 次请求、0 次工具、BUDGET_EXHAUSTED；预览连续性用例重现保存请求前文字消失。修复后均通过。

- Conversation 62/62，Runtime 228/228，Bridge 60/60，UI 65/65，Desktop 33/33。
- runtime/web/desktop TypeScript、生产构建及桌面分发边界 13 files 通过。
- 日志 `output/rc32-*-tests.log`。
- MiniMax-M3：三次独立新对话（两次原题，一次“不知道写啥”）及一次补充交流，各 1 请求、1 工具保存；没有 confirmed 或正文。新对话采样观察到 6/10/5 个不同预览长度。另将真实事故首条文字离线重放，再向真实 MiniMax 发出 required 保存请求：1 次真实请求保存成功，整体 2 个记录请求，其中第一个是离线重放。
- 总计 5 次真实模型请求，已报告 2463 Token；输入被适配器报告为 0，不能据此推断实际输入免费/为零，费用未知。回放请求无真实用量，不能作为 missingUsage 的付费请求统计。
- 真实证据 `output/rc32-intake/real-result.json` 与 `real-save-result.json`。真实保存回复存在措辞整理，未将“逐字不变”作为已验证保证；主题、追问及未确认状态保持。
- 最终打包客户端原生测试：本地 Anthropic SSE 分片 → 普通文字 auto → 保存 any → 后续交流 → 重载；另测保存等待中停止。两场景通过，0 次付费调用、0 原项目写入，正文为空。证据 `output/rc32-intake/native-save/`、`native-cancel/`。
- 原生脚本首次因错误假设 bridge 暴露 reply 字段而失败，改为核对真实 timeline 后通过，未因此修改产品。停止回放时本地测试 HTTP 连接的 WinError 10054 是预期取消，应用状态验证为 cancelled、未持久保存回复。

## 交付

`output/desktop/Writing-Agent-Setup-1.0.0-rc.32-x64.exe`，111463738 bytes。

SHA256：`9b5e328032e8eb709acdd42ce7e91bea3e7da447e83ae5ce936514ba1301ad90`。

原生测试与打包目录 app.asar 均为 `d12ae6c5f87fa6ee80afef76fe0b71daf74a203b9bf5194da8162b2120f92e73`。

未自动安装、发布或修写用户失败历史。旧失败记录继续保留；升级后可在原项目继续交流。完整文章质量及更长多轮可靠性仍需独立验收。
