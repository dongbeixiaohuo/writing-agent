# WA-024 本地实施与验收结果

日期：2026-09-17  
状态：`COMPLETE_LOCAL`  
任务：集中管理品牌主题并建立写作 Slot 扩展边界

## 1. 交付结果

- 新增集中品牌、主题和布局配置；默认界面继续沿用既有 DSH token、三列布局和基础控件，没有重设计。
- 新增静态 Writing UI registry，支持 `conversation.actions`、`sidebar.primary` 和 `right-panel`；重复 ID 与悬空 panel 引用在 composition 阶段失败。
- 将稿件/差异/版本/核查/交付实现从基础 shell 迁入 `packages/writing-ui/`。基础 shell 只托管 Slot，不计算事实门禁或修改领域状态。
- 面板以 `panelId:projectId` 作为实例 key；项目切换会清除页签、编辑输入和错误等局部状态。registry 的挂载/卸载返回隔离快照，不污染默认注册表。
- Client Bridge 升至 v6。production 的明暗/系统主题与字号经受保护 Local Web Host 写入 workspace 的 `.writing-agent/ui-settings.json`，原子替换并在 bridge 重开后恢复；Mock 不写真实设置。
- 新增独立 `extension-demo`：替换品牌、覆盖主题别名、增加只读演示侧栏；正式入口不 import 示例，production bundle 自动检查不含演示 ID/文案。
- 新增扩展指南：`docs/implementation/UI_EXTENSION_GUIDE.md`。

## 2. 自动与浏览器验证

| 范围 | 证据 | 结果 |
|---|---|---|
| 主题/品牌 | 默认不变、局部覆盖、空品牌拒绝、token/布局集中入口 | PASS |
| Registry | 默认工作台、注册/撤销不可变、顺序、重复 ID、悬空 panel、project key | PASS |
| 设置持久化 | Application bridge 重开、真实 Web Remote 重连、默认恢复、损坏文件拒绝、原子替换 | PASS |
| Slot 隔离 | 工作台迁出基础 shell；演示不进默认 registry；writing-ui 只消费 bridge | PASS |
| 三种构建 | production、mock、extension-demo；production 不含 mock/演示/legacy/外部 DSH 标识 | PASS |
| Chromium | 1440×900；品牌/主题覆盖、演示面板挂载/关闭、默认工作台、核查页签、跨项目重挂载；console/page error 为 0 | PASS_LOCAL |

实际截图：`output/wa024-ui-extension-demo.png`。可复现脚本：`tests/wa024_ui_playwright.py`。

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-33 | `PASS_WA024_SCOPE` | 默认工作台通过 registry 挂载；浏览器打开稿件/差异/核查入口，切换 `project-launch`→`project-case` 后页签复位且空项目不继承正文；关闭/卸载不破坏对话和导航 |
| AT-34 | `PASS` | 品牌、主题、布局、Slot 均有集中入口；主题模式/字号可恢复默认且跨真实 Web bridge 持久化；演示侧栏只在独立 demo composition，不进入正式清单或 bundle |
| AT-36 | `PASS_CURRENT_WEB_SCOPE` | renderer/production bundle 无上游遥测、更新、账户提交、远端插件或 Provider 直连；设置文件使用 Writing Agent workspace 路径且不含 Key；Web 复验已由 WA-025 完成，Desktop appId/数据目录仍待 WA-017/018 |

## 4. 验证命令

```powershell
npm run check:ui
npm run check:runtime
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B tests/check_document_pack.py
python "$env:USERPROFILE\.agents\skills\webapp-testing\scripts\with_server.py" --server "npm run ui:dev:extension-demo" --port 4174 -- python tests/wa024_ui_playwright.py
git diff --check
```

最终结果：Node 24.18.0 下 UI/registry 16/16；Bridge/Host/设置文件 12/12；UI/来源 Python 10/10；runtime 130/130；M0 Python 12/12；legacy 共运行 235 项，其中 234 通过、1 条既有条件跳过；production dependency audit 0 vulnerabilities；需求包 25 个任务、38 个验收场景一致性检查 PASS。独立 Chromium 脚本通过且 console/page error 为 0。没有删除、跳过或改写失败测试来获得通过。

## 5. 未宣称内容

- 没有创建在线插件/主题市场、动态第三方加载或正式“编辑备注”功能。
- 没有改变 agent loop、Provider、事实门禁或数据库领域 schema；UI 设置文件不是业务状态来源。
- 没有调用真实 Provider、付费模型或外部 DSH 服务。
- WA-025 的同夹具视觉阈值、完整明暗/视口矩阵和 bridge 一致性总验收尚未执行。
- Electron appId、桌面数据目录、preload、安装包及干净 Windows 仍由 WA-017/018/025 验收。
- 未执行 commit、push、PR、Release 或生产部署。
