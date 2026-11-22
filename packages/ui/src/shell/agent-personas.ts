export const agentPersonas = {
  assistant: '写作助手汤大姆',
  director: '写作导演托尼老师',
  research: '资料员包打听',
  outline: '提纲师段小纲',
  writer: '主笔周一稿',
  editor: '编辑挑刺姐',
  publisher: '发布编辑陆把关',
  readers: '模拟读者三人组',
  'final-review': '终审林顺句',
  title: '标题策划何起名',
  'fact-check': '核查员查有据',
  style: '风格分析员苏小样',
} as const

export type AgentPersona = keyof typeof agentPersonas

const actorPersonas: Readonly<Record<string, AgentPersona>> = {
  intake: 'assistant', author: 'assistant', '需求澄清助手': 'assistant', '写作助手': 'assistant',
  director: 'director', '写作导演': 'director',
  research: 'research', researcher: 'research', '资料研究': 'research',
  outline: 'outline', planner: 'outline', '选题策划': 'outline',
  draft: 'writer', writer: 'writer', central_revision: 'writer', '内容主笔': 'writer', '修订主笔': 'writer',
  review_editor: 'editor', editor: 'editor', '编辑审校': 'editor',
  review_publish: 'publisher', publisher: 'publisher', '发布审校': 'publisher',
  review_reader: 'readers', reader: 'readers', '模拟读者': 'readers',
  language_review: 'final-review', language_reviewer: 'final-review', '语言终审': 'final-review',
  title: 'title', '标题策划': 'title',
  fact_check: 'fact-check', fact_extract: 'fact-check', fact_checker: 'fact-check',
  '事实核查': 'fact-check', '提取待查事实': 'fact-check',
  style_modeler: 'style', '风格分析': 'style',
}

export function personaForActor(actor: string | null | undefined): AgentPersona | undefined {
  if (!actor) return undefined
  if (/^review_reader_[abc]$/u.test(actor) || actor.startsWith('模拟读者 ')) return 'readers'
  return Object.hasOwn(actorPersonas, actor) ? actorPersonas[actor] : undefined
}
