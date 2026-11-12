export const FINDINGS_SUBMISSION = [
  '完成审读后，仅以一个完整 JSON 对象回复，包含 content 和 findings，不加代码围栏或对象外的文字。按 reviewOutputSchema 输出，程序会校验并保存。content 是给作者看的实际审稿意见；findings 是内部逐项记录，不在 content 展示字段或编号。',
  '每个确实需要处理的问题记录原稿连续原句 quote、kind、severity、issue、repairTarget 和 evidenceIds；无可读证据编号就用空数组。required 只用于影响可信度或交付的实质问题，风格偏好用 suggestion，无问题就 findings=[]，不凑数。',
  'repairTarget 写修好后的可检查状态，不预写文章，也不让主笔靠添加“这是推演/尚未核实”等解释标签保留原来的错误判断。',
].join('\n');

export const RESOLUTION_SUBMISSION = [
  '逐项处理 reviewClosure.findings。对照实际来源修正归属、测量对象和判断范围；不能靠加免责声明保留原来的过度断言，也不能把审校过程写进正文。作者的立场和有辨识度的表达应保留，立场本身不是外部事实的证明。',
  '用 submit_writing_stage 一次提交完整 content 和 resolutions。每个 findingId 恰有一条：rewrite 给出新稿实际引句 afterQuote，remove 将 afterQuote 设为 null，retain 给出原句及有根据的保留理由。处置理由只写在 resolutions。审校也可能判断错，可说明不采纳依据，不为凑修改扭曲作者意思。',
  '若有上次终审的返工问题，一并处理；先让问题在正文里真正消失，再检查句子是否顺畅。',
].join('\n');

export const FINAL_REVISION_AUDIT = [
  '你是独立语言终审，任务是验收当前文章能否交付。先通读当前修订稿，以原始引文、sourceSlices原文切片和作者原话核对，再对照旧问题索引；它只给定位，不提供审校的改写答案。审校可能误读作者，不因一句话被标记为required就认定它错了，不以换词或增加限定语认定已修好。',
  '逐项检查归属是否仍指错机构或调查，实验测量的对象是否被换掉，单次比例是否仍被写成变化趋势，例子与结论是否讨论同一种事物。来源引文是材料，来源适用范围是整理者解释，不能代替引文本身。作者评论和合理修辞不必伪装成研究结论，也不因没有数据就一律删除。',
  '阅读整篇修订稿，寻找修订新增的同类错误，以及写作步骤、真假标签、修改说明等工作备注。用自然的文章语言保留必要归属、条件和不确定性；不要把“这是我的判断”“只是假设”这类解释标签当作修好推理的证据。不要磨平具体观察、语气和作者立场，不要求每篇具备故事或固定结构。',
  '先将通读当前文章发现的实质残留问题放入 audit.newFindings；必改才用 required，可选偏好不阻断。再在 audit.checks 对 reviewClosure.findings 的每个 findingId 给出 resolved、unresolved 或 not_applicable，引用拟交正文真实连续原句并说明判断；确已删去的问题可 quote=null。若审校本身不成立，用 not_applicable 并给依据，不强迫作者换掉自己的立场。',
  '存在必须返工的问题时，content 只写“需要修订”，无需重抄全文；所有引句必须来自绑定的当前修订稿，问题与修复目标写在 audit。程序只保存问题并交回原主笔，保留当前正文，不把这次 content 当成文章。这种返回无需 comparison，不要求作者替 Agent 修错。',
  '没有必改问题时，可作有收益的最小语言修整并清理工作备注，保留事实和标题；content 是完整可交付正文。audit 的引句必须来自这份实际 content。另提交 comparison 对比初稿与修订稿的真实得失，不把添加解释标签或表面降语气自动算作收益。所有内部判断只放在 audit/comparison，绝不出现在正文。',
  '只调用 submit_writing_stage，stage=language_review。语义核对仍不替代后续独立事实核查。',
].join('\n');
