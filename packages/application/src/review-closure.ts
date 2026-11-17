import { z } from 'zod';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import { articleParagraphs, quoteParagraphIds } from './paragraph-revision.js';

const nonBlank = z.string().regex(/\S/u, 'Expected non-blank text');
const recoverySchema = z.strictObject({
  route: z.enum(['research', 'discuss']),
  queries: z.array(nonBlank.max(128)).max(2),
  questions: z.array(nonBlank.max(400)).min(1).max(2),
});
const readingSchema = z.strictObject({
  verdict: z.enum(['delivered', 'revise', 'research', 'discuss']),
  takeaway: nonBlank.max(500),
  quote: nonBlank.max(900),
  reason: nonBlank.max(500),
  repairTarget: nonBlank.max(500),
  queries: z.array(nonBlank.max(128)).max(2),
  questions: z.array(nonBlank.max(400)).max(2),
});
const findingSchema = z.strictObject({
  quote: nonBlank.max(900),
  kind: z.enum(['attribution', 'inference', 'process_note', 'reader_value', 'other']),
  severity: z.enum(['required', 'suggestion']),
  issue: nonBlank.max(500),
  repairTarget: nonBlank.max(500),
  evidenceIds: z.array(nonBlank.max(200)).max(8),
  paragraphIds: z.array(nonBlank.max(30)).max(20).optional(),
  recovery: recoverySchema.optional(),
});
const findingsSchema = z.array(findingSchema).max(12);
const coldFindingsSchema = z.array(findingSchema.omit({ recovery: true }).extend({ evidenceIds: z.array(nonBlank).max(0) })).max(12);
const coldReadingSchema = readingSchema.extend({ verdict: z.enum(['delivered', 'revise']), queries: z.array(nonBlank).max(0), questions: z.array(nonBlank).max(0) });
const resolutionsSchema = z.array(z.strictObject({
  findingId: nonBlank.max(200),
  action: z.enum(['rewrite', 'remove', 'retain']),
  afterQuote: nonBlank.max(1_200).nullable(),
  reason: nonBlank.max(1_000),
})).max(100);
const auditSchema = z.strictObject({
  consistency: z.array(z.strictObject({ claim: nonBlank.max(900), against: nonBlank.max(900),
    verdict: z.enum(['consistent', 'conflict']), reason: nonBlank.max(500), repairTarget: nonBlank.max(500) })).max(8).optional(),
  reading: readingSchema.optional(),
  newFindings: findingsSchema,
  checks: z.array(z.strictObject({
    findingId: nonBlank.max(200),
    verdict: z.enum(['resolved', 'unresolved', 'not_applicable']),
    quote: nonBlank.max(1_200).nullable(),
    reason: nonBlank.max(1_000),
  })).max(100),
});

function toolSchema(schema: z.ZodType) {
  const { $schema, ...definition } = z.toJSONSchema(schema, { target: 'draft-07' });
  return definition;
}

// Paragraph IDs are application-owned anchors. Saved reports may contain them,
// but reviewers receive prose, not a stable paragraph numbering across versions.
const publicFindingsSchema = z.array(findingSchema.omit({ paragraphIds: true })).max(12);
export const JSON_SCHEMA = toolSchema(publicFindingsSchema);
export const COLD_FINDINGS_JSON_SCHEMA = toolSchema(z.array(coldFindingsSchema.element.omit({ paragraphIds: true })).max(12));
export const COLD_READING_JSON_SCHEMA = toolSchema(coldReadingSchema);
export const READING_JSON_SCHEMA = { ...toolSchema(readingSchema), allOf: [{
  if: { properties: { verdict: { enum: ['delivered', 'revise'] } }, required: ['verdict'] },
  then: { properties: { queries: { type: 'array', maxItems: 0 }, questions: { type: 'array', maxItems: 0 } } },
}] };
export const RESOLUTIONS_JSON_SCHEMA = toolSchema(resolutionsSchema);
const auditDefinition = toolSchema(auditSchema.extend({ newFindings: publicFindingsSchema }));
export const REVISION_AUDIT_JSON_SCHEMA = { ...auditDefinition,
  properties: { ...auditDefinition.properties, reading: READING_JSON_SCHEMA } };

export type ReviewFinding = z.infer<typeof findingSchema>;
export type ReadingAssessment = z.infer<typeof readingSchema>;
export type BoundReviewFinding = ReviewFinding & {
  readonly id: string;
  readonly bodyVersionId: string;
  readonly reviewVersionId: string;
};

export function needsArticleRedevelopment(findings: readonly ReviewFinding[]): boolean {
  return findings.some(finding => finding.kind === 'reader_value' && finding.severity === 'required');
}

type ContractError = 'REVIEW_FINDINGS_INVALID' | 'REVIEW_RESOLUTIONS_INVALID' | 'REVISION_AUDIT_INVALID';

