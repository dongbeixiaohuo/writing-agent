/** Public workflow command failures shared by desktop transport and conversation UI. */
export const WORKFLOW_COMMAND_MESSAGES: Readonly<Record<string, string>> = {
  CHECKPOINT_DECISION_REQUIRED: '请先回复当前共创节点；只有经过本轮对话确认后才会继续。',
  INTENT_CONTEXT_STALE: '等待确认的内容已变化，本次未继续。请查看最新回复后重新确认。',
  INTENT_CONTEXT_INVALID: '当前没有对应的待确认阶段，请查看最新进度后继续交流。',
  RUN_NOT_RECOVERABLE: '这个等待项已处理或已失效，未重复执行。请查看最新进度。',
  RUN_NOT_RESUMABLE: '这一步当前不能恢复，请查看最新进度；已保存的内容仍在。',
  RUN_SCOPE_INVALID: '这项任务不属于当前项目或对话，请返回对应对话后重试。',
  FACT_INPUTS_INCOMPLETE: '事实核查所需的当前正文或证据台账尚未保存，请先完成写作再核查。',
  HANDOFF_CONTEXT_CHANGED: '确认后稿件或方向发生了变化。请核对当前版本，再在主对话中告诉我如何继续。',
  CONVERSATION_HANDOFF_FAILED: '你的确认已保存，但下一步未能启动。请查看主对话中的原因；无需重新填写材料。',
  PUBLICATION_SELECTION_REQUIRED: '还需要确认当前稿件使用的标题，可以直接在主对话中选择或讨论。',
};
