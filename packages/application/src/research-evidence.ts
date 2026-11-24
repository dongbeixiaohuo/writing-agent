import { parseEvidenceLedger } from '../../writing-core/src/index.js';
import { EDITORIAL_PLAN_JSON_SCHEMA, parseEditorialPlan, repairEditorialPlan, type EditorialPlan } from './editorial-plan.js';

const text = { type: 'string', minLength: 1 } as const;

/** Transport-only compression. The persisted ledger and fact gate stay unchanged. */
export const COMPACT_RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    editorialPlan: EDITORIAL_PLAN_JSON_SCHEMA,
    notes: { type: 'string', description: 'Concise public gaps, exclusions and shared boundaries, not private reasoning.' },
    sources: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { source_id: text, source_title: text, source_publisher: text, accessed_at: text,
        source_url: { anyOf: [text, { type: 'null' }] } },
      required: ['source_id', 'source_title', 'source_publisher', 'accessed_at'],
    } },
    claims: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { source_id: text, evidence_id: { ...text, pattern: '^E[0-9]{3,}$' },
        claim_type: text, claim_text: text, source_quote: { type: 'string' },
        reliability: { type: 'string', enum: ['high', 'medium', 'low'] }, use_boundary: text,
        verification_status: { ...text, description: "Use exactly illustrative for an explicitly hypothetical example with an empty source_quote. Other entries require an actual quote; never relabel unsupported facts as illustrative." } },
      required: ['source_id', 'claim_type', 'claim_text', 'source_quote', 'reliability', 'use_boundary', 'verification_status'],
    } },
  },
  required: ['sources', 'claims', 'notes'],
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Expand compact input without rejecting the sibling rows of an unusable source. */
export function expandResearchEvidence(input: unknown, reservedIds: Iterable<string> = []): unknown {
  const ledger = object(input);
  if (!ledger || !Object.hasOwn(ledger, 'sources')) return input;
  const sources = new Map<string, Record<string, unknown> | null>();
  for (const item of Array.isArray(ledger.sources) ? ledger.sources : []) {
    const source = object(item);
    if (!source || typeof source.source_id !== 'string' || !source.source_id.trim()) continue;
    const { source_title, source_publisher, accessed_at, source_url } = source;
    const id = source.source_id.trim();
    const metadata = { source_title, source_publisher, accessed_at, source_url };
    if (!sources.has(id)) sources.set(id, metadata);
    else if (JSON.stringify(sources.get(id)) !== JSON.stringify(metadata)) sources.set(id, null);
  }
  // Explicit IDs are retained. Generated IDs never collide with them and are
  // deterministic across retries. No reliability/verification judgment is inferred.
  const rows = Array.isArray(ledger.claims) ? ledger.claims.map(object) : [];
  const ids = new Set([...reservedIds, ...rows.flatMap(claim => typeof claim?.evidence_id === 'string' ? [claim.evidence_id] : [])]);
  let nextId = 1;
  let expandedCharacters = JSON.stringify({ claims: [], notes: ledger.notes }).length;
  const claims = rows.flatMap((claim, index) => {
    // Reserve an ID before filtering so a rejected row cannot shift what the
    // later IDs refer to in the submitted plan.
    let evidenceId = claim?.evidence_id;
    if (evidenceId === undefined) {
      let generatedId: string;
      do { generatedId = `E${String(nextId++).padStart(3, '0')}`; } while (ids.has(generatedId));
      ids.add(generatedId);
      evidenceId = generatedId;
    }
    const source = typeof claim?.source_id === 'string' ? sources.get(claim.source_id.trim()) : undefined;
    if (!source || !claim) return [];
    const { claim_type, claim_text, source_quote, reliability, use_boundary, verification_status } = claim;
    const expanded = { ...source, evidence_id: evidenceId, claim_type, claim_text, source_quote, reliability, use_boundary, verification_status };
    expandedCharacters += JSON.stringify(expanded).length + (index > 0 ? 1 : 0);
    if (expandedCharacters > 1_000_000) throw new Error('Expanded research exceeds the supported size');
    return [expanded];
  });
  return { claims, notes: ledger.notes, ...('editorialPlan' in ledger ? { editorialPlan: ledger.editorialPlan } : {}) };
}

