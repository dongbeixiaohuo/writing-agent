export function styleAnalysisResponse(sampleId = 'a', paragraphIds = ['p1:0.0']) {
  return { version: 3, summary: '从人的具体动作进入，沿动作追问其代价，不先概括主题。',
    patterns: [{ kind: 'structure', name: '从动作推到代价', instruction: '先呈现一个可辨认的选择，再顺着选择推到被忽略的代价。判断从前面的动作中长出来。',
      whenToUse: '主题涉及一个人反复做却未必认同的选择时。', avoid: '不要给所有人物强加隐秘动机；材料不足时保留疑问。' }],
    snippets: [{ sampleId, paragraphIds, kind: 'structure', explanation: '先交代眼前的变化，随后让动作带出情绪，没有用抽象词替代观察。',
      application: '换成新题中有依据的动作，保留观察到解释的顺序，不沿用原文人物或物件。' }],
    contrasts: [{ kind: 'structure', plain: '他想休息，却仍有很多安排。', styled: '日历上写的是休息，每个小时却都有人等着他。', explanation: '保持同一矛盾，用日历与等待让抽象安排变得可见；这是创作示范。' }],
    notes: ['样本中的具体主题不能代表作者面对所有话题的立场。'] };
}
