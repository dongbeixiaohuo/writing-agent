# rc.28 阶段确认回归主对话

## 用户问题与改动

提纲已在主对话完整展示，后面的“共创决策 → 本阶段成果”又复制一次，并带来嵌套滚动区。确认应是对话的下一句话，而不是另一份成果视图。

- 提纲、初稿、读者审校的正常共创确认，分别在对应已保存成果末尾追加一句加粗的自然提问，说明确认后的下一步。
- 删除普通共创决策卡片和重复成果预览；保留单一主输入框。仅保留轻量“结束本轮”，稿件查询仍在右上角“稿件与版本”。
- 删除多余的“等待你的确认 · 阶段已保存”状态行，避免与末尾提问重复。
- 投影绑定同 run、同 stage 的最新已保存消息，稳定复用 rc.27 的预览标识；不写回原稿件，不修改确认门禁、事实核查或模型调用。
- 旧记录也在读取时生效；没有可投影成果的旧检查点只显示问题，不伪造或复制别的阶段正文。连接失败、缺材料和标题候选等具有实际操作意义的提示保留。

## 测试

使用 test-driven-development、frontend-design、webapp-testing、verification-before-completion。设计约束是已有成果末尾提问，不再新增独立内容框。未委派子 Agent，未调用商业模型。

- 新应用测试：提纲 → 初稿 → 审校三个检查点都只在对应成果末尾提问一次，重复 refresh 不累积。先红后绿。
- 新 Bridge 测试：历史无可展示产物时仍有可理解的问题，没有虚假“已保存”或重复状态。先红后绿。
- SSR 检查普通共创没有决策卡片、成果副本或第二输入框，仍可结束本轮；标题选择与超时重试入口保留。
- Bridge 60、Conversation 58、UI 61、协作流程 25、Desktop 33 通过；Runtime/Web/Desktop 类型检查、生产构建与桌面分发边界通过。
- rc.27 已打包原生程序运行新断言失败，确认实际存在多余“共创决策” region，证据在 `output/rc27-expert-streaming/content_first-rc16-16a3e2c6-b412-41dd-b44f-fd08dfb31070/`。
- 新版原生回放复用 `tests/ux/rc27_expert_streaming.py --inline-confirmation`，采用真实历史提纲内容和本机 Anthropic SSE，写入全新 TEMP 工作区。原用户 DB 只读，不使用真实 Key。

## 范围

本轮是展示层优化，不重新生成用户稿件，不自动确认，不扩大成其他流程重构。整体 BLOCKED_CORE_WORKFLOW 与 WA-010 IN_PROGRESS 不变；不能据此宣称最终用户验收已完成。

## 原生与交付结果

- `output/rc28-inline-confirmation/content_first-rc16-ec4dad45-8bd9-4275-b951-0ad0ffd47341/result.json`：PASS。真实历史提纲 content-first 流式回放，保存后同一 DOM 节点；没有“共创决策”“本阶段成果”重复区域，末尾问题只出现一次，主输入框可编辑，未自动写初稿。
- 页面重载并重新选择原会话后仍无重复、不增加模型请求；主动上翻保持位置。已人工查看 saved.png 与 reopened.png。
- 回放使用本机 SSE，真实模型调用 0、原项目写入 0。仅退出测试进程，没有关闭用户正式应用。
- 安装包 `output/desktop/Writing-Agent-Setup-1.0.0-rc.28-x64.exe`，111460631 字节。SHA256 `fc35d439ccb17fb452e3024a9f65e9ed45a3afd4bbf5cb2d1af87883aaa5f8e6`。
- app.asar 的构建文件与实际测试副本 SHA256 一致：`079944216dbaf5ed773b4e3f5c350f799d0a8759ac60924ac49f6ccfc5e6abc4`。分发边界 13 文件检查通过，SHA256SUMS 已更新。
- 未自动安装、修改原项目、提交/推送或公开发布。
