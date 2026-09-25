/** Author-facing Markdown deliverables. Structured evidence and fact ledgers are not public text streams. */
export const publicStageOutputLabels = {
  outline: '文章提纲', draft: '完整初稿',
  review_editor: '编辑审校', review_publish: '发布审校', review_reader: '读者审校',
  central_revision: '集中修订', language_review: '语言终审',
} as const;

export type PublicStageOutput = keyof typeof publicStageOutputLabels;
export function isPublicStageOutput(stage: unknown): stage is PublicStageOutput {
  return typeof stage === 'string' && Object.hasOwn(publicStageOutputLabels, stage);
}
