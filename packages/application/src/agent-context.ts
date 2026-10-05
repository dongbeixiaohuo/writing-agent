import type { BodyDocument, FactCheckStatusView, JsonValue } from '../../writing-core/src/index.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';
import { compactFactEvidence, factEvidenceCatalog } from './fact-context.js';

type HistoryItem = { sequence: number; role: string; content: string };
export interface AuthorContextState {
  currentBody: BodyDocument | null;
  history: readonly HistoryItem[];
  factCheck: FactCheckStatusView;
  [key: string]: unknown;
}

/** Projection, not a replacement for the persisted assessment or publication gate. */
export function factStatusContext(status: FactCheckStatusView, includeFindings = false) {
  const assessment = status.assessment;
  return { status: status.status, currentSnapshotId: status.currentSnapshotId,
    snapshot: status.snapshot,
    assessment: assessment ? { id: assessment.id, status: assessment.status,
      blockers: assessment.blockers, claimCount: assessment.payload.claims.length,
      coverage: assessment.payload.coverage,
      // Match the gate's status, scope AND risk rules; SUPPORTED alone does not
      // mean the finding is resolved. Preserve explicit legacy blockers too.
      ...(includeFindings ? { claims: assessment.payload.claims.filter(c => c.status !== 'SUPPORTED' ||
        c.supportScope !== 'full' || c.risk === 'red' || assessment.blockers.includes(c.claimId)),
        noFactualClaimsReason: assessment.payload.noFactualClaimsReason } : {}),
    } : null,
    invalidations: status.invalidations.map(i => ({ reason: i.reason, changedVersionId: i.changedVersionId })),
  };
}

/** Keep author decisions verbatim and the latest assistant exchanges. Older
 * assistant output remains addressable by sequence, never silently clipped. */
export function focusedHistory(history: readonly HistoryItem[], assistantCount = 2) {
  const latest = new Set(history.filter(item => item.role === 'assistant').slice(-assistantCount));
  return history.map(item => item.role === 'user' || latest.has(item) ? item : {
    sequence: item.sequence, role: item.role, characters: item.content.length,
    contentAvailableVia: 'read_conversation_history',
  });
}

export function authorContext(state: AuthorContextState, mode: 'intent' | 'discussion' | 'revision', role = 'director') {
  const body = state.currentBody;
  const currentBody = !body ? null : mode === 'intent' ? { versionId: body.versionId, characters: body.content.length }
    : mode === 'revision' ? { versionId: body.versionId, blocks: body.blocks.map(({ id, ordinal, kind, content }) => ({ id, ordinal, kind, content })) }
    : { versionId: body.versionId, content: body.content };
  const { factCheck, history, illustrationPlan, publicationCandidates, ...rest } = state;
  return { ...rest, currentBody, history: focusedHistory(history, mode === 'intent' ? 1 : 2),
    factCheck: factStatusContext(factCheck, mode !== 'intent' && role !== 'illustrator'),
    ...(mode === 'intent' || role === 'title' || role === 'director' ? { publicationCandidates } : {}),
    ...(mode === 'intent' ? { illustrationPlan: Array.isArray(illustrationPlan) ? illustrationPlan.map(plan => {
      const p = plan as Record<string, unknown>; return { id: p.id, status: p.status, bodyVersionId: p.bodyVersionId };
    }) : [] } : role === 'illustrator' || role === 'director' ? { illustrationPlan } : {}),
    contextAccess: 'Older conversation is readable by sequence; read_author_fact_check returns the full saved findings. Omitted data is not verified or supplied. Do not guess it.',
  };
}

/** Reference byte-identical content already supplied, never remove a user turn.
 * Older assistant text may be indexed only when the caller offers its reader. */
export function deduplicateReviewDiscussion(discussion: JsonValue, artifacts: readonly { id: string; content: unknown }[], materials: readonly JsonValue[] = [], focus = false): JsonValue {
  if (!Array.isArray(discussion)) return discussion;
  const latestAssistant = new Set(discussion.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.role === 'assistant').slice(-2));
  return discussion.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.content !== 'string') return item;
    const { content: _content, ...rest } = item;
    // Preserve the user turn and its position: a reference is not removal of
    // an approval/rejection. Only reference full text supplied in THIS request.
    const material = materials.find(m => m && typeof m === 'object' && !Array.isArray(m) &&
      typeof m.materialId === 'string' && typeof m.contentVersionId === 'string' &&
      m.content === item.content && m.offset === 0 && m.truncated === false && m.nextOffset === m.totalChars);
    if (material && typeof material === 'object' && !Array.isArray(material)) return { ...rest,
      contentFromMaterial: { materialId: material.materialId!, contentVersionId: material.contentVersionId! } };
    if (item.role !== 'assistant') return item;
    const artifact = artifacts.find(a => typeof a.content === 'string' && a.content === item.content);
    if (artifact) return { ...rest, contentFromArtifactId: artifact.id };
    if (focus && !latestAssistant.has(item) && typeof item.sequence === 'number') return { ...rest,
      characters: item.content.length, contentAvailableVia: 'read_review_discussion' };
    return item;
  });
}

type ContextArtifact = { id: string; kind: string; content: string };

/** Request-only projection. The persisted artifact, evidence IDs, confirmation
 * receipts and fact gate never change. Unknown/legacy ledgers stay intact. */
