import { z } from 'zod';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import type { ArtifactVersion } from '../../writing-core/src/index.js';
import { articleParagraphs } from './paragraph-revision.js';

export const MAX_PERSUASION_FINDINGS = 2;

export const PERSUASION_REVIEW_INSTRUCTIONS = [
  '你是目标读者中熟悉这个话题的人。只挑最影响文章说服力的现实反例或论点漏洞，最多两条，没有就留空。',
  '逐字引用一个完整原句（含句末标点）。建议本身走不通，quote 就圈出让读者去做那件事的指令；只有结果被夸大时才圈结果句。在 issue 写明推断缺了哪一步或建议缺了哪个前提。只给诊断，不给替换句。',
  '按文章已经限定的读者和处境审，先读清“有时”“往往”“在这件事上”等范围。只有原场景中常见、足以动摇主要判断或让读者照做时踩坑的情况才值得报。换到别的人群、任务或特殊条件才成立的边缘反例直接略过。没有出处的反例只供诊断，不当成真实案例。',
  'severity 用 required 标记足以影响中心判断或读者行动的硬伤；有帮助但省略后正文仍成立才标 suggestion，可少报或不报。检查实际建议能否支持它作出的承诺即可，别要求普通读者另设对照、重复试验或证明长期能力。正文已有一个行动落点时，不要求为收尾再设计练习。',
  '分清引出主题的场景、问句和作者实际作出的推断。引出问题的反差可以保留。若后文把一种反应直接当成能力或动机的证据，定位到作出该推断的原句，说明哪一步越界。举例只需解释漏洞，无需列全例外。',
  '一句就能收窄的过强归因，在 originQuote 逐字引用首次作出该断言的单句，可与 quote 相同。quote 仍可引用后文受影响的句子。找不到准确原句就省略 originQuote。',
  '保留作者确认的选题、立场和有效表达。不审语气、节奏、用词或指代，不另写结尾、不提换题或补查。',
  '有 confirmedFocus 时，论点和反例必须与其中的主问题相关，不能让举例涉及的次要议题变成文章主题。',
  '只按 reviewOutputSchema 回复 JSON。每条 findings 的 kind 为 inference，evidenceIds 省略即可，issue 用读者能看懂的中文。提交前核对 quote 是否与稿件逐字相同。没有意见时 findings 留空。',
].join('\n');

export const FOCUSED_REVISION_INSTRUCTIONS = [
  '原地收窄归因。先读你收到的全文，找到正文最早把迹象断定成唯一原因的那句话，就在那里改成有依据的判断，或者说清这一步值得先查什么。审稿若标在倒数两段，正文里同一个不成立判断要照样用 relatedEdits 修掉。倒数第二段若已有做法，只保留怎么做和做完能知道什么。末两段都不加一串例外来撤回原断言。',
  '末两段留给读者收束。删掉“接下来应核对……并持续观察”这类无明确执行者的研究待办句，别把末段的解释挪到倒数第二段。过强推断回正文原句收窄。末段回到开头的场景、矛盾或作者态度，避免换几个词重讲正文已有结论或操作。约80–120字只是参考，能自然收住就更短，原结尾有效时保留。',
  '逐条看 findingId。只有带 originQuote 的那条才用 kind=sentence，replacement 只填收窄后的原句。其余建议若要改做法，用 paragraph。需要清理后文同一判断时，用 relatedEdits 改相关段落。',
  '本轮只解决 revisionFeedback 列出的问题。逐条先在正文找过满的归因从哪句开始，再核对 paragraphScope.endingParagraphIds。先找齐用同一个根据推出同一个不成立判断的段落，再动笔。审稿原句只是定位起点。问句、反差和已经成立的判断照留。审稿意见是待检验的推理，不能当出处。',
  '先修 severity=required 中确实成立的硬伤。severity=suggestion 可跳过，尤其是需要另换人群、场景或给正文加一串条件才能用的建议。反例用来检验原判断；修稿优先在已有的处境里收窄判断或删掉推不出的那句，不把诊断里的反例、假设和验证条件当成要写进正文的素材。',
  '遇到没有依据且可以独立删掉的推断句，优先用 drop_claim，程序直接删掉审稿原句和 relatedEdits 中逐字引用的整句。剩下的段落需要接顺时才用 paragraph。把问句或反差留作读者进入文章的处境，判断落到原有行动、选择或结果。不要把同一个误推写成“至少能说明”或“通常是因为”。',
  '以 confirmedFocus 为准。每条意见先找一个最影响结论的读者疑问，把那一步讲清楚。材料回答的是相邻问题时，写清读者能感受到的差别。无需把审稿列出的反例、条件或术语逐项写进正文。',
  '逻辑问题用 paragraph，replacement 写完整的目标段落。建议的前提站不住时，直接改原来的操作句，写清读者在什么条件下找谁做什么；别留下旧做法，再在段尾解释它靠不住。删掉建议时，一并处理依赖它的反驳和收尾。',
  'relatedEndingCandidates 只提示结尾哪些段落重提了审稿涉及的信号。看正文时也要找同一信号推出来的正反两种评价。有了某个念头，不能据此说能力退化，也不能据此说能力仍在。开场只用来引出问题的问句照留。',
  'paragraphScope.directParagraphIds 是直接引用的段落。某段写出了同一推断的起点或在后来复述它时，放进对应 findingId 的 relatedEdits。每项填 paragraphId、连续原文 quote、为什么用的是同一种推理的 reason。drop_claim 的 quote 必须是可直接删掉的一句或几句原文，不填 replacement。paragraph 另填修订后的整段 replacement。确实没有相关段落才填空数组。必要呼应、单纯设问和无关段落照留。',
  '例如正文说“交接表没更新，就是值班人忘了”，审稿标的却是结尾“没更新就知道该找谁”。应回到正文原句，改成先查最后一次交接，末段落回手中的表格。原断言和末段的因果推断一并去掉，权限、系统故障之类的反例无需搬进正文。不把可能写成已发生。',
  '把材料边界写成正文里的具体判断，例如说清某项数据统计了谁、能算出什么。不要写成向作者汇报“材料没写什么”。文章讨论公开披露本身时，保留读者需要知道的未披露事项和出处；不把可能的归因写成事实。',
  '有材料支持的订正用 source。source.id 和 source.quote 指向已提供的原文依据，replacement 是改好的整个段落。用自己的话把新信息接进段落，已说过的事实只说一次；写判例时，可以把案情、法院理由和结果合起来写。不要把原文当补丁贴回去，不增加无来源的新事实。',
  '前文已经说清的一组数字、案情或例子，在修改段落中只留读者理解后续判断所需的一句回指，把篇幅留给本段新增的判断。',
  '校准同一项研究的样本、方法或自报口径时，先通过 revisionNeighbors 读问题段的前后正文。新增范围放进首次介绍这项研究的句子，下一段只留新的判断或必要短回指。问题段和首次介绍都要改时，用同一条 paragraph 的 relatedEdits 定位相邻正文。保留样本变化、自报归属和必要限定，别在阐释段把结果完整复述一遍。',
  '研究已有必要口径，后文回指时直接收窄那一句的判断到观察所及。只有本段新增判断确实需要的条件才随句写入。修正重复判断时，只保留本段独有的动作、代价或现实区别，前文展开过的步骤用短回指接上。',
  '一个段落总共只提交一次。已有直接修改的段落合并到那次修改。其余段落如有多条意见指向同一个问题，只选一个 findingId 关联。保留标题、顺序、作者的方向、语气和其余原文。',
  '按 revisionOutputSchema 提交 reviewEdits，复制 baseBodyVersionId 和要修的 findingId。没有需要改的原句则提交空数组。',
].join('\n');