function invalid(code: ContractError, correction: string, field: string, findingId?: string): never {
  throw new ToolExecutionFault(code, correction, true, { field, correction, ...(findingId === undefined ? {} : { findingId }) });
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown, code: ContractError, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = [field, ...issue.path.map(String)].join('.');
    invalid(code, `${path}: ${issue.message}. Submit the full structured field again.`, path);
  }
  return parsed.data;
}

function assertFindingQuotes(findings: readonly ReviewFinding[], content: string, evidenceIds: ReadonlySet<string>,
  code: ContractError, field: string): void {
  for (const [index, finding] of findings.entries()) {
    if (finding.recovery?.route === 'research' && !finding.recovery.queries.length) {
      invalid(code, 'Research recovery needs a focused query.', `${field}.${index}.recovery.queries`);
    }
    if (!content.includes(finding.quote)) {
      invalid(code, 'Copy quote verbatim as a contiguous passage from the article bound to this request.', `${field}.${index}.quote`);
    }
    if (finding.paragraphIds?.some(id => !articleParagraphs(content).some(p => p.id === id))) {
      invalid(code, 'Use paragraph IDs from the current article only.', `${field}.${index}.paragraphIds`);
    }
    const unknownId = finding.evidenceIds.find(id => !evidenceIds.has(id));
    if (unknownId !== undefined) {
      invalid(code, `Evidence ID ${unknownId} is not bound to this request. Use an existing ID or leave evidenceIds empty.`, `${field}.${index}.evidenceIds`);
    }
  }
}

function matchFindings(rows: readonly { findingId: string }[], findings: readonly BoundReviewFinding[], code: ContractError, field: string) {
  const bound = new Map(findings.map(finding => [finding.id, finding]));
  const seen = new Set<string>();
  for (const [index, { findingId }] of rows.entries()) {
    if (!bound.has(findingId)) invalid(code, `Finding ${findingId} is not bound to this request. Use only the supplied finding IDs.`, `${field}.${index}.findingId`, findingId);
    if (seen.has(findingId)) invalid(code, `Finding ${findingId} was submitted twice. Submit exactly one entry for each finding.`, `${field}.${index}.findingId`, findingId);
    seen.add(findingId);
  }
  const missing = findings.find(finding => !seen.has(finding.id));
  if (missing) invalid(code, `Finding ${missing.id} is missing. Submit exactly one entry for each finding.`, field, missing.id);
  return bound;
}

export function parseReadingAssessment(value: unknown, body: string, code: ContractError = 'REVIEW_FINDINGS_INVALID', blind = false): ReadingAssessment {
  const reading: ReadingAssessment = blind ? parseContract(coldReadingSchema, value, code, 'reading')
    : parseContract(readingSchema, value, code, 'reading');
  if (!body.includes(reading.quote)) invalid(code, 'Reading assessment must anchor the actual article, not the review prose.', 'reading.quote');
  if (reading.verdict === 'research' && !reading.queries.length) invalid(code, 'Missing core material requires a focused research query.', 'reading.queries');
  if (['research', 'discuss'].includes(reading.verdict) && !reading.questions.length) invalid(code, 'Give a concrete author question when the original promise cannot be repaired.', 'reading.questions');
  if (['delivered', 'revise'].includes(reading.verdict) && (reading.queries.length || reading.questions.length)) invalid(code, 'Unresolved research or direction questions require verdict research or discuss. For a genuinely local revision or delivered article, queries and questions must both be empty arrays.', 'reading.verdict');
  return reading;
}

function readingFinding(reading: ReadingAssessment): ReviewFinding | null {
  return reading.verdict === 'delivered' ? null : {
    kind: 'reader_value', severity: 'required', quote: reading.quote,
    // The quoted moment may be a strength. The unmet reading objective, not
    // praise for that moment, is the problem the next reviewer must assess.
    issue: reading.repairTarget, repairTarget: reading.repairTarget, evidenceIds: [],
    ...(['research', 'discuss'].includes(reading.verdict) ? { recovery: {
      route: reading.verdict as 'research' | 'discuss', queries: reading.queries, questions: reading.questions,
    } } : {}),
  };
}

export function validateReviewFindings(value: unknown, body: string, evidenceIds: ReadonlySet<string>, reading?: ReadingAssessment): ReviewFinding[] {
  const findings = parseContract(findingsSchema, value, 'REVIEW_FINDINGS_INVALID', 'findings');
  const valueFinding = reading && readingFinding(reading);
  if (valueFinding) findings.push(valueFinding);
  assertFindingQuotes(findings, body, evidenceIds, 'REVIEW_FINDINGS_INVALID', 'findings');
  return findings;
}

export function validateColdReviewFindings(value: unknown, body: string, reading?: ReadingAssessment): ReviewFinding[] {
  return validateReviewFindings(parseContract(coldFindingsSchema, value, 'REVIEW_FINDINGS_INVALID', 'findings'), body, new Set(), reading);
}

