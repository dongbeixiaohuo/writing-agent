# rc.20 流式回复、输入焦点与项目导航

日期：2026-09-22。范围仅为本次用户报告的流式显示、发送焦点、项目入口与方向总结可读性；整体 `BLOCKED_CORE_WORKFLOW`、WA-010 `IN_PROGRESS` 不变。

## 原因与实现

- Adapter 已提供增量事件，但 Runtime 原来收集完整回复才交给 UI；用户回复又主要位于写作工具的 JSON 参数中。现将允许显示的顶层 `reply` 以及提纲/正文阶段 `content` 增量接到 Application 内存预览，经现有 Bridge snapshot 推到桌面。不是完整结果到达后的打字动画。
- 临时回复标明“正在生成 · 尚未保存”，不持久化为成果、不影响事实门禁。重试更换 request、结束、失败、取消均清除；不展示研究 JSON、内部导演指令或任意工具字段。Unicode/转义跨片段经过测试，显示长度有上限。
- 生成期间输入框保持可编辑，可预写下一句话，但不会重复发起运行。发送后保留焦点；首页切换至会话会交接草稿；用户主动把焦点移到其他位置时不抢回。额外红测发现父级清空 handoff 会擦掉预写文本，已改为挂载时一次性初始化 DOM。
- 左上固定“新建项目”；每个项目行最右有带项目作用域的新建对话按钮，删除按钮紧邻项目名。项目内新建对话不创建另一个项目。
- 写作方向按“写作方向 / 篇幅与写法 / 配合方式与材料边界 / 建议或暂定项”分组并渲染 Markdown。已确认内容与建议仍区分；内部枚举、字段名和来源消息序号不再拼接到总结。历史单段总结在读取投影时格式化，不重写原项目。模型提示词同步要求中文分段，工程层格式化作为补充约束。
- 首个可展示内容到达前仍需等待模型；供应商不增量返回或先生成内部字段时，不能保证立即见字。预览不等于格式校验或保存成功。

## 验证

使用 systematic-debugging、frontend-design、TDD、webapp-testing 与 verification-before-completion。一个独立子任务由 `gpt-5.6-sol / medium` 处理输入焦点和导航，范围清晰且可独立验收；主 Agent 处理增量链路、总结、整合与实际桌面验证。未估算 token 或费用。

- Runtime 188、Conversation 50、UI 59、Bridge 50、Desktop 33 项通过；runtime/Web/Desktop 类型检查、协议声明生成、生产构建及 13 文件桌面分发边界通过。
- 集成测试故意暂停模型增量生成，确认 Bridge 可见未提交片段、持久 Timeline 无半截回复；取消及失败后清理、重试隔离、项目会话隔离通过。旧总结格式化后 project revision 不变。
- `tests/ux/rc20_composer_navigation_uat.py` 的隔离 mock 红绿回归通过，含非空首页草稿交接、运行中预写、主动移走焦点不被抢回、项目导航。证据：`.tmp/rc20-green/rc20-composer-navigation.json`。
- `tests/ux/rc20_streaming_interaction.py` 对打包 Electron 做真实点击：1344×866、900×650 下，在本地 SSE 服务仍停住未结束时看见半句；焦点与预写保留，生成中 Enter 不重复发起请求，结束后完整回复与分组总结可见；项目内新建对话保持 project 不变、session 改变。全部通过。
- 桌面证据：`output/rc20-streaming-interaction/rc16-82783213-d5d4-4c0d-9f86-c012c5c12a0f/`。rc16 前缀来自复用隔离初始化器，不是受测版本。本地首次可见分别 1.203 / 0.562 秒，仅代表本地夹具，不能作为真实模型延迟指标。
- 4 次 localhost SSE 请求，真实模型 0 次，原项目写入 0。SQLite 只读备份到隔离目录，测试配置无真实 Key。关闭自有测试程序后本地 HTTP 服务记录一次连接重置，无断言失败，不是运行中模型错误。未关闭用户正在使用的程序。

## 交付与待验证边界

- `output/desktop/Writing-Agent-Setup-1.0.0-rc.20-x64.exe`，111451962 字节。
- SHA-256：`aac17f7c3cef564810cff432dbabe514d9369756f36a1b703115cb9ead1462a3`。
- 实测程序 ASAR 与构建副本一致：`829cd2b72ea4ec43c73163cddfbf14905a9b8dc8779b62129e6b824108ac154f`。
- unsigned NSIS，未自动安装、未公开发布，旧安装包保留。真实 MiniMax 增量节奏、原会话现场和原生升级需用户安装复测；本轮不宣称完整写作质量或最终用户验收通过。
