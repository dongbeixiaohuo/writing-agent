/** Display metadata only. Execution schemas and permissions remain in ToolDefinition. */
export const TOOL_PRESENTATION: Readonly<Record<string, { label: string; description: string; category: string }>> = Object.fromEntries([
  ['search_fact_sources', '搜索事实来源', '联网检索', '按搜索设置检索公开事实；返回来源和摘录供核查专家判断，不代表事实已经通过验证。'],
  ['read_material', '读取参考材料', '读取', '按授权读取指定材料版本，供当前 Agent 分析；不修改材料。'],
  ['read_artifact_version', '读取历史版本', '读取', '读取已保存的稿件或阶段成果；不改变当前稿件。'],
  ['list_project_materials', '整理参考材料', '读取', '列出项目材料目录，供 Agent 选择需要读取的材料。'],
  ['assess_writing_readiness', '检查写作信息', '检查', '检查当前任务的信息是否充分；发现必要缺口时暂停并请求补充。'],
  ['director_decide', '导演调度', '调度', '记录导演的分派、追问、返工或结束决定；调度本身不等于专家已完成任务。'],
  ['submit_writing_stage', '保存写作阶段', '保存', '校验并保存当前专家的阶段成果；不代表整篇文章已通过核查。'],
  ['submit_fact_check', '提交事实核查', '保存', '保存绑定指定稿件版本的核查结论；提交成功不等于核查通过。'],
  ['read_fact_source', '阅读事实来源原文', '联网读取', '读取证据账本或本轮搜索返回的来源 URL，核对原文；不接受任意链接，不修改稿件。'],
  ['submit_publication_candidates', '保存发布标题候选', '保存', '保存标题专家提出的候选，等待用户选择；不代替用户确认。'],
  ['respond_writing_intake', '保存需求交流', '保存', '保存本轮回复、需求摘要和待回答问题，以及可选的待确认方案或确认结果；不生成正文。'],
  ['respond_author', '保存作者交流', '保存', '保存本轮讨论或专家回复；不直接覆盖正文。'],
  ['interpret_author_reply', '理解本轮意图', '语义判断', '结合当前待确认成果与最近对话，判断认可、修改、选择或继续讨论；记录绑定阶段及版本的决策，不按固定口令匹配。'],
  ['resume_author_checkpoint', '继续已确认阶段', '流程请求', '依据本轮语义决策恢复同一个写作流程；不重跑已保存阶段，也不代表下一阶段已完成。'],
  ['delegate_author_expert', '委派写作专家', '调度', '把当前任务交给独立上下文的专家；委派成功不等于专家已完成。'],
  ['read_conversation_history', '读取对话历史', '读取', '读取当前会话已保存的历史交流，帮助理解上下文。'],
  ['attach_author_material', '添加写作材料', '保存', '将用户本轮提供的材料加入项目；不自动认定材料真实或授予新权限。'],
  ['propose_author_revision', '保存局部修改提案', '保存', '保存可供用户预览、接受的局部改稿建议；尚不覆盖当前正文。'],
  ['propose_publication_choices', '保存标题与发布候选', '保存', '保存标题及发布文案候选，供用户比较和选择。'],
  ['choose_publication', '保存发布方案选择', '保存', '记录用户明确选择的标题与发布方案；不会自动对外发布。'],
  ['request_author_fact_check', '请求事实核查', '流程请求', '保存已授权的核查请求并交接核查流程；请求成功不等于核查通过。'],
  ['request_author_full_writing', '请求完整写作', '流程请求', '保存已授权的写作请求并交接写作流程；请求成功不等于文章完成。'],
  ['read_author_web', '读取授权网页', '联网读取', '读取用户本轮明确授权的网页作为材料；不是开放式全网搜索。'],
  ['read_legacy_style', '读取写作风格档案', '读取', '列出风格档案或读取选定的风格参考；不代表已将该风格用于正文。'],
  ['read_style_methodology', '读取风格分析方法', '读取', '读取风格建模方法，供专家分析已授权样本。'],
  ['save_author_preference', '保存写作偏好', '保存', '按用户明确的记住或忘记指令更新写作偏好，不自动记住一般反馈。'],
  ['propose_illustration_plan', '保存配图策划', '保存', '保存配图位置、用途和画面建议，等待确认；不会生成图片或调用付费图片服务。'],
  ['confirm_illustration_plan', '保存配图策划确认', '保存', '记录用户对配图策划的明确确认；不生成图片。'],
].map(([name, label, category, description]) => [name, { label, category, description }]));

const ACTORS: Readonly<Record<string, string>> = {
  intake: '需求澄清助手', director: '写作导演', researcher: '资料研究', research: '资料研究',
  planner: '选题策划', outline: '选题策划', writer: '内容主笔', draft: '内容主笔', central_revision: '修订主笔',
  editor: '编辑审校', review_editor: '编辑审校', publisher: '发布审校', review_publish: '发布审校',
  reader: '读者审校', review_reader: '读者审校', language_reviewer: '语言终审', language_review: '语言终审',
  fact_checker: '事实核查', fact_check: '事实核查', title: '标题策划', opening: '开头策划',
  topic_generator: '选题建议', topic_research: '选题研究', position: '立场分析', concretizer: '细节具象化',
  empathy: '共情审视', style_modeler: '风格分析', illustrator: '配图策划', memory: '偏好整理', retrospective: '写作复盘',
};

export function recordedActorLabel(actor: unknown): string | null {
  return typeof actor === 'string' && Object.hasOwn(ACTORS, actor) ? ACTORS[actor]! : null;
}

export function toolPresentation(name: string) {
  return Object.hasOwn(TOOL_PRESENTATION, name) ? TOOL_PRESENTATION[name]! : {
    label: '未登记的工具', category: '用途未登记', description: '此版本尚未登记该工具的用途，请结合技术名称和执行状态核对。',
  };
}
