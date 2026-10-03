import type { BodyDocument, FactCheckStatusView, JsonValue } from '../../writing-core/src/index.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';

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

/** Remove only byte-identical assistant reports already present as artifacts.
 * A user's identical quote may be an approval/rejection, so never dedup users. */
export function deduplicateReviewDiscussion(discussion: JsonValue, artifacts: readonly { id: string; content: unknown }[]): JsonValue {
  if (!Array.isArray(discussion)) return discussion;
  return discussion.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.role !== 'assistant') return item;
    const artifact = artifacts.find(a => typeof a.content === 'string' && a.content === item.content);
    if (!artifact) return item;
    const { content: _content, ...rest } = item;
    return { ...rest, contentFromArtifactId: artifact.id };
  });
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
export function projectInlineRead(message: ModelMessage, artifacts: readonly { id: string; kind: string; content: string }[], materials: readonly JsonValue[]): string {
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
    if (!reference) return message.content;
    const { content: _content, ...metadata } = result;
    return JSON.stringify({ ...envelope, result: { ...metadata, contentFrom: reference, requestProjection: 'duplicate_content_only' } });
  } catch { return message.content; }
}
