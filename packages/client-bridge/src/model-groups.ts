export const MODEL_GROUPS = [
  { id: 'planning', label: '策划与统筹', roles: '写作助手、选题、导演、提纲',
    advice: '建议选择理解意图、分析和规划能力较强的模型，帮助把握文章方向。' },
  { id: 'writing', label: '写作与表达', roles: '主笔、修订、润色、标题、风格提取',
    advice: '建议选择中文写作和风格表现较好的模型，让初稿到润色保持一致。' },
  { id: 'review', label: '审校与辅助', roles: '资料整理、审稿、模拟读者、事实核查、配图策划',
    advice: '建议选择阅读准确、响应稳定的模型；可优先兼顾速度和成本。' },
] as const;

export type ModelGroup = typeof MODEL_GROUPS[number]['id'];
export interface GroupModelSelection { readonly profileId: string; readonly model: string }
export type ModelGroupSelections = Readonly<Record<ModelGroup, GroupModelSelection | null>>;
export const DEFAULT_MODEL_GROUPS: ModelGroupSelections = { planning: null, writing: null, review: null };

const writing = new Set(['draft', 'central_revision', 'language_review', 'title', 'opening', 'style_modeler', 'style_analysis', 'concretizer', 'empathy']);
const review = new Set(['research', 'review_editor', 'review_publish', 'review_reader', 'review_reader_a', 'review_reader_b', 'review_reader_c', 'fact_check', 'illustrator', 'memory', 'retrospective']);
/** Intake, director, topic/position work and fact extraction use planning. */
export function modelGroupForActor(actor?: string): ModelGroup {
  return writing.has(actor ?? '') ? 'writing' : review.has(actor ?? '') ? 'review' : 'planning';
}