export function finalLintMessages(body: string, baseBodyVersionId: string, practicalGuide: boolean) {
  const systemPrompt = [
    '你是公众号的最后一位读者。先看文章给的办法能不能照做，再删多余的话。能读通的地方让作者原话留下。',
    '小标题和结尾也要接得上正文。把给读者的建议走一遍：谁在什么时候向谁做什么，手里已经有什么？如果照小标题会找错人，或一上来就要用到后面才拿到的东西，按文中可行的做法改。小标题和步骤都有错就分两条提交。自己能核对的信息和要请别人判断的事要分清。',
    '一句先盘点手头资料、再讲实际区别，后半句能独立成立，就只圈出多余的从句和逗号。同段另有复读，分开圈。文章本身就在追问某份财报披露了什么时，保留出处和披露缺口。',
    '同一份政策、数据或解释讲了两次，后一处只留新增的意思。必要的呼应照留。假设已点明，省掉第二次声明。回指隔得远，用正文已有的对象接上，不从别段搬样本数。',
    '专门反驳一种误解的句子，先看前文是否真会让读者那样想。如果拿掉这句，后面的事例能直接接上、读者也不会理解错，就删这句。会影响事实范围或实际行动的限定留着。',
    '保留观点、语气、出处和事实范围。存疑的事实留给事实核查。quote 逐字引用，reason 用一句话说明。改小标题须引用带 Markdown 标记的整行，replacement 只填新标题文字。保留主标题。',
    ...(practicalGuide ? ['实用指南里保留已写清的操作入口和适用场景。重复的法条和步骤留在最有用的一处，渠道不清楚时不补猜测。'] : []),
    '只回复一个 JSON 对象，顶层字段为 lintEdits，内含输入中的 baseBodyVersionId 和修改数组 edits。每项填 kind、quote、replacement、reason。改小标题用 section_heading，改操作句或删半句用 wording，要接顺整段才用 context。删句的 replacement 留空。确实无需改动时 edits 可为空。',
  ].join('\n');
  return { systemPrompt, userMessage: `请通读这篇稿件。\nCOLLABORATION_STATE=${JSON.stringify({
    actor: 'language_review', stage: 'language_review', baseBodyVersionId, body,
  })}` };
}

const studyMeasures = /第[一二三四五六七八九十\d]+(?:轮|阶段)|\d+(?:\.\d+)?[\t ]*(?:名(?:大学生|受访者|参与者|受试者)?|人|分钟|小时|天|个月|[%％])/gu;
const normalizedStudyMeasure = (measure: string) => measure.normalize('NFKC').replace(/[\t ]/gu, '')
  .replace(/名(?:大学生|受访者|参与者|受试者)?$/u, '人');
const normalizedSentence = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
const phrasesOf = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 3) },
  (_, index) => value.slice(index, index + 4)));
const sentences = (text: string) => (text.match(/[^。！？!?\r\n]+[。！？!?]?/gu) ?? []).slice(0, 24)
  .map(excerpt => ({ excerpt, normalized: normalizedSentence(excerpt.slice(0, 500)) }))
  .filter(sentence => sentence.normalized.length >= 22)
  .map(sentence => ({ ...sentence, amounts: sentence.normalized.match(/\d+/gu)?.join('|') ?? '',
    phrases: phrasesOf(sentence.normalized) }));
const sharedPhrases = (a: Set<string>, b: Set<string>) => [...a].filter(phrase => b.has(phrase)).length;

