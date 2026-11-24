export const MODEL_GROUPS = [
  { id: 'writing', label: '进阶', roles: [
    ['汤大姆', '写作助手，聊选题、理需求'],
    ['托尼老师', '写作导演，安排下一步'],
    ['周一稿', '主笔，写初稿和集中改稿'],
    ['何起名', '标题策划，拟标题'],
    ['苏小样', '风格分析，提取写作风格'],
  ],
    advice: '优先考虑理解意图、细致推理和中文表达。' },
  { id: 'planning', label: '均衡', roles: [
    ['段小纲', '提纲师，安排文章结构'],
    ['挑刺姐', '编辑审稿，找论点和阅读问题'],
    ['陆把关', '发布审校，检查发布风险'],
    ['林顺句', '终审，复核修订和语言衔接'],
    ['模拟读者三人组', '试读，反馈哪里好读、哪里卡住'],
  ],
    advice: '优先考虑判断准确、输出稳定和耗时。' },
  { id: 'review', label: '轻量', roles: [
    ['包打听', '资料员，查找和整理素材'],
    ['查有据', '核查员，提取和核对事实'],
    ['配图策划', '建议配图的位置和画面'],
  ],
    advice: '优先考虑响应快、工具调用稳定。' },
] as const;

export type ModelGroup = typeof MODEL_GROUPS[number]['id'];
export interface GroupModelSelection { readonly profileId: string; readonly model: string }
export type ModelGroupSelections = Readonly<Record<ModelGroup, GroupModelSelection | null>>;
export const DEFAULT_MODEL_GROUPS: ModelGroupSelections = { planning: null, writing: null, review: null };

const planning = new Set(['outline', 'review_editor', 'review_publish', 'language_review', 'review_reader', 'review_reader_a', 'review_reader_b', 'review_reader_c', 'retrospective']);
const review = new Set(['research', 'fact_extract', 'fact_check', 'illustrator', 'memory']);
/** Intake, author conversation, director and writing share the advanced tier. */
export function modelGroupForActor(actor?: string): ModelGroup {
  return planning.has(actor ?? '') ? 'planning' : review.has(actor ?? '') ? 'review' : 'writing';
}
