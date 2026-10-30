import { z } from "zod";

const BoundedText = (limit: number) => z.string().trim().min(1).max(limit);

export const STYLE_SAMPLE_LIMIT = 10;
export const STYLE_SAMPLE_CHARACTER_LIMIT = 100_000;
export const STYLE_TOTAL_CHARACTER_LIMIT = 300_000;
export const STYLE_SAMPLE_LIMIT_MESSAGE = `每次联合分析最多 ${STYLE_SAMPLE_LIMIT} 份样本（文档、网页和粘贴文字合计）。本次未添加，请减少所选内容后重试，或分组创建风格。`;
export const STYLE_IMPORT_ERRORS = {
  STYLE_SAMPLE_LIMIT_EXCEEDED: STYLE_SAMPLE_LIMIT_MESSAGE,
  STYLE_SOURCE_URL_INVALID: '请输入 HTTP 或 HTTPS 链接，每行一个；请移除非链接文字后重试。',
  STYLE_SAMPLE_DUPLICATE: '内容与已有样文重复，未重复添加。',
  STYLE_SAMPLE_TOTAL_TOO_LARGE: '样文总量超过 300,000 字符，本项未添加，请减少内容或分组分析。',
  STYLE_DOCUMENT_TOO_LARGE: '文档超过 4 MB，或正文超过 100,000 字符，请选取代表性内容。',
  STYLE_DOCUMENT_INVALID: '无法提取文档文字，请检查文件或直接粘贴正文。',
  STYLE_DOCUMENT_ENCODING: '文本编码无法识别，请另存为 UTF-8。',
  STYLE_DOCUMENT_TYPE: '支持 DOCX、TXT、MD；暂不支持 DOC、PDF 和扫描件。',
  STYLE_DOCUMENT_READ_FAILED: '文档读取失败，请检查文件是否可访问后重新选择。',
  STYLE_SOURCE_TOO_LARGE: '网页正文过长，请粘贴代表性内容。',
  STYLE_SOURCE_FAILED: '网页读取失败，可能是网络或网站访问限制；可重试或粘贴正文。',
} as const;
export type StyleImportError = keyof typeof STYLE_IMPORT_ERRORS;

export function ensureStyleSampleCapacity(existing: number, additional: number): void {
  if (existing + additional > STYLE_SAMPLE_LIMIT) throw new RangeError('STYLE_SAMPLE_LIMIT_EXCEEDED');
}

/** Only normalize transport-equivalent URLs, never discard article query parameters. */
export function normalizeStyleUrl(input: string): string {
  try {
    if (/\s/u.test(input.trim())) throw new Error();
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    url.hash = '';
    if (url.href.length > 2_048) throw new Error();
    return url.href;
  } catch { throw new Error('STYLE_SOURCE_URL_INVALID'); }
}

export const StyleSampleSchema = z.object({
  id: BoundedText(120),
  title: BoundedText(300),
  kind: z.enum(["text", "document", "web"]),
  sourceReference: z.string().trim().min(1).max(2_048).nullable(),
  text: BoundedText(STYLE_SAMPLE_CHARACTER_LIMIT),
}).strict();
export type StyleSample = z.infer<typeof StyleSampleSchema>;
export const StyleImportItemSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('loaded'), label: BoundedText(2_048), sample: StyleSampleSchema }).strict(),
  z.object({ status: z.literal('failed'), label: BoundedText(2_048), code: z.enum(Object.keys(STYLE_IMPORT_ERRORS) as [StyleImportError, ...StyleImportError[]]) }).strict(),
]);
export type StyleImportItem = z.infer<typeof StyleImportItemSchema>;
const SampleListSchema = z.array(StyleSampleSchema).min(1).max(STYLE_SAMPLE_LIMIT, 'STYLE_SAMPLE_LIMIT_EXCEEDED');

export const StyleRuleEvidenceSchema = z.object({
  sampleId: BoundedText(120),
  quote: BoundedText(1_200),
}).strict();
export const StyleRuleSchema = z.object({
  dimension: BoundedText(80),
  instruction: BoundedText(500),
  evidence: z.array(StyleRuleEvidenceSchema).min(1).max(STYLE_SAMPLE_LIMIT),
  confidence: z.enum(["sample", "recurring"]),
}).strict();
export const StyleDraftSchema = z.object({
  name: BoundedText(160),
  card: BoundedText(1_800),
  summary: BoundedText(800),
  rules: z.array(StyleRuleSchema).min(5).max(8),
  samples: SampleListSchema,
  sampleCount: z.number().int().min(1).max(STYLE_SAMPLE_LIMIT),
  analyzedCharacters: z.number().int().positive().max(STYLE_TOTAL_CHARACTER_LIMIT),
  totalCharacters: z.number().int().positive().max(STYLE_TOTAL_CHARACTER_LIMIT),
  elapsedMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1_000),
  modelRequests: z.literal(1),
}).strict();
export type StyleDraft = z.infer<typeof StyleDraftSchema>;

