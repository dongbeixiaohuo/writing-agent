# DSH UI 保真与协议基线计划

状态：`WA025_LOCAL_WEB_MATRIX_EXECUTED`  
对应任务：WA-002；执行任务：WA-023 / WA-025  
上游固定 commit：`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`

## 1. 当前结论

固定源码、上游依赖和 preview build 已在隔离 checkout 实际运行；WA-023 建立首批上游/派生基线，WA-025 已完成本地 Web 范围的量化视觉、真实 Application Service、项目隔离与 Bridge 异常矩阵。执行证据分别见 `WA023_RESULTS.md` 与 `UI_BASELINE_RESULTS.md`。Electron/安装包、非 Chromium 浏览器、OS 级 200% 文本缩放和屏幕阅读器人工流程仍未执行，不能由 Web 结果替代。

任何后续报告必须区分：

- `UPSTREAM_REFERENCE`：固定 DSH 源码在隔离测试目录运行；只用于对照。
- `DERIVED_MOCK`：移植 UI 连接确定性本地 mock；页面显著标识未接真实写作。
- `DERIVED_RUNTIME`：移植 UI 连接 Writing Agent 自有服务。

mock 页面能交互不等于 runtime、模型或写作质量通过。

## 2. 受控环境

| 项 | 固定要求 |
|---|---|
| OS | 同一 Windows 主机/版本记录；上游与派生版同轮运行 |
| 浏览器 | 项目锁定 Playwright Chromium；记录版本 |
| 视口 | 1440×900、1280×800 |
| 缩放 | 100%；记录 deviceScaleFactor |
| 主题 | light、dark；system 另测跟随切换 |
| 字体 | 使用相同本机字体环境；缺失字体明确记录 |
| 数据 | 只用确定性合成 fixture，不使用真实文章、API Key 或账户 |
| 网络 | 页面功能默认离线；上游源码/依赖安装网络与产品运行网络分开记录 |
| 时间 | 冻结显示时间；动态 id/token/计时仅精确遮罩 |

上游参考进程、profile、凭据、缓存和截图均放在隔离测试目录，不进入 Writing Agent 用户目录或发行包。

## 3. 固定场景

| 场景 ID | 内容 | 核心断言 |
|---|---|---|
| U0-EMPTY | 空工作区/无项目 | 空态、导航、创建入口、焦点顺序 |
| U0-NAV | 两个项目、三个会话 | 左栏层级、选择状态、切换不串流 |
| U0-CHAT | 中英文长对话、代码块、链接 | 消息布局、Markdown、安全链接、滚动锚定 |
| U0-STREAM | 文本流和 reasoning/tool 状态 | 增量更新、停止、迟到帧不覆盖 |
| U0-TOOL | pending/success/failure/cancel 工具树 | 状态真实、折叠、错误可读 |
| U0-SETTINGS | 通用设置、provider/model 配置 | 结构保真、自有语义、Key 不回显 |
| U0-PREVIEW | Markdown、文本、图片/PDF边界 | 只读、大小限制、路径授权、资源释放 |
| U0-LONG-ZH | 长中文段落、长标题、窄窗 | 换行、滚动、侧栏收放、无内容遮挡 |

HTML 脚本预览不进入首版等价场景；派生版必须以安全测试证明脚本不执行，并在差异清单记录为批准的安全收紧。

## 4. 捕获矩阵

每个场景至少捕获：

- 上游/派生两个版本；
- 1440×900 和 1280×800；
- light 和 dark；
- 稳定状态截图；涉及菜单、拖拽、流式状态时增加对应中间帧；
- DOM/可访问性快照、控制台错误和关键网络请求清单。

截图目标目录在 WA-023 建立：

```text
tests/ui-baseline/
  fixtures/
  scripts/
  snapshots/upstream/<commit>/
  snapshots/derived/<build-id>/
  reports/
```

二进制截图是否进入 Git 由实际体积和 LFS 策略决定；即使不入 Git，生成脚本、fixture、hash 和报告必须可复现。

