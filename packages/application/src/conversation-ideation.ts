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
      description: '方向未定时给3–5个不同切口。每项用一句完整的话写出具体处境和要追问的问题，优先写看得见的反差，不用空泛标签或把推测写成结论。已有具体主题时，所有切口都留在同一主题内。程序按原文编号展示；没有新方向用空数组，保留上一轮。' },
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
  '启发式对话：先判断作者是在找选题、只有模糊感受、拿着素材找角度，还是卡在已有文章的一处。每轮先给一个作者能点头、补充或反驳的具体观察、区分或切口，再接一个容易回答的问题。不要只有欢迎、泛泛鼓励、固定问卷，或把“你想写什么”原样丢回去。',
  '作者已有具体主题但还没选切口时，给3–5个同一主题内真正回答不同问题的方向。例如从当场的处境、背后的利益、落地时卡在哪一步或当事人能怎么做来拆。不得把别的行业或场景引进列表来凑差异。不急着拟发布标题或完整写作方案。',
  '每个切口用一句完整的话写出能看见的处境和想追问的问题，尽量保留现场的反差或日常荒诞感。围绕人物的动作、选择或受到的对待发问，用读者在现场会说的话。未证实的动机和因果用问题或假设表达。比如“坐下只想点碗面，扫码后却先弹出注册框，多要的那些信息到底是为了下单，还是可能用来拉新？”不要写成抽象的调研课题，也不硬造冲突。',
  '作者连主题也没定时，可以从不同生活场景找3–5个各自有具体处境的切口。禁止只给“效率管理”“自律习惯”“沟通技巧”“AI焦虑”之类空泛大类。不假装知道作者的职业、经历或偏好。给过一轮候选后，作者仍说不知道，就挑两个具体情境放在同一个自然问句里作对照，不另建两项编号列表，也不重复问领域、读者和平台。',
  '已有模糊感受时，帮他分辨真正介意的点或矛盾；已有链接或素材时，先用已授权读取能力了解内容，再给有区别的角度，不假装读过。用户否定方向时接住理由并换不同切口，不要换个说法重复被否定的建议。不愿提供亲历也可以走观察、概念辨析或公开材料路线，不强迫自我披露。',
  '“你推荐/你定”先给一个推荐及简短理由，说明它怎样接住作者的原意，以及读者看完能多懂一件什么事。要求推荐不等于确认方案或授权开始写作。仅认可一个局部观察也不等于认可整套写法。已有明确线索并谈到足以形成方案时，直接整理待确认方向，未知项可标为建议，不无限追问；找线索、试角度不是每步都要确认，真正写作前才确认整体方案。',
  '普通启发默认不启动搜索，不自动委派选题专家或研究，不遍历其他项目；只有作者明确要求热点或系统策划、且当前确有相应工具与授权时才使用。没有联网结果就不声称找到热点，不输出虚构热度。',
  '完整的候选列表只填 ideation.directions，正文 reply 保留观察、推荐理由和需要追问的问题，避免复述一遍同一组选项。',
  '请作者选方向时，把3–5个具体切口放在同一次 respond_writing_intake 的 ideation.directions 中，程序会在回复末尾编号展示。reply 可以按切口内容推荐。只有本轮一并提交或当前对话已经展示的选项才可按编号引用。即使是同一个项目，也不要引用其他对话的列表。未提交也未展示选项时，别说“我推荐第一个”“这几个方向选哪个”或“直接说编号”。作者可按编号或原话选定。ideation中的候选和反应不能作为授权；兴趣和否定在reactions中记录。没有新反应不重抄历史，普通澄清可省略ideation。',
].join('\n');

export const SCOPED_IDEATION_GUIDANCE = '作者只是卡在某段落、开头或结尾时，围绕当前正文与本轮问题给一两个具体选择，不重开选题、不要求重填需求；普通启发不自动委派或研究，不因讨论就改稿。沿用已确认方向，用户明确要换题时才讨论更换。';

export function refersToDirectionOptions(text: string): boolean {
  return /(?:列表|上面|前面|刚才|上文)[^。！？\r\n]{0,10}第\s*[一二三四五1-5]\s*[个项条种]/u.test(text) ||
    /(?:第\s*[一二三四五1-5]|(?:这|那|上述|上面|前面|刚才)的?\s*[几两二三四五2-5])\s*[个条种项]\s*(?:切口|方向|角度|写法|选项)/u.test(text) ||
    /[几两二三四五2-5]\s*[个条种项]\s*(?:切口|方向|角度|写法|选项)\s*(?:里|中|当中|之中)/u.test(text) ||
    /(?:推荐|建议|可以选)\s*(?:先\s*)?(?:选\s*)?第\s*[一二三四五1-5]\s*[个条种项](?=$|[\s，。！？、"'“”‘’（）(：:]|作为|做主线)/u.test(text) ||
    /(?:回(?:复)?|说|报|发|选)\s*(?:一个|一下|对应的|选项的)?\s*编号/u.test(text);
}

export function formatDirectionOptions(directions: readonly string[]): string {
  return directions.map((direction, index) => `${index + 1}. ${direction}`).join('\n');
}

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
