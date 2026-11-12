import { z } from 'zod';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';

const nonBlank = z.string().regex(/\S/u, 'Expected non-blank text');
const findingSchema = z.strictObject({
  quote: nonBlank.max(900),
  kind: z.enum(['attribution', 'inference', 'process_note', 'reader_value', 'other']),
  severity: z.enum(['required', 'suggestion']),
  issue: nonBlank.max(500),
  repairTarget: nonBlank.max(500),
  evidenceIds: z.array(nonBlank.max(200)).max(8),
});
const findingsSchema = z.array(findingSchema).max(12);
const resolutionsSchema = z.array(z.strictObject({
  findingId: nonBlank.max(200),
  action: z.enum(['rewrite', 'remove', 'retain']),
  afterQuote: nonBlank.max(1_200).nullable(),
  reason: nonBlank.max(1_000),
})).max(100);
const auditSchema = z.strictObject({
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

export const JSON_SCHEMA = toolSchema(findingsSchema);
export const RESOLUTIONS_JSON_SCHEMA = toolSchema(resolutionsSchema);
export const REVISION_AUDIT_JSON_SCHEMA = toolSchema(auditSchema);

export type ReviewFinding = z.infer<typeof findingSchema>;
export type BoundReviewFinding = ReviewFinding & {
  readonly id: string;
  readonly bodyVersionId: string;
  readonly reviewVersionId: string;
};

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
    if (!content.includes(finding.quote)) {
      invalid(code, 'Copy quote verbatim as a contiguous passage from the article bound to this request.', `${field}.${index}.quote`);
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

export function validateReviewFindings(value: unknown, body: string, evidenceIds: ReadonlySet<string>): ReviewFinding[] {
  const findings = parseContract(findingsSchema, value, 'REVIEW_FINDINGS_INVALID', 'findings');
  assertFindingQuotes(findings, body, evidenceIds, 'REVIEW_FINDINGS_INVALID', 'findings');
  return findings;
}

export function parseReviewResolutions(value: unknown, findings: readonly BoundReviewFinding[], content: string) {
  const code = 'REVIEW_RESOLUTIONS_INVALID';
  const resolutions = parseContract(resolutionsSchema, value, code, 'resolutions');
  const bound = matchFindings(resolutions, findings, code, 'resolutions');
  for (const [index, { findingId, action, afterQuote }] of resolutions.entries()) {
    const originalQuote = bound.get(findingId)!.quote;
    const field = `resolutions.${index}.afterQuote`;
    if (action === 'rewrite' && (afterQuote === null || afterQuote.trim() === originalQuote.trim() || !content.includes(afterQuote))) {
      invalid(code, 'For rewrite, quote the changed passage verbatim from the revised article. It must differ from the original passage.', field, findingId);
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
  currentRevisionContent?: string) {
  const code = 'REVISION_AUDIT_INVALID';
  const audit = parseContract(auditSchema, value, code, 'audit');
  const bound = matchFindings(audit.checks, findings, code, 'audit.checks');
  const requiresRevision = audit.checks.some(check => check.verdict === 'unresolved' && bound.get(check.findingId)?.severity === 'required') ||
    audit.newFindings.some(finding => finding.severity === 'required');
  const auditedContent = requiresRevision ? currentRevisionContent ?? content : content;
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
  return { ...audit, requiresRevision };
}
