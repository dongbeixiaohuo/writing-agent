# rc.39：从指定 cc-switch 文件补齐 API 预设

日期：2026-09-26。范围仅限模型设置、静态预设及分发版本；不改 Agent 工作流、调用预算、存量项目或模型配置。

## 输入与实现

- 只读取用户指定 `codexProviderPresets.ts`，固定来源 `da193d4f7a6ce3710623c312245c752376c0d036`。未另搜厂商网站；网络读取仅为此文件及同仓库的版本/许可证。
- 93 条源资料中 90 条 API Key 接口转为数据，2 条 OAuth 和 1 条 Azure 资源/参数模板明确排除。上游程序及提示词不执行、不导入。
- `apiFormat` 优先于 Codex 侧 `wire_api`：例如腾讯个人套餐、AtlasCloud、ModelScope、Nvidia 实际调用 Chat；不能看到 Codex 文件就一律用 Responses。
- 90 条合并为 87 个协议/端点组合；与原目录去重后新增 86 项，再加 OpenAI Responses API Key 项。保留原 15 项，合计 102 个接口配置。不是 102 家不同公司。
- 中文/英文/模型/协议搜索、分组、可见 API 格式与地址、离线模型 ID 示例；示例不自动选中，不冒充账号已开通模型。第三方收件方与套餐用途边界明确提示。
- 选择和浏览零网络、零 Key 检查；只有保存验证/读取目录等显式动作才请求 Host。新格式和旧格式并存，不把原有 MiniMax 切成 Responses。
- `THIRD_PARTY_NOTICES.md` 和来源清单登记提取范围、MIT 版权及文件哈希。保留自定义接口。

## 已验证

- 预设专项 8 项：源资料覆盖、三种 wire 映射、精确端点归并、旧预设并存、示例完整性、搜索、凭据隔离。
- UI 69/69、桌面 42/42、三种适配器 20/20；来源/分发 Python 11/11。
- bridge 类型生成、web/desktop TypeScript、生产构建及桌面分发边界 PASS（13 files）。
- 生产 renderer + 独立 Host 浏览器交互 8 项通过：102 项目录、搜索、Responses/Chat/Anthropic 切换、零写入预览、模型示例、旧配置改模型、列表零凭据读取、更换地址拒绝复用 Key。无页面异常，无 renderer 对外网络请求。
- 界面截图已检查：`output/playwright/provider-presets/00-responses-preset.png`；浏览器证据 `output/playwright/provider-presets/result.json`。
- rc.39 打包后的实际 Electron：PASS；模型列表约 109 ms 可见，新 Responses 预览不写配置；等待确认旧项目切换模型后会话、runId 和现有 Key 保持，更换端点不复用旧 Key。证据：`output/rc39/native/rc39-14d4374c-13c2-4117-9aff-2dfc5fadfe0d/result.json`。
- packaged smoke：ready，退出 0，约 972 ms，stdout/stderr 为空；证据 `output/rc39/desktop-smoke.json`。独立 rc39-build 构建，同包复制至短 TEMP 路径测试，app.asar SHA256 一致：`865adb225770fc5f5d0334fa5c3a65abd1c24e4f003f0412a9c16cfe9e5d50d6`。
- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.39-x64.exe`；同目录 `SHA256SUMS.txt` 提供校验。未签名，未运行安装器。

## 验证边界

- 收录是配置元数据支持，不是所有付费账号均已实测连通。此轮没有使用用户 Key 向新增地址发请求，也没有购买/开通供应商。
- 不照搬源模型的上下文长度、思考档位、特殊头、OAuth、账号订阅权益或厂商身份提示词。服务商若要求这些额外契约，仍需专项适配，不能靠预设数量宣称支持。
- 不运行安装器，不关闭用户正在运行的软件，不提交/推送/发布；新增包位于用户指定 `output/desktop`，原生验证使用独立 TEMP 工作区。
