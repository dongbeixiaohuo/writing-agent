import { z } from 'zod';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';

export function articleParagraphs(content: string) {
  const result: { id: string; text: string; start: number; end: number; title: boolean }[] = [];
  const pattern = /\S[\s\S]*?(?=\r?\n[\t ]*\r?\n|$)/gu;
  for (const match of content.matchAll(pattern)) {
    result.push({ id: `p${result.length + 1}`, text: match[0], start: match.index!, end: match.index! + match[0].length,
      title: /^#\s/u.test(match[0]) });
  }
  return result;
}

export function quoteParagraphIds(content: string, quote: string): string[] {
  if (!quote.trim()) return [];
  const ranges: [number, number][] = [];
  for (let at = content.indexOf(quote); at >= 0; at = content.indexOf(quote, at + quote.length)) ranges.push([at, at + quote.length]);
  return articleParagraphs(content).filter(p => ranges.some(([a, b]) => p.start < b && p.end > a)).map(p => p.id);
}

type Problem = { quote: string; paragraphIds?: readonly string[] | undefined; bodyVersionId?: string };
export function paragraphRepairScope(content: string, findings: readonly Problem[], bodyVersionId?: string) {
  const paragraphs = articleParagraphs(content);
  const fromOlderBody = (finding: Problem) => finding.bodyVersionId !== undefined && finding.bodyVersionId !== bodyVersionId;
  const allowed = new Set(findings.flatMap(f => !fromOlderBody(f) && f.paragraphIds?.length ? f.paragraphIds : quoteParagraphIds(content, f.quote)));
  const duplicateParagraphIds: string[] = [];
  // An approved revision may no longer contain any of the audit excerpts.
  // Only a demonstrable duplicate in that body can extend an otherwise empty scope.
  if (findings.length && findings.every(fromOlderBody) && !paragraphs.some(p => !p.title && allowed.has(p.id))) {
    for (const [index, paragraph] of paragraphs.entries()) {
      const previous = paragraphs[index - 1];
      if (previous && !previous.title && !paragraph.title && previous.text === paragraph.text) {
        duplicateParagraphIds.push(paragraph.id);
        allowed.add(paragraph.id);
      }
    }
  }
  return { paragraphs: paragraphs.map(({ id, text, title }) => ({ id, text, editable: !title && allowed.has(id) })),
    editableParagraphIds: paragraphs.filter(p => !p.title && allowed.has(p.id)).map(p => p.id),
    duplicateParagraphIds };
}

const editSchema = z.strictObject({ baseBodyVersionId: z.string().min(1),
  edits: z.array(z.strictObject({ paragraphId: z.string().min(1), replacement: z.string().max(20_000) })).max(100) });
const { $schema: _schema, ...definition } = z.toJSONSchema(editSchema, { target: 'draft-07' });
export const PARAGRAPH_EDITS_SCHEMA = definition;

export function paragraphEditsOutputSchema(bodyVersionId: string, scope: ReturnType<typeof paragraphRepairScope>) {
  return { ...PARAGRAPH_EDITS_SCHEMA, properties: {
    baseBodyVersionId: { type: 'string', const: bodyVersionId },
    edits: scope.editableParagraphIds.length ? { type: 'array', maxItems: Math.min(100, scope.editableParagraphIds.length), items: {
      type: 'object', properties: {
        paragraphId: { type: 'string', enum: scope.editableParagraphIds },
        replacement: scope.duplicateParagraphIds.length ? { type: 'string', const: '' } : { type: 'string', maxLength: 20_000 },
      }, required: ['paragraphId', 'replacement'], additionalProperties: false,
    } } : { type: 'array', maxItems: 0 },
  } };
}

/** Apply to exact byte-equivalent JS string spans. Unaddressed content, title,
 * separators and paragraph order are owned by the application, not regenerated. */
export function applyParagraphEdits(content: string, bodyVersionId: string, value: unknown, findings: readonly Problem[]) {
  const fail = (message: string): never => { throw new ToolExecutionFault('PARAGRAPH_EDITS_INVALID', message, true); };
  const parsed = editSchema.safeParse(value);
  if (!parsed.success) return fail(parsed.error.issues[0]!.message);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('Paragraph edits must bind the current body version.');
  const paragraphs = articleParagraphs(content);
  const scope = paragraphRepairScope(content, findings, bodyVersionId);
  const allowed = new Set(scope.editableParagraphIds);
  const duplicateOnly = new Set(scope.duplicateParagraphIds);
  const seen = new Set<string>();
  const changes = parsed.data.edits.map(edit => {
    const paragraph = paragraphs.find(p => p.id === edit.paragraphId);
    if (!paragraph || !allowed.has(edit.paragraphId) || seen.has(edit.paragraphId)) {
      return fail(scope.editableParagraphIds.length
        ? `只能修改当前稿件中列出的段落（${scope.editableParagraphIds.join('、')}），每段最多一次。`
        : '当前稿件没有可安全修改的段落，请提交空的 edits 数组。');
    }
    if (duplicateOnly.has(edit.paragraphId) && edit.replacement !== '') return fail('此段与上一段完全相同，只可删除重复的一份。请将 replacement 设为空字符串。');
    if (/^#\s/mu.test(edit.replacement)) return fail('A paragraph edit cannot replace or add an article title.');
    seen.add(edit.paragraphId);
    return { ...paragraph, replacement: edit.replacement };
  });
  let result = content;
  for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.replacement + result.slice(change.end);
  return { content: result, changedParagraphIds: changes.filter(p => p.text !== p.replacement).map(p => p.id),
    untouchedParagraphIds: paragraphs.filter(p => !seen.has(p.id)).map(p => p.id) };
}
