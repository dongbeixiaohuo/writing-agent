/** Direction suggestions become author choices only when the author selects one. */
export interface IdeationReaction {
  readonly direction: string;
  readonly stance: 'interested' | 'rejected';
  readonly reason: string;
}
export interface ConversationIdeation {
  readonly directions: readonly string[];
  readonly reactions: readonly (IdeationReaction & { readonly sourceMaterialId: string })[];
}
export interface IdeationInput {
  readonly directions: readonly string[];
  readonly reactions: readonly IdeationReaction[];
}

export const IDEATION_TOOL_SCHEMA = {
  type: 'object', properties: {
    directions: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 },
      description: '方向未定时给3–5个彼此不同的简短切口。每项只写方向本身，程序编号展示；没有新方向用空数组，保留上一轮。' },
    reactions: { type: 'array', maxItems: 3, items: {
      type: 'object', properties: {
        direction: { type: 'string', minLength: 1, maxLength: 160 },
        stance: { type: 'string', enum: ['interested', 'rejected'] },
        reason: { type: 'string', maxLength: 160 },
      }, required: ['direction', 'stance', 'reason'], additionalProperties: false,
    }, description: '仅记录本轮作者明确表达的兴趣或否定；没有则空数组。来源由程序绑定，不把你的推荐写成作者选择。' },
  }, required: ['directions', 'reactions'], additionalProperties: false,
} as const;

export const INTAKE_IDEATION_GUIDANCE = [
  '启发式对话：先判断作者是在找选题、只有模糊感受、拿着素材找角度，还是卡在已有文章的一处。每轮先贡献一个观察、区分或可选切口，再接一个容易回答的问题；不是机械问卷，不规定聊几轮。不要只有欢迎、泛泛鼓励，或把“你想写什么”原样丢回去。',
  '作者还没定方向时，推演3–5个有实质差别、容易接话的具体切口，请作者选一个或提出自己的方向。不急着列发布标题或完整写作方案；没有背景就用不同类型的小线索，不假装了解作者职业、经历和偏好。再次说不知道时换成更具体的情境或选择，不重复问领域、读者和平台。',
  '已有模糊感受时，帮他分辨真正介意的点或矛盾；已有链接或素材时，先用已授权读取能力了解内容，再给有区别的角度，不假装读过。用户否定方向时接住理由并换不同切口，不要换个说法重复被否定的建议。不愿提供亲历也可以走观察、概念辨析或公开材料路线，不强迫自我披露。',
  '“你推荐/你定”先给一个推荐及简短理由；要求推荐不等于确认方案或授权开始写作。仅认可一个局部观察也不等于认可整套写法。已有明确线索并谈到足以形成方案时，直接整理待确认方向，未知项可标为建议，不无限追问；找线索、试角度不是每步都要确认，真正写作前才确认整体方案。',
  '普通启发默认不启动搜索，不自动委派选题专家或研究，不遍历其他项目；只有作者明确要求热点或系统策划、且当前确有相应工具与授权时才使用。没有联网结果就不声称找到热点，不输出虚构热度。',
  '给候选时把3–5个方向放入respond_writing_intake的ideation.directions，reply只写引导或简短推荐，程序会编号展示。作者可按编号或原话选定。ideation中的候选和反应不能作为授权；兴趣和否定在reactions中记录。没有新反应不重抄历史，普通澄清可省略ideation。',
].join('\n');

export const SCOPED_IDEATION_GUIDANCE = '作者只是卡在某段落、开头或结尾时，围绕当前正文与本轮问题给一两个具体选择，不重开选题、不要求重填需求；普通启发不自动委派或研究，不因讨论就改稿。沿用已确认方向，用户明确要换题时才讨论更换。';

export function selectedDirection(input: string, directions: readonly string[]): string | undefined {
  const text = input.trim().replace(/[。！!]+$/u, '');
  const exact = directions.find(direction => direction.replace(/[。！!]+$/u, '') === text);
  if (exact) return exact;
  const ordinal = /^(?:我选|选|用|就选|就用)?\s*(?:第\s*)?([1-5一二三四五])\s*(?:个|项|条)?\s*(?:吧|就好)?$/u.exec(text);
  if (!ordinal) return undefined;
  const index = '一二三四五'.includes(ordinal[1]!) ? '一二三四五'.indexOf(ordinal[1]!) : Number(ordinal[1]) - 1;
  return directions[index];
}

export function isDirectionAcknowledgment(input: string): boolean {
  return /^(?:继续|继续吧|认可|可以|好的|好|都可以|都行|ok)[。！!；;\s]*$/iu.test(input.trim());
}

export function mergeConversationIdeation(
  previous: ConversationIdeation | null | undefined,
  input: IdeationInput | undefined,
  sourceMaterialId: string,
): ConversationIdeation | null {
  if (!input) return previous ?? null;
  const directions = [...new Set(input.directions.map(value => value.trim()).filter(Boolean))];
  const reactions = [...previous?.reactions ?? []];
  for (const item of input.reactions) {
    const direction = item.direction.trim();
    if (!direction) continue;
    const index = reactions.findIndex(old => old.direction === direction);
    if (index !== -1) reactions.splice(index, 1);
    reactions.push({ direction, stance: item.stance, reason: item.reason.trim(), sourceMaterialId });
  }
  return { directions: directions.length ? directions : previous?.directions ?? [], reactions: reactions.slice(-6) };
}

/** Missing/invalid optional notes must not make a legacy project unreadable. */
export function readConversationIdeation(value: unknown, sourceIds: ReadonlySet<string>): ConversationIdeation | null {
  if (!value || typeof value !== 'object') return null;
  const { directions, reactions } = value as Partial<ConversationIdeation>;
  const short = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0 && text.length <= 160;
  if (!Array.isArray(directions) || directions.length > 5 || !directions.every(short) ||
      !Array.isArray(reactions) || reactions.length > 6 || !reactions.every(item => item && short(item.direction) &&
        ['interested', 'rejected'].includes(item.stance) && typeof item.reason === 'string' && item.reason.length <= 160 &&
        sourceIds.has(item.sourceMaterialId))) return null;
  return { directions, reactions };
}