export const StyleProfileSchema = StyleDraftSchema.extend({
  id: BoundedText(120),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export const StyleProfileSummarySchema = z.object({
  id: BoundedText(120), name: BoundedText(160), version: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }), sampleCount: z.number().int().min(1).max(STYLE_SAMPLE_LIMIT), summary: BoundedText(800),
}).strict();
export type StyleProfileSummary = z.infer<typeof StyleProfileSummarySchema>;

export const StyleLibraryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("get"), id: BoundedText(120) }).strict(),
  z.object({ action: z.literal("analyze"), name: BoundedText(160), samples: SampleListSchema }).strict(),
  z.object({ action: z.literal("save"), id: BoundedText(120).nullable(), expectedVersion: z.number().int().positive().nullable(), draft: StyleDraftSchema }).strict(),
  z.object({ action: z.literal("delete"), id: BoundedText(120), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("source"), url: z.string().url().max(2_048) }).strict(),
  z.object({ action: z.literal('sources'), urls: z.array(z.string().url().max(2_048)).min(1).max(STYLE_SAMPLE_LIMIT, 'STYLE_SAMPLE_LIMIT_EXCEEDED'), remainingSlots: z.number().int().min(0).max(STYLE_SAMPLE_LIMIT).optional() }).strict(),
  // The host opens a native picker; this command intentionally carries no file
  // contents or profile payload across the application boundary.
  z.object({ action: z.literal("import"), remainingSlots: z.number().int().min(0).max(STYLE_SAMPLE_LIMIT).optional() }).strict(),
  z.object({ action: z.literal("preview"), card: BoundedText(1_800), topic: BoundedText(1_000) }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);
export type StyleLibraryCommand = z.infer<typeof StyleLibraryCommandSchema>;

export const StyleLibraryResultSchema = z.object({
  profiles: z.array(StyleProfileSummarySchema).max(50), draft: StyleDraftSchema.optional(), profile: StyleProfileSchema.optional(),
  sample: StyleSampleSchema.optional(), preview: BoundedText(4_000).optional(), cancelled: z.literal(true).optional(),
  items: z.array(StyleImportItemSchema).max(STYLE_SAMPLE_LIMIT).optional(),
}).strict();
export type StyleLibraryResult = z.infer<typeof StyleLibraryResultSchema>;

export interface StyleProfileReferenceInput {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly card: string;
}

/** Stable, bounded snapshot text for a selected profile in a writing brief. */
export function styleReferenceForProfile(profile: StyleProfileReferenceInput): string {
  const id = BoundedText(120).parse(profile.id);
  const version = z.number().int().positive().parse(profile.version);
  const name = BoundedText(160).parse(profile.name);
  const card = BoundedText(1_800).parse(profile.card);
  const prefix = `个人风格卡 · ${name} · ${id} · v${version}\n`;
  return `${prefix}${card.slice(0, Math.max(0, 2_100 - prefix.length))}`;
}

/** Normalize only transport noise; source text remains untrusted data. */
export function normalizeStyleSample(sample: StyleSample): StyleSample {
  return { ...sample, id: sample.id.trim(), title: sample.title.trim(), sourceReference: sample.sourceReference?.trim() ?? null,
    text: sample.text.replace(/\r\n?/gu, "\n").trim() };
}

/** Reject duplicate content and bounded aggregate input before it reaches a model. */
export function validateStyleSamples(input: unknown): StyleSample[] {
  if (Array.isArray(input)) ensureStyleSampleCapacity(0, input.length);
  const parsed = SampleListSchema.parse(input).map(normalizeStyleSample);
  const ids = new Set<string>(); const contents = new Set<string>(); let total = 0;
  for (const sample of parsed) {
    if (ids.has(sample.id)) throw new TypeError("STYLE_SAMPLE_ID_DUPLICATE");
    const signature = sample.text.replace(/\s+/gu, " ").toLocaleLowerCase();
    if (contents.has(signature)) throw new TypeError("STYLE_SAMPLE_DUPLICATE");
    ids.add(sample.id); contents.add(signature); total += sample.text.length;
  }
  if (total > STYLE_TOTAL_CHARACTER_LIMIT) throw new RangeError("STYLE_SAMPLE_TOTAL_TOO_LARGE");
  return parsed;
}
