import { z } from 'zod';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import { articleParagraphs } from './paragraph-revision.js';

export const MAX_PERSUASION_FINDINGS = 2;

export const PERSUASION_REVIEW_INSTRUCTIONS = [
  '你是目标读者中熟悉这个话题的人。只挑最影响文章说服力的现实反例或论点漏洞，最多两条，没有就留空。',
  '逐字引用一个完整原句（含句末标点），在 issue 解释哪一步推不出来、哪种常见情形会推翻判断，或哪条建议依赖一个未交代的前提。只写诊断，不给替换句、可粘贴的补丁或改写要求。',
  '忽略罕见且不影响主要结论的反例。不要为了挡住所有反驳要求正文叠加条件。你只看到文章，没出处的反例只当作可能情形。',
  '保留作者确认的选题、立场和有效表达。不审语气、节奏、用词或指代，不另写结尾、不提换题或补查。',
  '有 confirmedFocus 时，论点和反例必须与其中的主问题相关，不能让举例涉及的次要议题变成文章主题。',
  '只按 reviewOutputSchema 回复 JSON。每条 findings 的 kind 为 inference，evidenceIds 留空，issue 用读者能看懂的中文。没有意见时 findings 留空。',
].join('\n');

export const FOCUSED_REVISION_INSTRUCTIONS = [
  '只修 revisionFeedback 定位到的问题，看原句所在的完整段落和前后文再动笔。审稿意见是待检验的推理，不能当出处。意见站不住或无需修改时跳过。',
  '以 confirmedFocus 为准。修补只服务于作者的主问题，审稿提出的旁支不扩展为新主题或结论。',
  '逻辑问题用 paragraph，replacement 写完整的目标段落，让前提、推论和后一句接上。先交代建议是什么，再讨论它为何难实行。删掉建议时，一并处理依赖它的反驳和收尾。',
  '没出处的反例只当假设，可用具体的可能情形说清因果，也可删掉站不住的推断。保留确有必要的条件，不把可能写成已发生，不为了覆盖极端情况叠加限定。',
  '有材料支持的订正用 source。source.id 和 source.quote 指向已提供的原文依据，replacement 是改好的整个段落。用自己的话把新信息接进段落，已说过的事实只说一次；写判例时，可以把案情、法院理由和结果合起来写。不要把原文当补丁贴回去，不增加无来源的新事实。',
  '同一段涉及多条意见时合并在一次修改里，只提交其中一个 findingId。保留作者的方向、语气和其余段落。',
  '按 revisionOutputSchema 提交 reviewEdits，复制 baseBodyVersionId 和要修的 findingId。没有需要改的原句则提交空数组。',
].join('\n');

export const FINAL_LINT_INSTRUCTIONS = [
  '做局部检查：reference 是指代接不上，wording 是用词歧义或指错东西，material 是表述与所给原文不符，context 是一段话仍在反驳或引用已经被删掉的建议、前提或对象。新概念第一次出现本身不算问题。',
  '判决或通报的转述若还带着拗口的公文句式，用 wording 把这一处说顺，保留原意和作者的语气。先弄清当事人说了什么、法院认定了什么、日期说的是哪段时间。转述已经说错原文时用 material，附给出的原句作为订正依据。',
  '用 wording 局部改掉反复出现的“某媒体那篇文章提到”“某评论说得很直”等转述套话。保留必要的报道、调查或观点归属，写清谁做了调查、谁说了什么，分清报道日期与调查时间。只在本次提供的材料能确认时补具体名称或时间；原始出处不明就保留真实的转引层级。删套话不能把评论意见变成已知事实，或连带删掉数字对应的样本。直接讨论某篇文章时保留必要指代。每条只替换相关短语或一句。',
  '优先改几个字或一句。发现 context 问题时先看全文和 beforeRevision（若有），用正文交代被省掉的对象，或收掉依赖它的话。看不出原意时不要编造前提。',
  'context 的 quote 直接引用当前稿里断掉的那一句或它的一部分，replacement 提交接顺后的整个段落，一段只能改一次。其他类型的 replacement 只替换 quote。保留标题、顺序、观点、语气和有效修辞。',
  'material 必须用 source.id 和逐字 source.quote 标出原文依据。材料不足时保留原文，不为此补来源或重审论点。protectedHypotheses 中的旧假设句仅在 context 确有断层时可以随段落重写。无论是否在这张清单里，假设应保留其不确定性或随依赖它的推论一并删去，不写成事实。',
  '只按 lintOutputSchema 回复 JSON，复制 baseBodyVersionId。quote 是正文唯一出现的连续原文，replacement 是该处的新文字。没有需改的地方时提交空数组。不要回复全文。',
].join('\n');

