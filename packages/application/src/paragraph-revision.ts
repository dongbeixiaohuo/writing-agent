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

type Problem = { quote: string; paragraphIds?: readonly string[] | undefined };
export function paragraphRepairScope(content: string, findings: readonly Problem[]) {
  const paragraphs = articleParagraphs(content);
  const allowed = new Set(findings.flatMap(f => f.paragraphIds?.length ? f.paragraphIds : quoteParagraphIds(content, f.quote)));
  return { paragraphs: paragraphs.map(({ id, text, title }) => ({ id, text, editable: !title && allowed.has(id) })),
    editableParagraphIds: paragraphs.filter(p => !p.title && allowed.has(p.id)).map(p => p.id) };
}

const editSchema = z.strictObject({ baseBodyVersionId: z.string().min(1),
  edits: z.array(z.strictObject({ paragraphId: z.string().min(1), replacement: z.string().max(20_000) })).max(100) });
const { $schema: _schema, ...definition } = z.toJSONSchema(editSchema, { target: 'draft-07' });
export const PARAGRAPH_EDITS_SCHEMA = definition;

/** Apply to exact byte-equivalent JS string spans. Unaddressed content, title,
 * separators and paragraph order are owned by the application, not regenerated. */
export function applyParagraphEdits(content: string, bodyVersionId: string, value: unknown, findings: readonly Problem[]) {
  const fail = (message: string): never => { throw new ToolExecutionFault('PARAGRAPH_EDITS_INVALID', message, true); };
  const parsed = editSchema.safeParse(value);
  if (!parsed.success) return fail(parsed.error.issues[0]!.message);
  if (parsed.data.baseBodyVersionId !== bodyVersionId) return fail('Paragraph edits must bind the current body version.');
  const paragraphs = articleParagraphs(content);
  const allowed = new Set(paragraphRepairScope(content, findings).editableParagraphIds);
  const seen = new Set<string>();
  const changes = parsed.data.edits.map(edit => {
    const paragraph = paragraphs.find(p => p.id === edit.paragraphId);
    if (!paragraph || !allowed.has(edit.paragraphId) || seen.has(edit.paragraphId)) return fail('Edit only the listed problem paragraphs, once each; title and other paragraphs are protected.');
    if (/^#\s/mu.test(edit.replacement)) return fail('A paragraph edit cannot replace or add an article title.');
    seen.add(edit.paragraphId);
    return { ...paragraph, replacement: edit.replacement };
  });
  let result = content;
  for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.replacement + result.slice(change.end);
  return { content: result, changedParagraphIds: changes.filter(p => p.text !== p.replacement).map(p => p.id),
    untouchedParagraphIds: paragraphs.filter(p => !seen.has(p.id)).map(p => p.id) };
}
