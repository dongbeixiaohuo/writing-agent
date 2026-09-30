# rc.16 桌面反馈字段丢失修复

2026-09-21。用户在 rc.15 标题卡输入“这不是标题，请重新拟三个，正文不要改”，点击发送仍提示“未能开始写作。请检查模型配置和网络后重试”。本轮是同一问题的桌面传输补修，不代表完整产品验收完成。

## 实证根因

只读取已安装 `D:\Programs\Writing Agent\resources\app.asar` 确認版本是 `1.0.0-rc.15`。用户原运行 `aa179569-9f06-4f67-bd0f-c28f86ea8ce3` 仍为 `waiting_user`，当前项目没有新增 run，说明这次失败在模型调用之前。

`CheckpointDecisionCard` 把非空 feedback 交给 `ClientBridge.resumeRun`；但 `DesktopClientBridge.resumeRun` 错误地只接受 `BridgeCommandOptions` 并重新构造 `{operationId}`，把 feedback 丢弃。后台标题讨论因此收到空字符串并抛出 `EMPTY_MESSAGE`。该码不在 RPC 白名单内，变成 `DESKTOP_COMMAND_FAILED`，UI 又无依据地归因为配置或网络。

失败链：用户意见 → **DesktopClientBridge 丢字段** → 后台空内容 → 通用安全错误 → 误导性网络提示。不是 MiniMax 或 Key 问题，也不是用户表达格式问题。

同一缺陷也影响提纲/审稿/补充材料等检查点卡片，因此新增三类参数传递回归，不只匹配这句标题反馈。

## 修复与验证范围

1. 桌面恢复参数使用已有协议 `ResumeRunOptions`，明确传递 feedback，保留 operationId 默认生成及无反馈恢复的兼容性。不扩大 IPC allowlist 或 renderer 权限。
2. RPC 单独保留安全 `EMPTY_MESSAGE` 错误码；未知故障改为原因未确认的提示，不再无证据要求用户改模型或网络。其他内部详情仍不透传。
3. 采用系统化调试/TDD，先复现后修复。3 条桌面传递断言、空消息分类和通用错误文案均先失败再通过。
4. rc.15 的后台/生产 Web/真实 MiniMax 测试未覆盖 DesktopClientBridge；此前把它们作为桌面复测交付依据是不充分的。此次补的是实际 Electron renderer→preload→IPC→Host→Storage 路径，而不是再次只测 Web。

## 完整历史副本重放

`tests/ux/rc16_title_desktop_replay.ts` 用 SQLite backup API 从只读源创建独立副本，保留历史 session、run、事件和候选，源项目写入 0。

- `output/rc16-title-desktop/offline-3blCHW`：直接 Host 入口通过，不能据此证明客户端传递正确。最初诊断结果包含完整 snapshot，仅在本地；脚本随后改为最小元数据，避免重复输出项目内容。
- `offline-u4Bnko`：经 DesktopClientBridge 的修复前重放，`feedbackReachedHost=false`、`submissionAccepted=false`、`DESKTOP_COMMAND_FAILED`、模型入口调用 0，复现截图。
- `offline-kSh2I5`：修复后同一路径，`feedbackReachedHost=true`、`submissionAccepted=true`、到达离线模型入口 1 次。该离线 Provider 故意停止，不冒称模型生成成功。

本轮未使用真实凭据或付费模型。原工作区只读备份，不修改现有项目或关闭用户当前应用。

## 真正打包后的桌面点击

脚本：`tests/ux/rc16_prepare_electron.ts`、`tests/ux/rc16_packaged_title.py`。将 rc.16 打包应用复制至独立 TEMP 目录，确认 ASAR hash 相同；用产品原有独立测试模式启动，profile/workspace 与正常安装完全分离。本机 loopback OpenAI-compatible SSE 夹具使用虚假环境 Key，只有 3 次本机请求，真实模型调用 0。没有修改生产程序以注入测试方法。

证据：`output/rc16-title-desktop/rc16-8a435695-e6f2-448b-8a9b-79fff5a7b7d3/result.json` 与 `desktop-title-success.png`。

- 在实际 `writing-agent://app/index.html` 窗口定位标题卡并点击“发送意见”，不绕过按钮调用恢复函数。
- 用户意见原文出现在持久对话中，运行从 10 条变成 11 条。
- 3 个候选通过模型工具、真实存储提交并展示；输入框清空，无卡片错误。
- 正文版本不变，旧运行继续 `waiting_user`，未代选标题或提前核查。
- renderer 刷新后候选仍在。
- 退出隔离应用时，本机 HTTP 服务出现空连接的 ConnectionReset 日志；业务断言与 3 次请求均已通过，不作为模型或产品错误。没有隐藏此日志或改为真实外联。

这验证桌面传输与持久交互，不是新一次真实模型内容质量验收。rc.15 记录中的候选质量局限仍适用。

## 工程与制品

- `check:desktop`：类型检查、桌面 33 项、生产 renderer/runtime 构建、13 文件分发边界通过。
- `test:ui` 54 项、`test:bridge` 47 项通过；DesktopClientBridge 专项含 3 个新增反馈案例。
- 打包后 ASAR 版本 `1.0.0-rc.16`；内容清单 12 项 hash 通过，桌面桥 bundle 含 feedback。首次归档检查误将 listPackage 的前导分隔符用于 extractFile，修正检查路径后通过，未改制品。
- 隔离启动 `output/desktop/rc16-feedback-smoke.json`：退出码 0，协议 20，stderr 为空。
- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.16-x64.exe`，111448700 字节。
- SHA-256：`498f06ae6df23489d8fff6fc56bde2d2aa9fc58b45139a94ffbfc38a11b7621a`，与独立构建目录源制品一致，已更新 `output/desktop/SHA256SUMS.txt`。
- 未签名、未发布 Release、未自动安装。rc.15 与历史安装包保留；原生升级及原会话使用仍待用户复测。WA-010 和整体验收状态不变。

本轮由主 Agent 完成，没有新增子 Agent 或真实模型用量。