const shortText = (max: number) => z.string().max(max).regex(/\S/u);
const span = shortText(320).regex(/^[^\r\n]+$/u);
const sourceReference = z.strictObject({ id: shortText(2000), quote: span });
const clause = shortText(220).regex(/^[^\r\n。！？.!?；;]+$/u);
const findingId = shortText(240);
const revisedParagraph = shortText(20_000).regex(/^[^\r\n]+$/u);
const paragraphEdit = z.strictObject({ findingId, kind: z.literal('paragraph'), replacement: revisedParagraph });
const sourceEdit = z.strictObject({ findingId, kind: z.literal('source'), source: sourceReference, replacement: revisedParagraph });
const reviewEdits = z.strictObject({ baseBodyVersionId: shortText(200),
  edits: z.array(z.discriminatedUnion('kind', [paragraphEdit, sourceEdit])).max(MAX_PERSUASION_FINDINGS) });
// Keep interrupted writes with legacy sentence edits recoverable.
const recordedReviewEdits = reviewEdits.extend({ edits: z.array(z.discriminatedUnion('kind', [
  paragraphEdit, sourceEdit.partial({ replacement: true }),
  z.strictObject({ findingId, kind: z.literal('remove') }),
  z.strictObject({ findingId, kind: z.literal('hypothesis'), lead: z.enum(['如果', '要是']).optional(), condition: clause, consequence: clause }),
])).max(MAX_PERSUASION_FINDINGS) });
const { $schema: _reviewSchema, ...reviewSchema } = z.toJSONSchema(reviewEdits, { target: 'draft-07' });
export const REVIEW_EDITS_SCHEMA = reviewSchema;

const edit = { quote: span, replacement: z.union([z.literal(''), span]), reason: shortText(400) };
const lintEdits = z.strictObject({ baseBodyVersionId: shortText(200), edits: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ ...edit, kind: z.literal('reference') }),
  z.strictObject({ ...edit, kind: z.literal('wording') }),
  z.strictObject({ ...edit, kind: z.literal('material'), source: z.strictObject({ id: shortText(2000), quote: shortText(900) }) }),
  z.strictObject({ ...edit, kind: z.literal('context'), replacement: revisedParagraph }),
])).max(100) });
const { $schema: _schema, ...lintSchema } = z.toJSONSchema(lintEdits, { target: 'draft-07' });
export const LINT_EDITS_SCHEMA = lintSchema;

export interface LintSource {
  id: string;
  text: string;
  instructionAuthority: 'none';
}

type FindingAnchor = { id: string; quote: string };

/** Resolve each review anchor to one paragraph. Keep every other byte in the
 * article and validate the cited passage independently of the replacement. */
