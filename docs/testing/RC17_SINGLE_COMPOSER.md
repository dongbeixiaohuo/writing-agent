# rc.17 单一主对话与标题确认衔接

日期：2026-09-21。范围：用户在 rc.16 拟题成功后回复“ok了”，仍无法理解下一步；不代表全产品最终验收。

## 现场证据与交互决定

只读核对原项目最近两次持久运行：`108ffebf-c667-479c-99d5-d32865c57e1e` 已保存三个标题；`b2dc9653-5b07-409a-8066-eac88e0a868b` 收到“ok了”，只执行 respond_author，没有 choose_publication，却重复了上一轮长篇候选解释。UI 又把 author-conversation 的 completed 当作完整写作未交付，显示“请处理核查问题”。不是 Key 或网络问题。

用户确认的原则：主对话是唯一日常输入入口。提纲、补充信息、审稿和标题确认以对话内强调文本展示，不再另放输入表单。可追溯/精细查看仍是次级入口。

实施：

- 删除检查点专用 textarea 和发送意见/补充并继续按钮。保留底部主输入框；外部结果未知时仍须显式点击确认重试，不能借普通聊天跳过安全确认。
- 检查点改为轻量左侧强调线，候选标题始终可见，理由和分发文案按需展开；明确说明如何回复和确认后的下一步。
- 多候选待选时，“ok了”等一般认可不代表选定某一个。保存简短追问，防止模型重复旧提案；不代选、不改正文。提示词强调回应本次消息，而非重做历史任务。
- 明确选择支持原有自然表达，并补充“2”“第二个”和完整候选标题。反对、带修改条件、疑问或越界序号仍不构成授权。
- author-conversation 显示“本轮交流已保存”；旧标题等待从持久事件投影为“等待你选择标题”，不再错误地提示补材料或处理核查问题。

## 验证

按 systematic-debugging / TDD 先复现再修改：额外 textarea、作者交流误报未交付、泛泛认可后重复旧提案、标题等待误报缺材料、直接序号无法选题的断言均先红后绿。frontend-design 用于减轻视觉层级而非另造界面；webapp-testing 用于真实 renderer 行为验收。

- UI 56、Bridge 47、Desktop 33 项通过。
- 作者交流、完整协作与标题选择专项共 48 项通过。
- runtime、Web、Desktop 类型检查通过；生产构建、13 文件分发边界通过。
- 最终构建 ASAR 与受测 TEMP 副本 hash 一致：`f6d67b6bfd8439cdfb8613eb84a6c5ad4ad691199cf0ab6ff36209fa203ad2d7`。

脚本 `tests/ux/rc17_single_composer.py` 复用只读 SQLite backup 初始化隔离 profile，保留真实旧会话、材料、运行和候选。使用打包后的 Electron，实际在唯一主输入框输入并按 Enter：重新拟三个 → ok了 → 就用第二个吧。未绕过 UI 发送函数。

最终证据：`output/rc17-single-composer/rc16-899b71e1-2bad-4f9b-bf0c-d3e26caf8aa2/`。目录 rc16 前缀仅因复用隔离初始化器，受测二进制为 rc.17。

- 三个候选可见、专用 textarea 为 0、主 composer 为 1。
- “ok了”的回复保存为简短选择追问，而非模拟模型返回的长篇重复内容。
- choose_publication 持久结果选定第二项“被需要，不等于有特权”；原运行恢复并执行独立 fact_check。
- 核查夹具故意返回 1 条阻断，真实状态保存为 blocked 并在主对话显示；没有用假的 passed 冒充验收。
- 正文版本全程不变；renderer 刷新后仍可交互。
- 最终这一轮 20 次 loopback 请求，真实模型 0 次、原项目写入 0。没有使用真实凭据。

测试过程的失败没有算作通过：初次从 OneDrive 构建目录启动时 CDP 连接消失，换为 hash 相同的 TEMP 二进制副本后可连接；模拟 Provider 初稿未遵守材料读取契约/必填参数，并错误依赖 OpenAI tool message 的 name 字段，随后修正测试夹具。初版等待条件还可能读取旧事件状态而提前停止，最终改为等待本轮真实 submit_fact_check 请求和持久 blocked 状态。所有失败报告保留。退出隔离应用时 loopback HTTP 空连接有 ConnectionReset 日志，未隐藏，非产品模型错误。

## 制品与边界

安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.17-x64.exe`，111448683 字节。

SHA-256：`04a9832d45ff7579f66df63a69bbb0b156585f21f3845d479ecf383ef4c139b1`。

未签名、未自动安装、未对外发布，旧安装包保留。用户可原地升级后在原会话继续选择；真实 MiniMax 对这轮新交互、原生升级及完整成稿质量仍须用户复测。WA-010 / `BLOCKED_CORE_WORKFLOW` 不因此改成完成。本轮主 Agent 实施，没有新子 Agent。