/** Compare neighbors inside a section. Measures are hints, never proof of repetition. */
export function findAdjacentRepeatCandidates(paragraphs: ReturnType<typeof articleParagraphs>) {
  const candidates: { earlier: { paragraphId: string; excerpt: string }; later: { paragraphId: string; excerpt: string };
    basis: 'measures' | 'wording'; strong: boolean }[] = [];
  for (const [index, earlier] of paragraphs.entries()) {
    const later = paragraphs[index + 1];
    if (!later || isArticleHeading(earlier, index) || isArticleHeading(later, index + 1)) continue;
    const earlierMeasures = new Set(Array.from(earlier.text.matchAll(studyMeasures), match => normalizedStudyMeasure(match[0])));
    const sharedMeasures = new Set(Array.from(later.text.matchAll(studyMeasures), match => normalizedStudyMeasure(match[0]))
      .filter(measure => earlierMeasures.has(measure)));
    const add = (a: string, b: string, basis: 'wording' | 'measures', strong: boolean) => candidates.push({
      earlier: { paragraphId: earlier.id, excerpt: a.slice(0, 500) }, later: { paragraphId: later.id, excerpt: b.slice(0, 500) }, basis, strong,
    });
    if (sharedMeasures.size >= 2) add(earlier.text, later.text, 'measures', false);
    const right = sentences(later.text);
    for (const a of sentences(earlier.text)) {
      for (const b of right) {
        const shared = sharedPhrases(a.phrases, b.phrases);
        const shorter = Math.min(a.phrases.size, b.phrases.size);
        // A short exact repeat or extensive shared wording is suitable for a
        // correction request, never for deleting the sentence automatically.
        const same = a.normalized === b.normalized;
        if (same || (shared >= 10 && shared >= shorter * 0.19)) {
          add(a.excerpt, b.excerpt, 'wording', same || (a.amounts === b.amounts && shared >= 12 && shared >= shorter * 0.22));
        }
      }
    }
  }
  return candidates;
}

/** Catch a numeric comparison replaced by a demonstrative whose local premise has disappeared. */
function detachedComparison(before: ReturnType<typeof articleParagraphs>, after: ReturnType<typeof articleParagraphs>) {
  let start = 0;
  while (start < before.length && start < after.length && before[start]!.text === after[start]!.text) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1]!.text === after[newEnd - 1]!.text) {
    oldEnd--;
    newEnd--;
  }
  const comparison = /(?:从|由)\s*[+-]?\d+(?:[.．]\d+)?\s*[%％]?\s*(?:(?:上升|下降|上涨|下跌|升|降|涨|跌|回落|增加|减少|提高|降低)\s*)?(?:到|至|为)\s*[+-]?\d+(?:[.．]\d+)?/u;
  const referringChange = /(?:^|[。！？!?；;\r\n])\s*(?:(?:但|不过|而|其中)[，,]?)?((?:这一|这项|这组|这个|该)([\p{L}\p{N}]{2,16}?)的?(?:变化|变动|差异|结果))/gu;
  const comparisonClauses = (paragraphs: typeof before, end: number) => paragraphs.slice(start, end)
    .filter((paragraph, index) => !isArticleHeading(paragraph, start + index))
    .flatMap(paragraph => paragraph.text.match(/[^。！？!?；;\r\n]+/gu) ?? []).filter(clause => comparison.test(clause));
  const removedComparisons = comparisonClauses(before, oldEnd);
  if (!removedComparisons.length) return;
  const remainingComparisons = comparisonClauses(after, newEnd);
  // Only a changed paragraph and its first successor can lose their immediately preceding context.
  for (let index = start; index <= newEnd && index < after.length; index++) {
    const paragraph = after[index]!;
    if (isArticleHeading(paragraph, index)) continue;
    const prior = after[index - 1];
    for (const match of paragraph.text.matchAll(referringChange)) {
      const phrase = match[1]!;
      const topic = match[2]!;
      if (!removedComparisons.some(clause => clause.includes(topic)) || remainingComparisons.some(clause => clause.includes(topic))) continue;
      const localLead = paragraph.text.slice(0, match.index! + match[0].length - phrase.length);
      const localContext = prior && !isArticleHeading(prior, index - 1) ? prior.text + '\n' + localLead : localLead;
      const restOfSentence = paragraph.text.slice(match.index! + match[0].length).split(/[。！？!?；;\r\n]/u, 1)[0]!;
      if (!localContext.includes(topic) && !comparison.test(restOfSentence)) return { paragraphId: paragraph.id, phrase };
    }
  }
}

const shortText = (max: number) => z.string().max(max).regex(/\S/u);
const span = shortText(320).regex(/^[^\r\n]+$/u);
const sourceReference = z.strictObject({ id: shortText(2000), quote: span });
const clause = shortText(220).regex(/^[^\r\n。！？.!?；;]+$/u);
const findingId = shortText(240);
const revisedParagraph = shortText(20_000).regex(/^[^\r\n]+$/u);
const relatedAnchor = z.strictObject({ paragraphId: shortText(40), quote: span, reason: shortText(400) });
const relatedParagraphEdit = relatedAnchor.extend({ replacement: revisedParagraph });
const paragraphEdit = z.strictObject({ findingId, kind: z.literal('paragraph'), replacement: revisedParagraph,
  relatedEdits: z.array(relatedParagraphEdit).max(100).describe('同一推断在其他段的局部修订，优先核对结尾。全文确无重复时为空数组。').optional() });
const sentenceEdit = paragraphEdit.extend({ kind: z.literal('sentence'), replacement: span });
const dropClaim = z.strictObject({ findingId, kind: z.literal('drop_claim'),
  relatedEdits: z.array(relatedAnchor).max(100).describe('同时删除其它段中重复使用错误推断的一句或几句完整原文。').optional() });
