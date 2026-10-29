import { z } from "zod";

const BoundedText = (limit: number) => z.string().trim().min(1).max(limit);

export const STYLE_SAMPLE_LIMIT = 6;
export const STYLE_SAMPLE_CHARACTER_LIMIT = 100_000;
export const STYLE_TOTAL_CHARACTER_LIMIT = 300_000;

export const StyleSampleSchema = z.object({
  id: BoundedText(120),
  title: BoundedText(300),
  kind: z.enum(["text", "document", "web"]),
  sourceReference: z.string().trim().min(1).max(2_048).nullable(),
  text: BoundedText(STYLE_SAMPLE_CHARACTER_LIMIT),
}).strict();
export type StyleSample = z.infer<typeof StyleSampleSchema>;

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
  samples: z.array(StyleSampleSchema).min(1).max(STYLE_SAMPLE_LIMIT),
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
  z.object({ action: z.literal("analyze"), name: BoundedText(160), samples: z.array(StyleSampleSchema).min(1).max(STYLE_SAMPLE_LIMIT) }).strict(),
  z.object({ action: z.literal("save"), id: BoundedText(120).nullable(), expectedVersion: z.number().int().positive().nullable(), draft: StyleDraftSchema }).strict(),
  z.object({ action: z.literal("delete"), id: BoundedText(120), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("source"), url: z.string().url().max(2_048) }).strict(),
  // The host opens a native picker; this command intentionally carries no file
  // contents or profile payload across the application boundary.
  z.object({ action: z.literal("import") }).strict(),
  z.object({ action: z.literal("preview"), card: BoundedText(1_800), topic: BoundedText(1_000) }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);
export type StyleLibraryCommand = z.infer<typeof StyleLibraryCommandSchema>;

export const StyleLibraryResultSchema = z.object({
  profiles: z.array(StyleProfileSummarySchema).max(50), draft: StyleDraftSchema.optional(), profile: StyleProfileSchema.optional(),
  sample: StyleSampleSchema.optional(), preview: BoundedText(4_000).optional(), cancelled: z.literal(true).optional(),
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
  const parsed = z.array(StyleSampleSchema).min(1).max(STYLE_SAMPLE_LIMIT).parse(input).map(normalizeStyleSample);
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
