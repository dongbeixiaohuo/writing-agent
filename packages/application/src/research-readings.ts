import { createHash } from 'node:crypto';
import type { ArtifactVersion, MaterialRecord } from '../../writing-core/src/index.js';
import type { SessionStore } from '../../runtime/session/src/index.js';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sourceKey(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; }
}

/** Keep the passages the researcher actually read. A claim table is an index,
 * not a replacement for the people, sequence and detail in the source. */
export function researchReadings(storage: Pick<SessionStore, 'listRunEvents'>, projectId: string, research: ArtifactVersion | null,
  materials: readonly MaterialRecord[] = [], includeAuthorizedSnapshots = false) {
  if (!research || research.projectId !== projectId || research.kind !== 'evidence' || research.actor.kind !== 'agent' ||
      research.actor.id !== 'writing-pack/researcher') return [];
  let ledger: Record<string, unknown> | null;
  try { ledger = object(JSON.parse(research.content)); } catch { return []; }
  const urls = new Set([...(Array.isArray(ledger?.sources) ? ledger.sources : []), ...(Array.isArray(ledger?.claims) ? ledger.claims : [])]
    .map(row => object(row)?.source_url).filter((url): url is string => typeof url === 'string').map(sourceKey));
  const runId = research.actor.runId;
  const events = storage.listRunEvents(runId).filter(e => e.projectId === projectId &&
    e.runId === runId && e.projectSeq < research.createdEventSeq);
  const requests = new Map(events.filter(e => e.type === 'tool.requested' && e.payload.actor === 'research' &&
    e.payload.toolName === 'read_fact_source').map(e => [e.operationId, e]));
  const passages: { url: string; finalUrl: string; text: string; bodyHash: string; truncated: boolean; instructionAuthority: 'none' }[] = [];
  const seen = new Set<string>();
  let remaining = 20_000;
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool.completed') continue;
    const request = requests.get(event.operationId), envelope = object(event.payload.result), result = object(envelope?.result);
    const url = object(request?.payload.arguments)?.url;
    if (!request || envelope?.ok !== true || envelope.toolName !== 'read_fact_source' || envelope.runId !== runId ||
        envelope.operationId !== event.operationId || envelope.callId !== event.payload.callId || request.payload.callId !== event.payload.callId ||
        request.payload.requestId !== event.payload.requestId || request.projectSeq >= event.projectSeq ||
        typeof url !== 'string' || !urls.has(sourceKey(url)) || seen.has(sourceKey(url)) || result?.requestedUrl !== url ||
        typeof result.finalUrl !== 'string' || typeof result.text !== 'string' || typeof result.bodyHash !== 'string' ||
        result.instructionAuthority !== 'none') continue;
    const text = result.text.slice(0, remaining);
    if (!text) continue;
    passages.push({ url, finalUrl: result.finalUrl, text, bodyHash: result.bodyHash,
      truncated: result.truncated === true || text.length !== result.text.length, instructionAuthority: 'none' });
    seen.add(sourceKey(url)); remaining -= text.length;
    if (!remaining || passages.length === 4) break;
  }
  passages.reverse();
  // For a confirmed direction, authorized snapshots remain usable even if
  // research left them out of the ledger. Other scopes use matched sources.
  for (const material of materials) {
    const url = material.sourceReference;
    if (material.projectId !== projectId || !url || (!includeAuthorizedSnapshots && !urls.has(sourceKey(url))) || seen.has(sourceKey(url)) ||
        !(material.sourceKind === 'web_snapshot' || material.role === 'source_verified') || !remaining || passages.length === 4) continue;
    const text = material.content.slice(0, remaining);
    if (!text) continue;
    passages.push({ url, finalUrl: url, text, bodyHash: createHash('sha256').update(material.content).digest('hex'),
      truncated: text.length !== material.content.length, instructionAuthority: 'none' });
    seen.add(sourceKey(url)); remaining -= text.length;
  }
  return passages;
}