export function parseReviewResolutions(value: unknown, findings: readonly BoundReviewFinding[], content: string) {
  const code = 'REVIEW_RESOLUTIONS_INVALID';
  const resolutions = parseContract(resolutionsSchema, value, code, 'resolutions');
  const bound = matchFindings(resolutions, findings, code, 'resolutions');
  for (const [index, { findingId, action, afterQuote }] of resolutions.entries()) {
    const originalQuote = bound.get(findingId)!.quote;
    const field = `resolutions.${index}.afterQuote`;
    if (action === 'rewrite' && afterQuote?.trim() === originalQuote.trim()) {
      invalid(code, 'The quoted passage is unchanged. For rewrite it must differ from the original: quote the actual changed surrounding passage if the repair is there. If deliberately keeping the original, use retain and explain the disagreement; do not label unchanged text rewrite.', field, findingId);
    }
    if (action === 'rewrite' && (afterQuote === null || !content.includes(afterQuote))) {
      invalid(code, 'afterQuote is absent from the submitted article. For rewrite, copy the changed passage verbatim from content; do not paraphrase or describe the intended edit.', field, findingId);
    }
    if (action === 'remove' && (afterQuote !== null || content.includes(originalQuote))) {
      invalid(code, 'For remove, set afterQuote to null and remove the original passage from the revised article.', field, findingId);
    }
    if (action === 'retain' && (afterQuote !== originalQuote || !content.includes(originalQuote))) {
      invalid(code, 'For retain, supply the unchanged original quote, still present in the revised article, and explain why it should remain.', field, findingId);
    }
  }
  return resolutions;
}

export function parseRevisionAudit(value: unknown, findings: readonly BoundReviewFinding[], content: string, evidenceIds: ReadonlySet<string>,
  currentRevisionContent?: string, requireReading = false) {
  const code = 'REVISION_AUDIT_INVALID';
  const audit = parseContract(auditSchema, value, code, 'audit');
  const currentArticle = currentRevisionContent ?? content;
  for (const [index, check] of (audit.consistency ?? []).entries()) {
    if (check.claim === check.against || !currentArticle.includes(check.claim) || !currentArticle.includes(check.against)) {
      invalid(code, 'Compare two distinct verbatim passages of the current article.', `audit.consistency.${index}`);
    }
    if (check.verdict === 'conflict') audit.newFindings.push({ kind: 'inference', severity: 'required', quote: check.claim,
      issue: `${check.reason}\n另一处原文：${check.against}`, repairTarget: check.repairTarget, evidenceIds: [],
      paragraphIds: [...new Set([...quoteParagraphIds(currentArticle, check.claim), ...quoteParagraphIds(currentArticle, check.against)])] });
  }
  if (requireReading && !audit.reading) invalid(code, 'Independently assess the final reading payoff, even when factual issues were fixed.', 'audit.reading');
  const valueFinding = audit.reading && readingFinding(audit.reading);
  if (valueFinding) audit.newFindings.push(valueFinding);
  const bound = matchFindings(audit.checks, findings, code, 'audit.checks');
  const requiresRevision = audit.checks.some(check => check.verdict === 'unresolved' && bound.get(check.findingId)?.severity === 'required') ||
    audit.newFindings.some(finding => finding.severity === 'required');
  const auditedContent = requiresRevision ? currentRevisionContent ?? content : content;
  if (audit.reading) parseReadingAssessment(audit.reading, auditedContent, code);
  for (const [index, { findingId, verdict, quote }] of audit.checks.entries()) {
    const finding = bound.get(findingId)!;
    const field = `audit.checks.${index}.quote`;
    if (quote !== null && !auditedContent.includes(quote)) {
      invalid(code, requiresRevision
        ? 'For a return, copy the audit quote verbatim from the bound central revision. Use null when there is no applicable passage.'
        : 'Copy the audit quote verbatim from the article being submitted. Use null when there is no applicable passage.', field, findingId);
    }
    if (finding.severity === 'required' && verdict === 'resolved' &&
        (quote === finding.quote || quote === null && auditedContent.includes(finding.quote))) {
      invalid(code, 'Quote the changed passage or a larger verbatim context that shows how the original issue was addressed. If the finding does not apply, use not_applicable and explain why.', field, findingId);
    }
  }
  assertFindingQuotes(audit.newFindings, auditedContent, evidenceIds, code, 'audit.newFindings');
  // New work is always anchored to this audited version, including the reading
  // objective that the reviewer may have returned outside newFindings.
  for (const finding of audit.newFindings) if (!finding.paragraphIds?.length) finding.paragraphIds = quoteParagraphIds(auditedContent, finding.quote);
  return { ...audit, requiresRevision };
}
