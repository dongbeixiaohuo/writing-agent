# rc.43：DeepSeek 协议证伪更正、编辑直达与对话框快捷切换

日期：2026-09-26。范围：DeepSeek 目录协议更正、模型设置的编辑跳转、对话框模型快捷切换；不修改写作工作流、事实门禁、存量项目数据或凭据。

## 根因与证据（用户报告）

用户报告三项问题，前两项有现场证据：

1. **切换 DeepSeek 后运行失败**，界面提示"模型服务拒绝了请求，请检查服务类型、API 地址和模型 ID"，用户确认 Key 正确。
2. 已配置验证的模型无法在对话框直接切换，必须进入设置页。
3. 点击已保存配置的"编辑"后落在预设供应商目录位置，需向下滚动才能填写表单。

只读检查用户工作区（`workspace.sqlite3` 的独立副本，未写入原库）：

- 2026-09-26 08:24 与 08:26 两次真实运行，provider `cc-deepseek`、模型 `deepseek-flash`、适配器 `openai-responses-v1`，均以 `request.failed` 结束：`code: INVALID_REQUEST`，`providerHttpStatus: 400`。
- 对应 `request_snapshots.normalized_payload_json` 为本应用 Responses 适配器的标准请求体（`store:false`、`include:["reasoning.encrypted_content"]`、工具数组、`tool_choice:"required"`）。
- 用户同时反馈保存后的连接验证也失败（最小探测请求同样被拒）。

结论：Key 通过了认证（不是 401/403），DeepSeek 官方端点以 400 拒绝了本应用的 Responses 请求体。cc-switch 资料中"DeepSeek 官方原生支持 Responses"的声明（rc.39 收录，rc.38 起即标注未经真实账号验证）被首次真实账号使用证伪。DeepSeek 的 Chat Completions 是其主力文档 API，属于可验证路径。

## 修改

1. **目录更正**：`cc-switch-codex-presets.ts` 中 `cc-deepseek` 的 `apiFormat` 由 `openai_responses` 更正为 `openai_chat`（附证据注释）；`provider-presets.ts` 的 `RESPONSES_PREFERRED_OVER_CHAT` 注释说明该配对对 DeepSeek 变为"同身份去重"而非 Responses 偏好；`upstream-sources.json` 两个派生文件哈希同步；`docs/implementation/PROVIDER_PRESETS.md` 新增 rc.43 节留证。存量 Responses 配置不自动迁移（显示为自定义连接），改协议需重填 Key。
2. **编辑直达编辑页**：`ProviderSettings` 进入编辑态后整个视图切换为编辑器（列表、提示、添加入口隐藏）；编辑已保存配置时折叠预设目录为单行摘要（"当前预设 + 更换供应商预设"按钮），表单字段（Key、模型、显示名称）直接落在首屏。新建配置的流程不变（仍先选预设）。
3. **对话框快捷切换**：Composer 的模型 pill 改为下拉菜单（新组件 `ModelSwitchMenu`）：展开时按需读取 `providerStatus('summary')`，列出所有已保存 Key 的供应商 × 模型，当前项标记"当前使用"；选中即调 `selectProvider` 直接切换，pill 标签随快照更新；运行中切换由 Host 拒绝并在菜单内显示原因；底部保留"管理模型设置…"入口。无 Host 环境（如 Web Mock）回退为原来的跳设置按钮。

## 已验证

- 目录专项 `provider-presets.test.ts` 14/14（含 DeepSeek Chat 例外断言）；上游来源与哈希 `test_ui_upstream_sources` + `test_upstream_sources` 12/12。
- UI 77/77、Bridge 60/60、Desktop 43/43。
- TypeScript：web、desktop 通过；生产 UI 构建通过；`check_ui_distribution` PASS。
- 错误分类复核：两次失败为 HTTP 400（非 401/403），与"Key 正确"的用户陈述一致；DeepSeek 网关对任意路径的假 Key 均返回 401，外部无 Key 探测无法判定端点存在性，未作为证据使用。

## 未验证边界与待办

- **未运行浏览器/原生/打包验证，未出安装包**：本轮为源码与单元级验证；960×640 交互、原生 IPC、packaged smoke 待补。
- **DeepSeek Chat 路径未经真实账号验证**：协议更正依据是"Chat 为主力文档 API"的公开事实和 Responses 被证伪的证据，但更正后的 Chat 配置需用户用真实 Key 保存并验证连接后才能确认。
- **用户已保存的 DeepSeek 配置需要手动修复**：该配置仍是 Responses 协议，将显示为"自定义连接"。操作路径：编辑该配置 → 自定义设置 → 修改协议或使用自定义 API → API 协议选 OpenAI Chat Completions → 重新输入 Key → 保存并验证连接（改协议不复用旧 Key）。
- `deepseek-flash` / `deepseek-v4-pro` 模型示例沿用 cc-switch 源资料（其声称核对过官方 Codex 文档），未用真实账号逐一验证；示例不存在时连接验证会以"模型标识不存在或当前账户不可用"明确失败。
- 诊断改进建议（未实施）：当前 `request.failed` 只保留 HTTP 状态码，上游错误正文被丢弃；若在脱敏后保留上游 `error.message` 摘要，此类问题可让用户当场看到真实原因（如"unknown parameter"），不必事后挖库。
- 其余 9 组 Responses 偏好配对同样未经真实账号验证，首次被证伪时按 rc.43 同样方式更正并留证。

未提交 commit、未推送、未发布；未修改用户原工作区、原配置或 Key。
