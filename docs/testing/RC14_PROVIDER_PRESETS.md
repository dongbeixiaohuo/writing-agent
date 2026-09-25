# rc.14：模型供应商预设

日期：2026-09-21。用户要求参考 cc-switch 预置连接信息，降低初次配置门槛，同时保留自定义供应商。本页验收这项配置体验；同版另含[研究阶段输出截断修复](RC14_OUTPUT_TRUNCATION_FIX.md)，不提高完整写作流程或最终用户验收状态。

## 实现

- 本地静态内置 15 个预设，按国内、国际、聚合平台分组；选择后自动填写协议/API 地址，只需填写自己的 Key 和模型 ID。
- 保留自定义协议、HTTPS 地址、模型和高级配置入口。已有配置不自动迁移，旧 MiniMax 域名按自定义原样显示。
- 明确地域、通用 API 与 Coding Plan、网页订阅之间的区别；不复制套餐推广、返佣、SDK 或 Claude Code 专属参数。
- 更换供应商/地域/地址/协议清空未保存的 Key；切换预设同时清空模型，防止误用上一个供应商的凭据与模型。
- 选择本身没有网络或保存动作；提交后沿用 Host 凭据管理及连接探测。编辑草稿后不能再用旧配置的探测结果误报成功。
- 修复长设置页把侧栏与关闭按钮挤出可视区域的问题，滚动限制在右侧内容区；切换设置分类保留未提交草稿。
- 独立复核发现旧自定义 Anthropic 配置重新保存会丢失高级鉴权参数：同一规范化端点现保留 `authHeader`、`anthropicVersion`、`defaultMaxOutputTokens`，显式有效输入优先；不同端点或协议不继承。这些 wire 参数不新增到初学者表单。

15 个预设与固定上游 commit、官方资料和路径差异见 [实现说明](../implementation/PROVIDER_PRESETS.md)。当前仅支持 OpenAI Chat Completions 与 Anthropic Messages 兼容协议，不等于完整复制 cc-switch 的所有产品能力。

## 实际验证

| 项目 | 结果 |
|---|---|
| 新增预设单测 | 5 项通过；此前已观察未实现时失败。覆盖目录、Key/模型清空、15 个模板通过实际配置归一化、custom 保留、旧域名和恶意子域名不误匹配 |
| `npm run check:ui` | 类型声明/TS、53 项 UI、43 项 Bridge、生产/Mock/扩展演示构建、分发边界及 11 项 Python 来源/安全检查通过 |
| 真实浏览器专项 | 7 组场景通过；1360×900、960×640；无 page error，无 renderer 外网请求 |
| 设置布局回归 | 修复前关闭按钮可视比例为 0，修复后两个视口均可见；包含滚动、分类切换与草稿保持 |
| Anthropic 保留回归 | 修复前 `authHeader` 从 `authorization` 变为 `undefined`；修复后读回/显式覆盖/端点及协议隔离通过，provider-profile 共 5 项通过 |
| 最终 `npm run check:desktop` | 最后兼容修复后，TS、32 项桌面测试、生产构建和 13 文件分发边界检查通过 |
| 最终浏览器复跑 | 截断修复及最终生产构建后 7 组重新通过，工作区 `workspace-KYlhww` 保留；此前 `workspace-QZodH7` 也保留 |

浏览器使用生产 renderer、真实 DesktopApplicationHost 和真实配置 JSON 持久化，凭据后端为隔离内存实现，连接探测结果为合成 success/failure，fixture 全局禁止外网。覆盖选供应商、空模型校验、保存、无 Key 落盘、自定义读回、失败提示、旧配置验证禁用和小窗口操作。

浏览器证据：`output/playwright/provider-presets/result.json`、`01-preset.png`、`02-small-window.png`。脚本：`tests/ux/provider_presets_fixture.ts`、`tests/ux/provider_presets_browser.py`。专项工作区均保留，未清理目录。

预设功能使用 1 个只读复核 Agent，任务为端点/协议/旧配置/Key 边界检查，继承当前模型与推理档位（工具未回传精确设置，不声称 Ultra）。复核发现的旧自定义参数丢失已修复，最后复核无剩余阻断；后续截断修复另有专项复核，见对应记录。

## 边界与待用户检查

- 供应商预设专项真实模型调用为 **0**，没有使用原有 Key；同版截断修复另使用获授权的 **1** 次 MiniMax-M3 请求。两项都没有修改用户已安装应用、正式工作区或系统凭据。
- 15 个模板经过资料核对与本地协议路径检查，不代表 15 家供应商已用真实账号验证。模型权限、额度、地域、网络和工具调用能力仍须用户提交后实际验证。
- 本轮不自动关闭用户应用、不安装覆盖旧版本、不公开发布。沿用现有升级机制，rc.14 原位安装过程需用户体验确认。
- 可进行此功能桌面体验测试；WA-010 仍为 `IN_PROGRESS`，不宣称完整产品最终验收通过。

## 安装制品

- 最终产物：`output/desktop/Writing-Agent-Setup-1.0.0-rc.14-x64.exe`，**111,446,786 字节**，unsigned NSIS。
- SHA-256：`a62240e109b2ca131ef2f0e16842f7f7824f7a4135b165bbb57d7c12316febee`。同目录 blockmap 与 `SHA256SUMS.txt` 已生成，旧安装包保留。
- 最终构建目录为 `output/desktop/.rc14-verified-build`，electron-builder 退出码 0。早先 `.rc14-build` 为未包含截断修复的中间构建，不用于交付，未复制到安装包目录顶层。
- 从实际 `app.asar` 读回版本为 `1.0.0-rc.14`，主程序包含 131072 默认值、MiniMax-M3 和 `MODEL_OUTPUT_TRUNCATED` 修复；不是仅修改源码后交付旧包。
- 将最终 unpacked 产物复制到独立 TEMP 目录进行启动检查，避免既有 OneDrive/Chromium 启动问题。原件/副本 `app.asar` SHA-256 均为 `c9eb8d1c5bd28dfc60ff28d8fb1560210b15ca3c3693c67152b8078c5add0610`。
- 2026-09-21 01:46:26 +08 启动检查：**847 ms、退出码 0、ready、协议 20、writing-agent://app/index.html**，stdout/stderr 为空；证据 `output/desktop/rc14-final-smoke.json`。
- 冒烟使用隔离数据库，保留测试数据。未安装覆盖、未关闭用户原应用，不把无界面握手视作原生窗口完整体验或安装升级验收。
- 用户复测步骤：`output/desktop/rc14-测试说明.md`，优先回到原会话复测研究阶段，再检查供应商设置。