export function stageArtifactContext(actor: string, artifacts: readonly ContextArtifact[]) {
  const completeArtifactIds = new Set<string>();
  const projected = artifacts.map(artifact => {
    let content: JsonValue = artifact.content;
    if (artifact.kind === 'evidence') {
      if (actor === 'fact_check') return { ...artifact, content: factEvidenceCatalog(artifact.content) };
      content = compactFactEvidence(artifact.content);
      if (content && typeof content === 'object' && !Array.isArray(content) && Array.isArray(content.claims) &&
          content.claims.every(c => c && typeof c === 'object' && !Array.isArray(c))) {
        const { claims, ...ledger } = content;
        const rows = claims as Record<string, JsonValue>[];
        if (actor === 'director') {
          content = { projection: 'evidence_catalog', contentAvailableVia: 'read_artifact_version',
            claimCount: rows.length, evidenceIds: rows.map(c => c.evidence_id ?? null), notes: ledger.notes ?? null,
            instruction: '目录不含主张与引文；不据此作事实判断。需要具体事实时读取本版本，专家会独立接收所需证据。' };
        } else {
          const omitQuotes = actor === 'language_review' || actor.startsWith('review_') || actor === 'title';
          const fields = [...new Set(rows.flatMap(c => Object.keys(c)))].filter(key => !omitQuotes || key !== 'source_quote');
          // Columns remove repeated JSON keys, not claims or limitations. Missing
          // optional values map to null; all supplied values remain unchanged.
          content = { ...ledger, projection: 'evidence_table', claimFields: fields,
            claimRows: rows.map(c => fields.map(key => c[key] ?? null)),
            ...(omitQuotes ? { omittedFields: ['source_quote'], contentAvailableVia: 'read_artifact_version' } : {}) };
          if (!omitQuotes) completeArtifactIds.add(artifact.id);
        }
      } else completeArtifactIds.add(artifact.id);
    } else if (actor === 'director' && (artifact.kind === 'body' || artifact.kind === 'outline')) {
      content = { projection: 'artifact_catalog', characters: artifact.content.length,
        headings: artifact.content.split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)),
        contentAvailableVia: 'read_artifact_version' };
    } else if (artifact.kind === 'report') content = compactReworkReport(artifact.content);
    else completeArtifactIds.add(artifact.id);
    return { ...artifact, content };
  });
  return { artifacts: projected, completeArtifacts: artifacts.filter(a => completeArtifactIds.has(a.id)),
    needsArtifactAccess: artifacts.some(a => !completeArtifactIds.has(a.id)) };
}

/** Rework reports already contain the structured claims. Do not send the same
 * assessment again as a rendered report string, nor pass successful claims to
 * a director deciding which unresolved issue to route. */
export function compactReworkReport(content: string): string | JsonValue {
  try {
    const report = JSON.parse(content);
    if (!report?.revisionInput?.factCheck?.assessment?.payload?.claims) return content;
    return { ...report, revisionInput: { ...report.revisionInput,
      factCheck: factStatusContext(report.revisionInput.factCheck, true) } } as unknown as JsonValue;
  } catch { return content; }
}

/** Only replace an exact successful read with a pointer to content actually
 * supplied in this request. Never compact errors, omitted sources or old versions. */
export function projectInlineRead(message: ModelMessage, artifacts: readonly ContextArtifact[], materials: readonly JsonValue[], readableArtifacts: readonly ContextArtifact[] = []): string {
  if (message.role !== 'tool') return message.content;
  try {
    const envelope = JSON.parse(message.content);
    if (envelope.ok !== true || typeof envelope.result?.content !== 'string') return message.content;
    const result = envelope.result;
    let reference: string | undefined;
    if (message.name === 'read_artifact_version') {
      const artifact = artifacts.find(a => a.id === result.versionId && a.content === result.content);
      // report projections omit successful findings; they are NOT equivalent.
      if (artifact && artifact.kind !== 'report') reference = `COLLABORATION_STATE.artifacts[id=${artifact.id}]`;
    } else if (message.name === 'read_material') {
      const match = materials.find(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        return ['materialId', 'contentVersionId', 'offset', 'nextOffset', 'content', 'role', 'trustLabel', 'permissionScope']
          .every(key => item[key] === result[key]);
      });
      if (match) reference = `COLLABORATION_STATE.materials[materialId=${result.materialId},offset=${result.offset}]`;
    }
    if (!reference) {
      // A deliberately requested full read cannot point to a director/review
      // catalogue. Supply ALL evidence values, using the same lossless table
      // as the checker, without repeating canonical source/field keys.
      const evidence = message.name === 'read_artifact_version' ? readableArtifacts.find(a =>
        a.kind === 'evidence' && a.id === result.versionId && a.content === result.content) : undefined;
      if (evidence) {
        const content = stageArtifactContext('research', [evidence]).artifacts[0]!.content;
        if (typeof content !== 'string') return JSON.stringify({ ...envelope,
          result: { ...result, content, requestProjection: 'lossless_evidence_table' } });
      }
      return message.content;
    }
    const { content: _content, ...metadata } = result;
    return JSON.stringify({ ...envelope, result: { ...metadata, contentFrom: reference, requestProjection: 'duplicate_content_only' } });
  } catch { return message.content; }
}