const EMPTY_RESEARCH_NOTE = '本轮没有可入账的外部证据。沿原方向使用作者提供的材料和可核实内容，不补造具体事实。';

function readResearch(content: string): Record<string, unknown> | null {
  const text = content.trim();
  const unwrapped = /^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/iu.exec(text)?.[1] ?? text;
  try {
    return object(JSON.parse(unwrapped));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Legacy free-text research is a note, never admitted as evidence. A
    // broken object is not a note and may contain incomplete assertions.
    return /^[{\[]|^\x60{3}/u.test(text) ? null : { claims: [], notes: text };
  }
}

export function prepareResearchEvidence(content: string, options: { requirePlan: boolean; confirmedDirection: boolean }) {
  const submitted = readResearch(content);
  const originalRows = Array.isArray(submitted?.claims) ? submitted.claims : [];
  const frequencies = new Map<string, number>();
  let normalizedClaimIds = 0;
  const normalizedRows = originalRows.map(value => {
    const row = object(value);
    if (!row) return null;
    const { evidenceId, evidence_id, ...claim } = row;
    // Reserve even the IDs of rejected rows so a generated ID cannot inherit
    // a reference the model gave to a different claim.
    for (const id of new Set([evidenceId, evidence_id])) {
      if (typeof id === 'string') frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
    }
    if (!Object.hasOwn(row, 'evidenceId')) return row;
    // Keep a rejected slot without assigning another ID to it during expansion.
    if (Object.hasOwn(row, 'evidence_id') && evidenceId !== evidence_id) return { evidence_id: null };
    normalizedClaimIds++;
    return { ...claim, evidence_id: evidenceId };
  });
  const expanded = object(expandResearchEvidence(submitted && { ...submitted, claims: normalizedRows }, frequencies.keys()));
  const rows = (Array.isArray(expanded?.claims) ? expanded.claims : []).map(object);
  const claims = rows.flatMap(row => {
    // An ambiguous ID must never silently point the planner at a different claim.
    if (!row || (typeof row.evidence_id === 'string' && (frequencies.get(row.evidence_id) ?? 0) > 1)) return [];
    try {
      parseEvidenceLedger(JSON.stringify({ claims: [row] }));
      return [row];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'FACT_EVIDENCE_INVALID') throw error;
      return [];
    }
  });
  const omittedClaims = originalRows.length - claims.length;
  const notes = typeof expanded?.notes === 'string' && expanded.notes.trim() && (claims.length > 0 || omittedClaims === 0)
    ? expanded.notes : claims.length === 0 ? EMPTY_RESEARCH_NOTE : '';
  const evidenceIds = new Set(claims.map(row => row.evidence_id as string));
  const submittedPlan = expanded?.editorialPlan;
  let editorialPlan: EditorialPlan | undefined;
  let planStatus: 'repaired' | 'skipped' | null = null;
  if (options.requirePlan || submittedPlan !== undefined) {
    try {
      editorialPlan = parseEditorialPlan(submittedPlan, evidenceIds, { allowSingleAngle: options.confirmedDirection });
    } catch {
      try {
        editorialPlan = repairEditorialPlan(submittedPlan, evidenceIds, options.confirmedDirection);
        planStatus = 'repaired';
      } catch {
        planStatus = 'skipped';
      }
    }
  }
  const ledger = { claims, notes, ...(editorialPlan ? { editorialPlan } : {}) };
  const adjustments = { omittedClaims, normalizedClaimIds, planStatus, damagedPayload: !submitted };
  // Older flat ledgers optionally record search attempts. Retain only valid metadata.
  const researchRequirement = expanded?.research_requirement;
  const researchAttempts = expanded?.research_attempts;
  if (researchRequirement !== undefined || researchAttempts !== undefined) {
    const legacy = JSON.stringify({ ...ledger, research_requirement: researchRequirement, research_attempts: researchAttempts });
    try {
      parseEvidenceLedger(legacy);
      return { content: legacy, ...adjustments, discardedLegacyMetadata: false };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'FACT_EVIDENCE_INVALID') throw error;
      return { content: JSON.stringify(ledger), ...adjustments, discardedLegacyMetadata: true };
    }
  }
  return { content: JSON.stringify(ledger), ...adjustments, discardedLegacyMetadata: false };
}