## 5. 视觉判定

先做像素差异，再人工审核。不得用大范围遮罩让测试通过。

允许差异：

- Writing Agent 名称、Logo、About/帮助和合法来源声明；
- 已批准的非写作能力裁剪；
- HTML 禁脚本等安全收紧；
- 通过 Slot 加入的稿件、证据、版本和核查 UI；
- 明确列入 `UI_CHANGE_ALLOWLIST.md` 的稳定动态区域。

不允许差异：

- 混入旧 0.1.0 UI、全局 CSS 或 Tauri 页面；
- 未审核地改变主框架、字号层级、间距、侧栏/右栏行为；
- 隐藏关键内容、菜单不可达、输入/滚动/焦点退化；
- 用生成图片或手绘 mock 冒充源码运行截图。

像素阈值在取得第一批真实截图后按噪声测量固化，不能预先随意写一个宽松百分比。

## 6. 行为与可访问性

每个版本执行同一操作脚本并断言：

- Tab/Shift+Tab 焦点顺序、Esc 关闭、Enter/Space 激活、焦点可见；
- composer 中文输入、粘贴、换行、发送、停止和失败重试；
- 项目切换后旧请求/流不能写入新项目；
- 侧栏折叠、右栏拖宽/全屏、菜单和滚动位置行为；
- reconnect 只补读，不自动重复启动 run；
- prefers-reduced-motion、系统主题切换和 200% 文本缩放的基本可用性；
- 无未处理异常、React key/error、失败网络重试风暴。

## 7. Bridge 协议测试

确定性 mock 必须使用与正式 bridge 相同的类型和状态机，覆盖：

1. 初始完整 snapshot；
2. 连续 stream/event seq；
3. revision gap 后完整重取；
4. `run.cancel` 与取消后的迟到结果；
5. 断线/重连补读，不隐式 `resume`；
6. 两项目同时请求时的归属隔离；
7. client/bridge/runtime 协议版本不兼容时 fail closed；
8. mock 标识不进入正式构建，mock token/核查状态不写正式项目。

## 8. 安全和来源检查

- renderer 禁 Node 集成；桌面验证 `contextIsolation` 和受限 preload/IPC。
- Markdown/HTML/链接/图片使用不可信输入做 XSS、URL scheme 和外链测试。
- 文档预览路径必须由后端授权；浏览器不能提交任意绝对路径。
- 扫描官方 DeepSeek 更新、遥测、反馈、插件和账户端点；合法来源文本走精确允许清单。
- 扫描 `dsh` 进程执行、SDK/profile/server 依赖和 `$DSH_HOME` 读取。
- 检查每个复制文件在 `upstream-sources.json` 有 commit、原路径、hash 和许可。

## 9. 结果状态

每项只允许：

- `PASS`：命令/脚本实际运行且证据保存。
- `FAIL`：实际运行未达预期，记录差异和复现。
- `SKIPPED_ENV`：本机缺少明确环境，记录缺口。
- `BLOCKED_EXTERNAL`：需要外部服务/签名/账号等非本地条件。
- `NOT_RUN`：尚未执行，不能写成通过。

## 10. WA-023 开始前检查

- [x] 固定上游 commit 和来源 OID。
- [x] 明确前端、Host/API、类型、主题、品牌和 desktop 闭包。
- [x] 定义品牌、安全和能力裁剪边界。
- [x] 准备视觉、行为、bridge 和安全矩阵。
- [x] 安装上游固定依赖并记录锁文件校验。
- [x] 启动固定上游参考并生成首批真实证据。
- [x] 建立派生 mock UI 并生成同场景证据。

首批证据已由 WA-023 完成；WA-025 已以确定性 fixture、真实 Local Web Host、15 张截图和机器报告收口本地 Web 范围。尚未执行项及精确环境边界见 `UI_BASELINE_RESULTS.md`；desktop 部分转由 WA-017/018 验收。
