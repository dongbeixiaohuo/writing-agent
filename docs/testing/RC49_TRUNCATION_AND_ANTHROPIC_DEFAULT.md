# rc.49：截断三连修复与 Anthropic Messages 统一默认

日期：2026-09-27。范围：模型输出截断恢复、DeepSeek thinking 全协议修复、供应商预设统一体验；不修改写作工作流、事实门禁、存量项目数据或凭据。网络搜索按用户决定推后。

## 根因与证据（用户报告两项）

1. **输出被截断**：工作区留证——"FDE"项目研究阶段连续两次 `MODEL_OUTPUT_TRUNCATED`：`outputTokenLimit=4096`（adapter 默认值）、`partialTextLength=0`（partialTextHash 为空串哈希，即**零可见文本**）、且恢复重试的 `nextOutputTokenLimit` 仍是 4096（**同预算重试**），于是必然再次截断并失败。该请求走用户手工配置的 DeepSeek Anthropic 端点（`api.deepseek.com/anthropic/v1`，`anthropic-messages-v1` 适配器），未带 thinking 开关——**thinking 推理烧光了整个输出预算，正文一个字都没产出**。
2. **协议碎片**：DeepSeek 一家就有 Chat / Responses / Anthropic 三套接口，用户已在三套协议上各踩过一次坑（Responses 400、Chat thinking 拒绝、Anthropic 截断）。用户决定统一走 Anthropic Messages 体验，并要求预置供应商"只填 Key，不选协议和地址"。

## 修改

1. **截断三连修复**：
   - anthropic 适配器新增 `extraBody`（与 Chat/Responses 同款：只追加、不覆盖协议字段、快照一致）；
   - DeepSeek 的 thinking-disabled 覆盖到第三种协议：`deepseek-anthropic` 预设声明 `thinking: {type: 'disabled'}`，`withPresetExtraBody` 匹配放宽为"规范化端点"（端点 `/v1` 后缀归一、不看 providerId、不看协议）——**用户现有的手工 Anthropic 配置在读取时自动获得 thinking 关闭，无需任何操作**；
   - 截断恢复重试把输出上限一次性 **×2（封顶 65536）** 并记入事件（`nextOutputTokenLimit` 记录升级后的值），同预算重试不再必然二次截断。运行时测试钉住：恢复请求 4096→8192，scope 切换后重置，混合重试各自独立。
2. **Anthropic 统一默认**：DeepSeek、Kimi 国内/国际、智谱 GLM / Z.AI、千问国内/国际、火山豆包、SiliconFlow 国内/国际新增 Anthropic Messages 变体（端点与认证取自同一固定 commit `da193d4f` 的 `claudeProviderPresets.ts`，`ANTHROPIC_AUTH_TOKEN` = Bearer）。`ANTHROPIC_PREFERRED_PRESETS` 接管这些家族的新选择默认（选择界面只显示 Anthropic 变体，只填 Key）；Chat/Responses 变体保留在完整目录中用于存量识别，但从新选择隐藏。`RESPONSES_PREFERRED_OVER_CHAT` 收缩为 OpenAI / OpenRouter。MiniMax 本来就是 Anthropic 协议。目录 120 项，新选择可见 99 项。存量配置不迁移、不改写。

## 已验证

- 截断恢复：schema-correction 14/14（升限、封顶、scope 重置、混合重试）；anthropic extraBody 20/20（wire 合并且不覆盖协议字段）；预设 15/15（变体身份/认证/偏好/计数）；provider-profile 12/12（Anthropic 配置端点级填充）。
- Bridge 63/63、UI 78/78、Desktop 44/44；runtime 全套 257/257；runtime/web/desktop TypeScript 通过。

## 未验证边界

- 除 DeepSeek（用户实测工作中）与 MiniMax（生产使用中）外，其余 Anthropic 端点均为配置元数据收录，未逐账号验证；选择界面的"预设参考"继续如实标注，不冒充已验证账号兼容性。
- DeepSeek Anthropic 端点对 `thinking: {type: 'disabled'}` 的接受依据是其跨 API 统一 thinking 开关的公开文档与端点级现象推断，未经真实账号专项验证；若端点不认该参数，会以带具体上游原因的失败呈现（rc.44 的错误摘要链路）。
- 用户现有手工 Anthropic 配置获得 thinking-disabled 后是否彻底消除截断，待用户安装后实测确认；×2 升限只在恢复重试那一次生效，不会常态放大输出成本。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.49-x64.exe`；SHA256 `0f977d2ab8fa8b337268680f07912d08d18736dcb66046d1267aa63c6af11bbd`，已登记 `output/desktop/SHA256SUMS.txt`。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0、709 ms（`output/rc49/desktop-smoke.json`）。
- 两处 `resources/app.asar` SHA256 一致：`daa7b8367ca7dc1ffd4ad9c0e5046167aa7ca3a07d401c685a90c3a57f03eb31`。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证，未触碰用户正在运行的已安装实例与真实凭据。
