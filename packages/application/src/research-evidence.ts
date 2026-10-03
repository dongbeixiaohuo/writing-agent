import { Ajv } from 'ajv';
import type { JsonValue } from '../../writing-core/src/index.js';

const text = { type: 'string', minLength: 1 } as const;

/** Transport-only compression. The persisted ledger and fact gate stay unchanged. */
export const COMPACT_RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
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
        reliability: { type: 'string', enum: ['high', 'medium', 'low'] }, use_boundary: text, verification_status: text },
      required: ['source_id', 'claim_type', 'claim_text', 'source_quote', 'reliability', 'use_boundary', 'verification_status'],
    } },
  },
  required: ['sources', 'claims', 'notes'],
} as const;

const validate = new Ajv({ allErrors: false }).compile(COMPACT_RESEARCH_SCHEMA);

/** Validate before expansion, including legacy clients that stringify the compact object. */
export function expandResearchEvidence(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('sources' in input)) return input;
  if (!validate(input)) throw new Error('Invalid compact research schema');
  const ledger = input as { sources: Record<string, JsonValue>[]; claims: Record<string, JsonValue>[]; notes: string };
  const sources = new Map<string, Record<string, JsonValue>>();
  for (const { source_id, ...source } of ledger.sources) {
    if (typeof source_id !== 'string' || !source_id.trim() || sources.has(source_id)) throw new Error('Duplicate or empty research source ID');
    sources.set(source_id, source);
  }
  // Explicit IDs are retained. Generated IDs never collide with them and are
  // deterministic across retries. No reliability/verification judgment is inferred.
  const ids = new Set(ledger.claims.flatMap(claim => typeof claim.evidence_id === 'string' ? [claim.evidence_id] : []));
  let nextId = 1;
  let expandedCharacters = JSON.stringify({ claims: [], notes: ledger.notes }).length;
  const claims = ledger.claims.map(({ source_id, ...claim }, index) => {
    const source = typeof source_id === 'string' ? sources.get(source_id) : undefined;
    if (!source) throw new Error('Unknown research source ID');
    let evidenceId = claim.evidence_id;
    if (evidenceId === undefined) {
      do { evidenceId = `E${String(nextId++).padStart(3, '0')}`; } while (ids.has(evidenceId));
      ids.add(evidenceId);
    }
    const expanded = { ...source, ...claim, evidence_id: evidenceId };
    expandedCharacters += JSON.stringify(expanded).length + (index > 0 ? 1 : 0);
    if (expandedCharacters > 1_000_000) throw new Error('Expanded research exceeds the supported size');
    return expanded;
  });
  return { claims, notes: ledger.notes };
}