const sourceEdit = z.strictObject({ findingId, kind: z.literal('source'), source: sourceReference, replacement: revisedParagraph });
const reviewEdits = z.strictObject({ baseBodyVersionId: shortText(200),
  edits: z.array(z.discriminatedUnion('kind', [dropClaim, paragraphEdit, sentenceEdit, sourceEdit])).max(MAX_PERSUASION_FINDINGS) });
// Keep interrupted writes with legacy sentence edits recoverable.
const recordedReviewEdits = reviewEdits.extend({ edits: z.array(z.discriminatedUnion('kind', [
  dropClaim, paragraphEdit, sentenceEdit, sourceEdit.partial({ replacement: true }),
  z.strictObject({ findingId, kind: z.literal('remove') }),
  z.strictObject({ findingId, kind: z.literal('hypothesis'), lead: z.enum(['如果', '要是']).optional(), condition: clause, consequence: clause }),
])).max(MAX_PERSUASION_FINDINGS) });
const { $schema: _reviewSchema, ...reviewSchema } = z.toJSONSchema(reviewEdits, { target: 'draft-07' });
export const REVIEW_EDITS_SCHEMA = reviewSchema;

const excerptEdits = z.strictObject({ baseBodyVersionId: shortText(200), replacement: span });
const { $schema: _excerptSchema, ...excerptSchema } = z.toJSONSchema(excerptEdits, { target: 'draft-07' });
export const REVIEW_EXCERPT_SCHEMA = excerptSchema;
const sentenceContinuation = /([。！？!?][”’」』）)"']*)[\t ]*[^\s”’」』）)"']/u;
const withinSentence = (value: string) => !sentenceContinuation.test(value);
function firstSentence(value: string) {
  const output = value.trim();
  const extra = sentenceContinuation.exec(output);
  return extra ? output.slice(0, extra.index + extra[1]!.length) : output;
}

export function reviewOriginQuote(body: string, quote: string, originQuote: string | null | undefined) {
  const excerpt = originQuote?.trim();
  if (!excerpt || !span.safeParse(excerpt).success || !withinSentence(excerpt)) return undefined;
  const start = body.indexOf(excerpt);
  if (start < 0 || start > body.indexOf(quote) || body.indexOf(excerpt, start + 1) !== -1) return undefined;
  const paragraphs = articleParagraphs(body);
  const index = paragraphs.findIndex(p => p.start <= start && start + excerpt.length <= p.end);
  return index >= 0 && !isArticleHeading(paragraphs[index]!, index) ? excerpt : undefined;
}

const lintAnchor = shortText(20_000).describe('逐字引用同一段内的连续原文，可引用整段。');
const edit = { quote: lintAnchor, replacement: z.union([z.literal(''), revisedParagraph]), reason: shortText(400) };
const lintSourceReference = z.strictObject({ id: shortText(2000), quote: shortText(900) });
const lintEdit = z.discriminatedUnion('kind', [
  z.strictObject({ ...edit, kind: z.literal('reference') }),
  z.strictObject({ ...edit, kind: z.literal('wording') }),
  z.strictObject({ ...edit, kind: z.literal('material'), source: lintSourceReference }),
  z.strictObject({ ...edit, kind: z.literal('context'), replacement: revisedParagraph }),
  z.strictObject({ ...edit, kind: z.literal('section_heading'),
    quote: span.describe('带原有 Markdown 标记的整行正文小标题。'),
    replacement: shortText(200).regex(/^(?![\t ]*#)(?!.*[\t ]+#+[\t ]*$)[^\r\n]+$/u)
      .describe('只填小标题文字，程序保留原标记和层级。') }),
  z.strictObject({ ...edit, kind: z.literal('merge'), nextQuote: lintAnchor, replacement: revisedParagraph, source: lintSourceReference,
    followingQuote: lintAnchor.optional().describe('合并第三段时，逐字引用紧邻第二段的正文。'),
    supportingSources: z.array(lintSourceReference).max(2).optional().describe('合并涉及多份材料的段落时，提供其他材料的原文。') }),
]);
const maxLintEdits = 100;
const lintSubmission = z.strictObject({ baseBodyVersionId: shortText(200), edits: z.array(z.unknown()).max(maxLintEdits) });
// Leave item validation to the save handler so one malformed edit cannot block the others.
const { $schema: _submissionSchema, ...lintSubmissionSchema } = z.toJSONSchema(lintSubmission, { target: 'draft-07' });
export const LINT_SUBMISSION_SCHEMA = lintSubmissionSchema;

export interface LintSource {
  id: string;
  text: string;
  instructionAuthority: 'none';
  sourceType?: 'search_excerpt';
  useBoundary?: string;
}

type FindingAnchor = { id: string; quote: string; originQuote?: string };

export interface ReviewExcerptSelection {
  readonly baseBodyHash: string;
  readonly findingQuote: string;
  readonly quote: string;
  readonly fixedEdits: readonly { quote: string; replacement: string }[];
}

/** Only the selected excerpt is generated. Author-selected text stays with the application. */
export function bindReviewExcerpt<T extends FindingAnchor>(base: Pick<ArtifactVersion, 'id' | 'content' | 'contentHash'>,
  findings: readonly T[], selection: ReviewExcerptSelection) {
  const fail = (message: string): never => { throw new ToolExecutionFault('REVIEW_EDITS_INVALID', message, true); };
  if (base.contentHash !== selection.baseBodyHash) return fail('原稿已变化，请重新选定要修订的原句。');
  const finding = findings.find(item => item.quote === selection.findingQuote);
  if (!finding) return fail('选定的原句需要关联本轮已保存的审稿意见。');
  if (!withinSentence(selection.quote)) return fail('主笔只接收一句原文或其中的连续片段。');
  const paragraphs = articleParagraphs(base.content);
  const locate = (quote: string) => {
    const start = base.content.indexOf(quote);
    const end = start + quote.length;
    const index = paragraphs.findIndex(p => p.start <= start && p.end >= end);
    const paragraph = paragraphs[index];
    if (!quote.trim() || !paragraph || isArticleHeading(paragraph, index) || base.content.indexOf(quote, start + 1) !== -1) {
      return fail('选定的文字必须在原稿正文内逐字对应，并能唯一定位。');
    }
    return { start, end, paragraph };
  };
  const target = locate(selection.quote);
  const fixed = selection.fixedEdits.map(({ quote, replacement }) => ({ ...locate(quote), replacement }));
  // Check the bound ranges before dispatching a model request.
  const ranges = [target, ...fixed].sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) {
    return fail('选定的修订范围互相重叠。');
  }
  return {
    finding,
    paragraphId: target.paragraph.id,
    quote: selection.quote,
    apply(input: unknown) {
      const parsed = excerptEdits.safeParse(input);
      if (!parsed.success || parsed.data.baseBodyVersionId !== base.id) return fail('只提交这版稿件选定原句的替换文字。');
      // This slot replaces one sentence. A following explanation stays in the raw tool receipt only.
      const replacement = firstSentence(parsed.data.replacement);
      if (replacement.includes(selection.quote) || /^ {0,3}#{1,6}\s/u.test(replacement)) {
        return fail('请在原处收窄选择的原句，只提交改后的正文句子。');
      }
      return { content: replaceSpans(base.content, [{ ...target, replacement }, ...fixed], fail), protectedHypotheses: [] };
    },
  };
}

/** Apply only paragraphs bound to an original finding and verbatim text in the current draft. */
export function applyReviewEdits(content: string, bodyVersionId: string, input: unknown,
  findings: readonly FindingAnchor[], sources: readonly LintSource[], reconcileRecorded = false) {
  const fail = (message: string): never => { throw new ToolExecutionFault('REVIEW_EDITS_INVALID', message, true); };
  const parsed = (reconcileRecorded ? recordedReviewEdits : reviewEdits).safeParse(input);
  if (!parsed.success) return fail(`按局部修订格式提交：${parsed.error.issues[0]!.message}`);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('修订只能修改当前绑定的稿件版本。');
  const paragraphs = articleParagraphs(content);
  const protectedHypotheses: string[] = [];
  const relatedTarget = (edit: z.infer<typeof relatedAnchor>) => {
    const targetIndex = paragraphs.findIndex(candidate => candidate.id === edit.paragraphId);
    const target = paragraphs[targetIndex];
    if (!target || isArticleHeading(target, targetIndex) || !target.text.includes(edit.quote)) {
      return fail(`关联修改须引用 ${edit.paragraphId} 内逐字存在的正文，标题不能修改。`);
    }
    return { target, targetIndex };
  };
  const droppedIn = new Set<string>();
  const dropSentence = (paragraph: (typeof paragraphs)[number], quote: string) => {
    const start = paragraph.text.indexOf(quote);
    const end = start + quote.length;
    const before = paragraph.text.slice(0, start);
    const after = paragraph.text.slice(end);
    const sentenceEnd = /[。！？!?][”’」』）)"']*\s*$/u;
    if (start < 0 || paragraph.text.indexOf(quote, start + 1) >= 0 || !(before + after).trim() ||
        (before.trim() && !sentenceEnd.test(before)) || !sentenceEnd.test(quote)) {
      return fail(`只删除 ${paragraph.id} 内可唯一定位的完整原句，段落仍须保留可读文字。`);
    }
    if (droppedIn.has(paragraph.id)) return fail(`请合并 ${paragraph.id} 的删除，每个段落只提交一次。`);
    droppedIn.add(paragraph.id);
    return { start: paragraph.start + start, end: paragraph.start + end, replacement: '' };
  };
  const changes = parsed.data.edits.flatMap((change, editIndex) => {
    const field = `reviewEdits.edits[${editIndex}]`;
    const finding = findings.find(finding => finding.id === change.findingId);
    if (!finding) return fail(`${field}.findingId 未匹配到本轮意见：${change.findingId}。`);
    const origin = reviewOriginQuote(content, finding.quote, finding.originQuote);
    if (origin && change.kind !== 'sentence') {
      return fail(`${field}.kind（${finding.id}）已绑定 originQuote，请用 sentence 在原句收窄；相关段落填在这条的 relatedEdits 中。`);
    }
    if (!origin && change.kind === 'sentence') {
      return fail(`${field}.kind（${finding.id}）没有可绑定的 originQuote。修正做法请用 paragraph 改审稿原句所在段；本段只提交一次。`);
    }
    const quote = origin ?? finding.quote;
    const start = quote ? content.indexOf(quote) : -1;
    const end = start + (quote?.length ?? 0);
    const index = paragraphs.findIndex(paragraph => paragraph.start <= start && paragraph.end >= end);
    if (start < 0 || index < 0 || !quote || content.indexOf(quote, start + 1) !== -1 || isArticleHeading(paragraphs[index]!, index)) {
      return fail('只能修订这版稿件中可唯一定位的审稿原句。');
    }
    const paragraph = paragraphs[index]!;
    if (change.kind === 'drop_claim') return [dropSentence(paragraph, quote),
      ...(change.relatedEdits ?? []).map(edit => dropSentence(relatedTarget(edit).target, edit.quote))];
    if (change.kind === 'remove') return [{ start, end, replacement: '' }];
    if (change.kind === 'hypothesis') {
      if (!(start === paragraph.start || /[。！？!?][”’」』）)"']*\s*$/u.test(content.slice(paragraph.start, start))) ||
          !(end === paragraph.end || /[。！？!?][”’」』）)"']*$/u.test(quote))) return fail('用假设替换一整句，保留周围原文。');
      if (/[，、\s]$/u.test(change.condition) || /^\s*(?:如果|假如|假设|要是)/u.test(change.condition) ||
          /^\s*[，、]/u.test(change.consequence)) return fail('假设只填写条件和结果，程序会接成一句。');
      const hypothesis = `${change.lead ?? '如果'}${change.condition.trim()}，${change.consequence.trim()}。`;
      protectedHypotheses.push(hypothesis);
      return [{ start, end, replacement: hypothesis }];
    }
    const replacement = change.kind === 'sentence' ? firstSentence(change.replacement) : change.replacement?.trim();
    if (change.kind === 'source') {
      const source = change.source;
      if (!sources.some(candidate => candidate.id === source.id && candidate.text.includes(source.quote)) ||
          /^\s{0,3}#{1,6}\s/u.test(source.quote)) return fail('材料订正须附当前请求中的原句作为依据，没出处的反例用假设。');
      if (replacement === undefined) return [{ start, end, replacement: source.quote }];
      if (replacement.includes(quote)) return fail('提交已合并材料的完整段落，移除原来的问题句。');
    }
    if (!replacement || (change.kind === 'sentence' ? /^ {0,3}#{1,6}\s/u.test(replacement) || replacement === quote
      : isArticleHeading({ ...paragraph, text: replacement }, index)) ||
        (change.kind === 'paragraph' && replacement === paragraph.text.trim())) {
      return fail('提交修好的完整段落，保留文章标题。无需修改时跳过这条意见。');
    }
    const linked = change.kind === 'paragraph' || change.kind === 'sentence' ? (change.relatedEdits ?? []).map(edit => {
      const { target, targetIndex } = relatedTarget(edit);
      const text = edit.replacement.trim();
      if (isArticleHeading({ ...target, text }, targetIndex) || text === target.text.trim() || text.includes(edit.quote)) {
        return fail(`请在 ${edit.paragraphId} 的完整修订段中改掉重复推断，保留标题及其它段落。`);
      }
      return { start: target.start, end: target.end, replacement: text };
    }) : [];
    return [change.kind === 'sentence' ? { start, end, replacement }
      : { start: paragraph.start, end: paragraph.end, replacement }, ...linked];
  });
  return { content: replaceSpans(content, changes, fail), protectedHypotheses };
}

function replaceSpans(content: string, changes: { start: number; end: number; replacement: string }[],
  fail: (message: string) => never) {
  let result = content;
  let boundary = content.length;
  for (const { start, end, replacement } of [...changes].sort((a, b) => b.start - a.start)) {
    if (end > boundary) return fail('两条局部修改不能覆盖同一处原文。');
    result = result.slice(0, start) + replacement + result.slice(end);
    boundary = start;
  }
  return result;
}

export function isArticleHeading(paragraph: { text: string }, index: number) {
  return /^ {0,3}#{1,6}(?:\s|$)/mu.test(paragraph.text) ||
    /(?:^|\r?\n) {0,3}(?:=+|-+)\s*$/u.test(paragraph.text) ||
    (index === 0 && /^[^\r\n。！？!?]{1,100}$/u.test(paragraph.text.trim()));
}

const sectionHeadingLine = /^(#{2,6}[\t ]+)([^#\s][^\r\n]*?)([\t ]+#+[\t ]*|[\t ]*)$/u;
const markdown = unified().use(remarkParse);
const sampleCounts = (text: string) =>
  (text.normalize('NFKC').match(/\d+(?:[.,]\d+)*\s*[万千亿]?\s*(?:名|位|人次|人|款|辆|份|家|所|例)/gu) ?? [])
    .map(count => count.replace(/[\s,]/gu, '').replace(/[名位]$/u, '人'));

type LintOptions = { checkIntroducedRepeats?: boolean; checkDetachedReferences?: boolean; checkLocalSampleSizes?: boolean;
  validateBody?: (content: string, headingBaseline: string) => void };

/** Apply bounded edits against exact anchors in the current article. */
function applyLocalEdits(content: string, bodyVersionId: string, input: unknown,
  sources: readonly LintSource[], protectedHypotheses: readonly string[], options: LintOptions) {
  const fail = (message: string): never => { throw new ToolExecutionFault('FINAL_LINT_INVALID', message, true); };
  const parsed = lintSubmission.safeParse(input);
  if (!parsed.success) return fail(`按终稿检查格式提交局部修改：${parsed.error.issues[0]!.message}`);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('终稿检查只能修改当前绑定的稿件版本。');
  const paragraphs = articleParagraphs(content);
  let subheadingOffsets: Set<number | undefined> | undefined;
  const authorizedSource = (source: z.infer<typeof lintSourceReference>) =>
    sources.some(candidate => candidate.id === source.id && candidate.text.includes(source.quote));
  const touchesProtected = (start: number, end: number) => protectedHypotheses.some(text => {
    for (let pos = content.indexOf(text); pos >= 0; pos = content.indexOf(text, pos + 1)) {
      if (pos < end && pos + text.length > start) return true;
    }
    return false;
  });
  const locateEdit = (change: z.infer<typeof lintEdit>) => {
    const start = content.indexOf(change.quote);
    const end = start + change.quote.length;
    if (start < 0 || content.indexOf(change.quote, start + 1) !== -1) return fail('替换前的原句必须逐字引用，并且在这版稿件中只出现一次。');
    const index = paragraphs.findIndex(paragraph => paragraph.start <= start && paragraph.end >= end);
    const paragraph = paragraphs[index];
    if (change.kind === 'section_heading') {
      const heading = sectionHeadingLine.exec(change.quote);
      const replacement = change.replacement.trim();
      subheadingOffsets ??= new Set(markdown.parse(content).children
        .flatMap(node => node.type === 'heading' && node.depth > 1 ? [node.position?.start.offset] : []));
      if (!paragraph || index === 0 || !subheadingOffsets.has(start) || start !== paragraph.start ||
          change.quote !== paragraph.text.split(/\r?\n/u, 1)[0] || !heading ||
          touchesProtected(start, end)) {
        return fail('请逐字引用整行正文小标题，只修改其文字，保留主标题。');
      }
      if (replacement === heading[2]) return fail('新小标题与原文相同。需要改标题时请填入改后的文字，准备保留时省略这一条。');
      return { start, end, replacement: `${heading[1]}${replacement}${heading[3]}` };
    }
    if (!paragraph || isArticleHeading(paragraph, index)) {
      return fail('请逐字引用同一个正文段落里的连续原文，保留标题和其它段落。');
    }
    if (options.checkLocalSampleSizes !== false && ['wording', 'reference', 'context'].includes(change.kind) &&
        /样本|受访|受试/u.test(change.replacement)) {
      const local = new Set(sampleCounts(paragraph.text));
      const added = sampleCounts(change.replacement).find(count => !local.has(count));
      if (added) return fail('这条文字调整新带入了本段没有的样本数量（' + added + '）。回指时可直接说是哪项调查或哪个指标，原段的统计范围照留。');
    }
    if (change.kind === 'merge') {
      const anchors = change.followingQuote ? [change.nextQuote, change.followingQuote] : [change.nextQuote];
      const following = paragraphs.slice(index + 1, index + 1 + anchors.length);
      const last = following.at(-1);
      const replacement = change.replacement.trim();
      if (!last || following.length !== anchors.length || following.some((p, i) => {
        const anchor = anchors[i]!;
        const offset = p.text.indexOf(anchor);
        return isArticleHeading(p, index + i + 1) || offset < 0 || p.text.indexOf(anchor, offset + 1) !== -1;
      }) ||
          isArticleHeading({ ...paragraph, text: replacement }, index) || touchesProtected(paragraph.start, last.end)) {
        return fail('合并只处理逐字定位的相邻正文段落，保留小标题和已绑定的假设。');
      }
      const references = [change.source, ...(change.supportingSources ?? [])];
      if (!references.every(authorizedSource) || (change.followingQuote && new Set(references.map(ref => ref.id)).size < 2)) {
        return fail('合并段落要逐字引用当前请求中的材料。合并三段时，请至少提供两份不同材料的依据。');
      }
      return { start: paragraph.start, end: last.end, replacement };
    }
    if (change.kind === 'context') {
      const replacement = change.replacement.trim();
      if (replacement === paragraph.text.trim() || isArticleHeading({ ...paragraph, text: replacement }, index)) {
        return fail('请提交接好上下文的完整段落，保留文章标题。');
      }
      return { start: paragraph.start, end: paragraph.end, replacement };
    }
    if (touchesProtected(start, end)) return fail('保留修订时绑定的假设句，避免把假设改写成事实。');
    const coversParagraph = change.quote.trim() === paragraph.text.trim();
    if ((!change.replacement && coversParagraph) ||
        (!coversParagraph && withinSentence(change.quote) && !withinSentence(change.replacement)) ||
        isArticleHeading({ text: change.replacement }, -1) || change.quote === change.replacement) {
      return fail('请在原引用范围内修改，保留段落和小标题。');
    }
    if (change.kind === 'material' && !authorizedSource(change.source)) {
      return fail('按材料订正时，要逐字引用当前请求内的材料原句。');
    }
    return { start, end, replacement: change.replacement };
  };
  type Edit = z.infer<typeof lintEdit>;
  const accepted: { index: number; edit: Edit; change: ReturnType<typeof locateEdit> }[] = [];
  const rejected: { index: number; code: string; message: string; paragraphPairs?: string[][];
    reference?: { paragraphId: string; phrase: string } }[] = [];
  const repeatKey = (pair: ReturnType<typeof findAdjacentRepeatCandidates>[number]) =>
    `${normalizedSentence(pair.earlier.excerpt)}\n${normalizedSentence(pair.later.excerpt)}`;
  let repeats: Set<string> | undefined;
  let revised = content;
  let headingBaseline = content;
  for (const [offset, item] of parsed.data.edits.entries()) {
    const index = offset + 1;
    try {
      const decoded = lintEdit.safeParse(item);
      if (!decoded.success) {
        const issue = decoded.error.issues[0]!;
        fail(`这条修改的字段不符合格式（${issue.path.join('.') || '整条'}）。`);
      }
      const edit = decoded.data!;
      const change = locateEdit(edit);
      const conflict = accepted.find(prior => change.start < prior.change.end && prior.change.start < change.end);
      if (conflict) fail(`修改范围和已接受的第 ${conflict.index} 条重叠。`);
      const candidate = replaceSpans(content, [...accepted.map(prior => prior.change), change], fail);
      const nextBaseline = edit.kind === 'section_heading'
        ? replaceSpans(content, [...accepted.filter(prior => prior.edit.kind === 'section_heading').map(prior => prior.change), change], fail)
        : headingBaseline;
      options.validateBody?.(candidate, nextBaseline);
      if (edit.kind !== 'section_heading' && candidate !== revised) {
        const before = articleParagraphs(revised);
        const after = articleParagraphs(candidate);
        if (options.checkDetachedReferences !== false) {
          const reference = detachedComparison(before, after);
          if (reference) {
            rejected.push({ index, code: 'FINAL_LINT_DETACHED_REFERENCE',
              message: `这条修改删掉了「${reference.phrase}」在附近指向的具体变化。请保留简短的前情，或删去依赖它的回指。`, reference });
            continue;
          }
        }
        if (options.checkIntroducedRepeats !== false) {
          repeats ??= new Set(findAdjacentRepeatCandidates(before).map(repeatKey));
          const candidates = findAdjacentRepeatCandidates(after);
          const introduced = candidates.filter(pair => pair.strong && !repeats!.has(repeatKey(pair))).slice(0, 4);
          if (introduced.length) {
            rejected.push({ index, code: 'FINAL_LINT_ADJACENT_REPEAT', message: '这条修改使相邻段落新增了高度重复的内容。',
              paragraphPairs: introduced.map(pair => [pair.earlier.paragraphId, pair.later.paragraphId]) });
            continue;
          }
          repeats = new Set(candidates.map(repeatKey));
        }
      }
      accepted.push({ index, edit, change });
      revised = candidate;
      headingBaseline = nextBaseline;
    } catch (error) {
      if (!(error instanceof ToolExecutionFault)) throw error;
      rejected.push({ index, code: error.code, message: error.message });
    }
  }
  return { content: revised, headingBaseline, edits: { baseBodyVersionId: bodyVersionId, edits: accepted.map(prior => prior.edit) },
    appliedIndexes: accepted.map(prior => prior.index), rejected };
}

// Only the removable preface is matched. A named disclosure, standalone
// limitation, or sentence whose actual conclusion still needs writing stays put.
const breakdownQuestion = /^(?:[^，,。！？；;]{0,45}(?:多少|几成)[^，,。！？；;]{0,28})[，,]\s*/u;
const workingMaterialAside = /^(?:(?:手头|现有|已有)的?)?(?:材料|资料|数据)(?:中|里)?(?:没有|没|并未|无法|未能)(?:拆开|拆清|拆分|细分)(?:计算|[^，,。！？；;]{1,36}(?:多少|几成))?[，,]\s*(?:因此|因而|所以)?/u;
function findEditorialAsides(body: string) {
  const cuts: { paragraphId: string; removed: string }[] = [];
  if (!/(?:拆开|拆清|拆分|细分)/u.test(body)) return cuts;
  const paragraphs = new Map(articleParagraphs(body).map(p => [p.start, p]));
  for (const node of markdown.parse(body).children) {
    // Exclude quoted speech, markdown links, code, blockquotes, and attributed documents.
    if (node.type !== 'paragraph' || !node.children.every(child => child.type === 'text')) continue;
    const p = paragraphs.get(node.position?.start.offset ?? -1);
    if (!p || /[“”「」『』《》"`]/u.test(p.text)) continue;
    for (const sentence of p.text.matchAll(/[^。！？!?；;\r\n]+/gu)) {
      const original = sentence[0];
      const leadingAside = workingMaterialAside.exec(original)?.[0];
      const question = leadingAside ? '' : breakdownQuestion.exec(original)?.[0] ?? '';
      const aside = leadingAside ?? workingMaterialAside.exec(original.slice(question.length))?.[0];
      if (!aside || /(?:年报|公告|通报|报告|合同|条款|披露)/u.test(question)) continue;
      const removed = question + aside;
      const conclusion = original.slice(removed.length);
      if (!/^不能(?:把|拿|用).+(?:当成|当作|等同|算出|证明)/u.test(conclusion)) continue;
      const preceding = p.text.slice(0, sentence.index);
      if (/^不能(?:把|拿|用)(?:它|其|这个|这一)/u.test(conclusion) && !/(?:率|口径|指标|统计|均值|收入|利润)/u.test(preceding)) continue;
      const kept = preceding + p.text.slice(sentence.index + removed.length);
      const amounts = new Set(kept.match(/\d+(?:\.\d+)?%?/gu));
      if ((removed.match(/\d+(?:\.\d+)?%?/gu) ?? []).some(amount => !amounts.has(amount))) continue;
      cuts.push({ paragraphId: p.id, removed });
    }
  }
  return cuts;
}

export function applyLintEdits(content: string, bodyVersionId: string, input: unknown,
  sources: readonly LintSource[], protectedHypotheses: readonly string[] = [],
  options: LintOptions & { trimEditorialAsides?: boolean } = {}) {
  const { headingBaseline, ...lint } = applyLocalEdits(content, bodyVersionId, input, sources, protectedHypotheses, options);
  const candidates = options.trimEditorialAsides ? findEditorialAsides(lint.content) : [];
  const editorialCuts: { paragraphId: string; removed: string; applied: boolean; reason?: string }[] = [];
  for (let start = 0; start < candidates.length; start += maxLintEdits) {
    const batch = candidates.slice(start, start + maxLintEdits);
    const edits = batch.map(({ removed }) => ({ kind: 'wording', quote: removed, replacement: '', reason: '原句后半已写清统计范围，可直接保留。' }));
    const trimmed = applyLocalEdits(lint.content, bodyVersionId, { baseBodyVersionId: bodyVersionId, edits },
      sources, protectedHypotheses, { ...options, validateBody: (candidate) => options.validateBody?.(candidate, headingBaseline) });
    batch.forEach((cut, i) => {
      const rejection = trimmed.rejected.find(item => item.index === i + 1);
      editorialCuts.push(rejection ? { ...cut, applied: false, reason: rejection.message } : { ...cut, applied: true });
    });
    lint.content = trimmed.content;
  }
  return { ...lint, editorialCuts };
}