export function applyReviewEdits(content: string, bodyVersionId: string, input: unknown,
  findings: readonly FindingAnchor[], sources: readonly LintSource[], reconcileRecorded = false) {
  const fail = (message: string): never => { throw new ToolExecutionFault('REVIEW_EDITS_INVALID', message, true); };
  const parsed = (reconcileRecorded ? recordedReviewEdits : reviewEdits).safeParse(input);
  if (!parsed.success) return fail(`按局部修订格式提交：${parsed.error.issues[0]!.message}`);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('修订只能修改当前绑定的稿件版本。');
  const paragraphs = articleParagraphs(content);
  const protectedHypotheses: string[] = [];
  const changes = parsed.data.edits.map(change => {
    const quote = findings.find(finding => finding.id === change.findingId)?.quote;
    const start = quote ? content.indexOf(quote) : -1;
    const end = start + (quote?.length ?? 0);
    const index = paragraphs.findIndex(paragraph => paragraph.start <= start && paragraph.end >= end);
    if (start < 0 || index < 0 || !quote || content.indexOf(quote, start + 1) !== -1 || isArticleHeading(paragraphs[index]!, index)) {
      return fail('只能修订这版稿件中可唯一定位的审稿原句。');
    }
    const paragraph = paragraphs[index]!;
    if (change.kind === 'remove') return { start, end, replacement: '' };
    if (change.kind === 'hypothesis') {
      if (!(start === paragraph.start || /[。！？!?][”’」』）)"']*\s*$/u.test(content.slice(paragraph.start, start))) ||
          !(end === paragraph.end || /[。！？!?][”’」』）)"']*$/u.test(quote))) return fail('用假设替换一整句，保留周围原文。');
      if (/[，、\s]$/u.test(change.condition) || /^\s*(?:如果|假如|假设|要是)/u.test(change.condition) ||
          /^\s*[，、]/u.test(change.consequence)) return fail('假设只填写条件和结果，程序会接成一句。');
      const hypothesis = `${change.lead ?? '如果'}${change.condition.trim()}，${change.consequence.trim()}。`;
      protectedHypotheses.push(hypothesis);
      return { start, end, replacement: hypothesis };
    }
    const replacement = change.replacement?.trim();
    if (change.kind === 'source') {
      const source = change.source;
      if (!sources.some(candidate => candidate.id === source.id && candidate.text.includes(source.quote)) ||
          /^\s{0,3}#{1,6}\s/u.test(source.quote)) return fail('材料订正须附当前请求中的原句作为依据，没出处的反例用假设。');
      if (replacement === undefined) return { start, end, replacement: source.quote };
      if (replacement.includes(quote)) return fail('提交已合并材料的完整段落，移除原来的问题句。');
    }
    if (!replacement || isArticleHeading({ ...paragraph, text: replacement }, index) ||
        (change.kind === 'paragraph' && replacement === paragraph.text.trim())) {
      return fail('提交修好的完整段落，保留文章标题。无需修改时跳过这条意见。');
    }
    return { start: paragraph.start, end: paragraph.end, replacement };
  });
  return { content: replaceSpans(content, changes, fail), protectedHypotheses };
}

function replaceSpans(content: string, changes: { start: number; end: number; replacement: string }[],
  fail: (message: string) => never) {
  let result = content;
  let boundary = content.length;
  for (const { start, end, replacement } of changes.sort((a, b) => b.start - a.start)) {
    if (end > boundary) return fail('两条局部修改不能覆盖同一处原文。');
    result = result.slice(0, start) + replacement + result.slice(end);
    boundary = start;
  }
  return result;
}

export function isArticleHeading(paragraph: ReturnType<typeof articleParagraphs>[number], index: number) {
  return /^ {0,3}#{1,6}(?:\s|$)/mu.test(paragraph.text) ||
    /(?:^|\r?\n) {0,3}(?:=+|-+)\s*$/u.test(paragraph.text) ||
    (index === 0 && /^[^\r\n。！？!?]{1,100}$/u.test(paragraph.text.trim()));
}

/** Bind ordinary lint to a sentence fragment and a broken reference repair to
 * the paragraph containing its anchor. The rest of the article stays intact. */
export function applyLintEdits(content: string, bodyVersionId: string, input: unknown,
  sources: readonly LintSource[], protectedHypotheses: readonly string[] = []) {
  const fail = (message: string): never => { throw new ToolExecutionFault('FINAL_LINT_INVALID', message, true); };
  const parsed = lintEdits.safeParse(input);
  if (!parsed.success) return fail(`按终稿检查格式提交局部修改：${parsed.error.issues[0]!.message}`);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('终稿检查只能修改当前绑定的稿件版本。');
  const paragraphs = articleParagraphs(content);
  const withinSentence = (value: string) => !/[。！？!?][”’」』）)"']*[\t ]*[^\s”’」』）)"']/u.test(value);
  const changes = parsed.data.edits.map(change => {
    const start = content.indexOf(change.quote);
    const end = start + change.quote.length;
    if (start < 0 || content.indexOf(change.quote, start + 1) !== -1) return fail('替换前的原句必须逐字引用，并且在这版稿件中只出现一次。');
    const index = paragraphs.findIndex(paragraph => paragraph.start <= start && paragraph.end >= end);
    const paragraph = paragraphs[index];
    if (!paragraph || isArticleHeading(paragraph, index) || change.quote === content.trim() || !withinSentence(change.quote)) {
      return fail('请引用正文段落内的一句或连续片段，保留标题和其它段落。');
    }
    if (change.kind === 'context') {
      const replacement = change.replacement.trim();
      if (replacement === paragraph.text.trim() || isArticleHeading({ ...paragraph, text: replacement }, index)) {
        return fail('请提交接好上下文的完整段落，保留文章标题。');
      }
      return { start: paragraph.start, end: paragraph.end, replacement };
    }
    if (protectedHypotheses.some(text => {
      // A hypothetical sentence can appear more than once in a long article.
      for (let pos = content.indexOf(text); pos >= 0; pos = content.indexOf(text, pos + 1)) {
        if (pos < end && pos + text.length > start) return true;
      }
      return false;
    })) return fail('保留修订时绑定的假设句，避免把假设改写成事实。');
    if ((!change.replacement && change.quote.trim() === paragraph.text.trim()) ||
        !withinSentence(change.replacement) || /^\s{0,3}#{1,6}\s/u.test(change.replacement) ||
        change.quote === change.replacement) return fail('每条只改正文范围内的一句话或片段，保留标题、段落和其他原文。');
    if (change.kind === 'material' && !sources.some(source => source.id === change.source.id && source.text.includes(change.source.quote))) {
      return fail('按材料订正时，要逐字引用当前请求内的材料原句。');
    }
    return { start, end, replacement: change.replacement };
  });
  return { content: replaceSpans(content, changes, fail), edits: parsed.data };
}
