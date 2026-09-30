# rc.12：原版专家与对话能力迁移验证

日期：2026-09-21。范围：在独立桌面运行时接入原版专业方法和主对话专项能力。本报告不是原版全部能力等价证明，也不是最终用户签收。

## 已实现

- 21 类角色专业指令从 canonical `claude-runtime` 迁入中性 writing pack；阶段专家、专项专家、独立核查的真实请求包含相应方法。委派重建独立请求上下文，三审绑定同稿且禁止互读；不宣称独立操作系统进程。
- 已确认项目支持连续讨论、专项专家任务和局部修改建议；实际差异放在主对话，接受后才产生正文新版本。全文生成与讨论分开。
- 中途材料与用户明确授权绑定；网页只读取当轮用户明确给出的公开 HTTPS URL，拒绝私网/越权及失败导入。材料/网页/风格不具有系统指令权限。
- 标题候选、用户选择、分发文案和正文版本绑定；共创模式核查前等待标题确认。工程层要求实际持久保存，不接受模型口头声称候选已保存。
- 用户明确要求核查时必须交给独立事实核查流程，不能用文字评述假装已通过。未授权讨论不得触发核查。标题/正文变化使旧核查失效。
- 7 份原版风格档案及 15 维方法可读取，保留原验证状态。配图只策划与确认，不调用图片服务，不产生假图片路径。
- 明确批准的跨项目写作偏好可保存/遗忘。主对话提供备份、重新核查、正式导出入口；专项异常恢复不转为全文生成。

## 工程与浏览器验证

- `npm run check:runtime`：类型检查、运行时、迁移、38 项 intake/对话回归和 40 项本轮迁移回归通过。
- `npm run test:bridge`：40 项通过。`npm run check:desktop`：类型检查、30 项桌面测试、构建、13 文件分发边界通过。
- 最后发现并修复发布标题及分发文案内冒号被截断的问题；新增失败测试复现后，Core/Storage/Application 的 15 项核查/导出专项通过，并重新构建桌面资源。
- 收口复查补充 3 项“只讨论标题/配图，不强制创建产物”负向回归；修复后本轮迁移专项最终 43/43 通过，并据最终代码重新打包。没有为这些纯确定性判断再次消耗真实模型用量。
- 真实 Chromium + production renderer + ApplicationBridge + SQLite，使用合成 provider。5 项点击场景通过：主对话差异可见、接受只改目标段、核查失效、实际保存工作备份、只重新核查不改正文。没有打开“稿件与版本”，页面/控制台错误为 0。
- 浏览器最终证据：`output/legacy-parity-browser/result.json` 与同目录 5 张截图；保留工作区 `output/legacy-parity-browser-workspaces/run-jPbiPS`。不把该合成 provider 浏览器测试说成真实模型或原生窗口验收。
- 使用完成前验证技能核对命令、文件读回和打包结果；使用 Web 应用测试技能检查实际 DOM 和点击行为，没有只做静态截图判断。

## 用户授权的三组 MiniMax-M3 实测

复用现有配置，仅在独立合成项目调用。未修改模型配置及原项目。测试脚本：`tests/ux/legacy_parity_real_model.ts --allow-real-model [scenario]`。

| 场景 | 可检查结果 | 最终证据 |
|---|---|---|
| 连续讨论→局部改稿 | 第一次只讨论不写正文；下一次理解前轮方案，生成真实单段提案；接受后其余段落与虚构标注保留 | `output/legacy-parity-real/wa-legacy-parity-real-KDesQu/discussion_revision.json`，passed |
| 标题候选→选择→核查 | 三候选及分发文案真实落库；选第二个只更新发布标题；独立 fact-check run 完成、gate=passed；TXT 实际导出使用所选标题 | `output/legacy-parity-real/run-ipuGX0/title_fact_check.json`，passed |
| 风格参考→配图策划确认 | 实际读取 jiubian 档案；配图 plan 落库后收到用户确认；最终 status=confirmed，generationAvailable=false，imageFiles=[]，正文未改 | `output/legacy-parity-real/run-fuGp3f/style_illustration.json`，passed |

真实模型首次标题尝试暴露“只口头回应，没有对应持久产物”；第二次标题流程还暴露“口头核查通过，没有真实核查”。配图首次尝试证据不完整，不能据此断言成功或确定根因。增加实际结果契约后复测受影响场景，保留失败报告，未将失败伪装为成功。通过代表性行为场景不等于长文质量或普遍可靠性已经验证。

## 测试清理事故及证据边界

浏览器测试协作的清理过程曾误删主线真实模型临时工作区 `C:\Users\Dante\AppData\Local\Temp\wa-legacy-parity-real-KDesQu`，原因是按相同名称前缀错误判断目录归属。仅包含本轮合成项目，用户原项目未涉及；导出的 JSON 证据保留，临时 SQLite 无法恢复。已向用户说明。

该轮讨论/改稿报告已完整导出；最早配图尝试的数据库证据不完整，不作为通过依据。受影响场景已在新的独立保留目录重跑；此后的模型/浏览器脚本不再清理共享临时目录，保留具体运行工作区。不得通过其他 shell 绕过拒绝执行的清理操作。

## 尚未完成/尚未验收

- 开放式 WebSearch provider、自动风格量化与独立盲测、历史编辑差异自动学习、自动发布指标采集、任意活跃阶段暂停恢复尚未对齐。
- 图片生成按用户决定不接新增付费服务，不属于本轮承诺；现有能力止于策划确认。
- 桌面原生升级、系统文件保存窗口、真实长文和更多轮交互仍需最终用户体验测试。只有本报告明确列出的场景通过，不能据此宣布产品全部完成。

## 桌面交付

安装包只放 `output/desktop`，不会自动安装或关闭用户正在使用的软件。直接从 OneDrive 下的解包目录运行 smoke 曾遇到 Chromium GPU 进程崩溃（exit_code=-2147483645）；同包复制到独立 TEMP 目录并核对 app.asar 哈希后启动成功，根因未确定，不将首次失败隐藏。最终重打包结果和启动证据见下一条交付记录。

最终交付：`output/desktop/Writing-Agent-Setup-1.0.0-rc.12-x64.exe`，111,442,633 字节，unsigned NSIS x64；blockmap 和 SHA256SUMS 已同步。SHA256：`b6c634d1dd2051c74bb63e568bd5acf8d600320000a41da6018e6b6479c9e021`。中间构建仅存于隐藏构建目录，根目录 rc.12 为最终代码包，旧版本包保持不变。

2026-09-21 00:28:35 +08:00，最终包运行时复制到独立 TEMP 目录并核对 app.asar 哈希后，Electron 本地页面与 Bridge v20 握手通过，退出码 0，stdout/stderr 均空；证据 `output/desktop/rc12-migration-smoke.json`。最终 Runtime/Desktop TypeScript 检查通过。安装及 GPU 开启的原生窗口体验仍需用户测试，不能将 smoke 扩大解释为原生安装验收。

交付用户的具体步骤：`output/desktop/rc12-测试说明.md`。全部模型/浏览器/最终 smoke 工作区保留用于复核，不再做目录清理。
