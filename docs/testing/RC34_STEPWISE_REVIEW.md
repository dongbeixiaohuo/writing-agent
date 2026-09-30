# rc.34：逐位审校交接

## 根因与改动

用户附件依次包含编辑/发布/读者审校长文，只在末尾确认。`workflow-tools.ts` 的共创检查点原为 outline、draft、review_reader，编辑及发布审校成功后会继续调度。现补齐这两个程序暂停点；普通明确认可交接一次，异议和混合取舍由当前专家继续交流，应用 resume 层也拒绝未确认交接。没有靠模型自己决定是否暂停。

当前专家讨论绑定本轮审校成果、正文和公开讨论，不授予正文写入或其他专家调度工具。后续集中修订显式得到作者公开意见，不能只按旧审校报告覆盖作者的保留/拒绝。共创与自主推进模式、三类初审同稿独立、事实门禁和版本保护保持不变。审校讨论本身不声称已经改写正文。

UI 用消息的程序绑定 stage 显示专家徽标、名称、职责；流式预览和已保存结果均可识别。仍然只有主对话输入框。审校输出要求先结论，再重点问题/可选优化/保留，优先最多三个讨论点；真正重要风险不得为了简短省略。通用交接提问由程序在末尾加上，去除已知重复的通用“要不要进入下一位？”尾句，不删实质意见或问题。

真实验证还发现：审校讨论普通回复不调用 respond_author 会反复空转。限定这条只读讨论使用已有 textOutputTool：模型普通文本流结束，程序原文保存再追加交接提问；不增加上限、不增加第二次序列化请求，不改变标题/正文修改等有业务副作用的普通 author 流程。

## 验证与失败记录

- 红测明确复现编辑后直接到读者、消息无 stage 身份；另红测复现只回复普通文本时 budget_exhausted，以及重复交接问句。日志：output/stepwise-red.log、stepwise-author-red.log、stepwise-plain-red.log、stepwise-footer-red.log。
- 128 项相关应用/Bridge/对话回归通过：output/stepwise-regression-final.log。最后仅补通用交接尾句去重，作者交流全套 27 项再次通过：output/stepwise-author-final.log。
- UI 66、Desktop 33、runtime/desktop TypeScript、分发 13 文件检查通过：output/stepwise-ui.log、stepwise-tsc-final.log、rc34-desktop-accepted.log。
- 既有恢复/标题测试按新检查点增加一次确认及两次绑定产物恢复读；没有放宽越阶段或事实断言。旧原生准备脚本仍模拟保存工具，更新为 rc.33 普通文本契约后通过。
- 隔离 MiniMax：准备阶段和导演使用确定性 fixture，真实编辑/讨论/发布请求实际联网；不是全流程全真实导演验收。首次 4 请求技术通过但出现重复确认，保留在 output/stepwise/real-first-quality-issue.json；第二次 10 请求暴露讨论保存空转，保留 real-save-loop-failure.json（测试自身上限终止，不据此归因供应商超时）；初次预检 capabilities wrapper 配置失败、未发请求，保留 real-preflight-failure.json。
- 修复后最终真实请求 3 次：编辑审校 1、当前专家讨论 1、发布审校 1；逐位暂停、无读者自动运行、正文不变，见 output/stepwise/real-result.json。讨论仍有模型措辞波动，不用单例证明所有语言质量问题消失。
- 最终构建原生测试（Python Playwright + 本地 Anthropic SSE）通过：编辑首段160字逐步增长，保存后不启动发布；异议仍由编辑回复；ok 后发布、再次等待；刷新状态保留，只有一个输入框，专家名可见，正文未变。证据：output/stepwise/native/plain-rc16-7c6148c5-7380-4bc7-9720-1480359ce08e。source DB 仅只读抽取历史回放文字，无原项目写入、无真实模型请求。

## 安装包与边界

交付：output/desktop/Writing-Agent-Setup-1.0.0-rc.34-x64.exe。由 output/desktop/.rc34-accepted 构建生成，实际 EXE 及 asar 均核实 1.0.0-rc.34；111,466,922 字节；SHA256：E4A086D626BAAC03E3B063F8230632DD0AD0CBDF18E22040B135B3109DADEC89。早期内部打包目录不是最终交付文件。

未自动安装、未执行原生升级、未修改作者原项目。已生成的历史报告不删除或重跑；新执行到的审校按新规则暂停。此变更聚焦逐位审校，不将内部研究读取等每个工具调用变成人工确认，不更改整体最终验收状态。
