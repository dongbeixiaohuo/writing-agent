import type { MaterialRecord, JsonValue } from '../../writing-core/src/index.js';
import type { SessionStore } from '../../runtime/session/src/index.js';

/** Small, already-authorized local inputs need no model/tool round trip.
 * Oversized inputs are not silently truncated or credited as fully supplied. */
export function inlineMaterialContext(materials: readonly MaterialRecord[]): JsonValue[] {
  let remaining = 12_000;
  return materials.flatMap(material => {
    const length = Array.from(material.content).length;
    if (length > 6_000 || length > remaining) return [];
    remaining -= length;
    return [{ materialId: material.id, contentVersionId: material.contentVersionId,
      displayName: material.displayName,
      content: material.content, offset: 0, nextOffset: length, totalChars: length, truncated: false,
      delivery: 'inline_full', role: material.role, trustLabel: material.trustLabel,
      sourceKind: material.sourceKind, instructionAuthority: 'none',
      permissionScope: material.permissionScope }];
  });
}

/** Only a dispatched, persisted request proves delivery, not catalogue presence
 * or a model's assertion. Compare exact bytes and versions against local data. */
export function deliveredInlineMaterialIds(storage: Pick<SessionStore, 'listRunEvents' | 'getRequestSnapshot'>,
  runId: string, materials: readonly MaterialRecord[]): string[] {
  const supplied = new Set<string>();
  // A lean later-stage request does not revoke a real earlier full delivery.
  // Credit only this run's dispatched snapshots and exact current versions.
  const dispatches = storage.listRunEvents(runId).filter(e => e.type === 'request.dispatch_attempted').reverse();
  for (const dispatch of dispatches) {
    if (supplied.size === materials.length) break;
    if (typeof dispatch.payload.snapshotId !== 'string') continue;
    const snapshot = storage.getRequestSnapshot(dispatch.payload.snapshotId);
    if (!snapshot || snapshot.runId !== runId) continue;
    for (const message of snapshot.request.messages) {
      if (message.role !== 'user') continue;
      const marker = '\nCOLLABORATION_STATE=';
      const offset = message.content.lastIndexOf(marker);
      if (offset < 0) continue;
      let state;
      try { state = JSON.parse(message.content.slice(offset + marker.length)); } catch { continue; }
      if (!Array.isArray(state?.materials)) continue;
      for (const item of state.materials) {
        const material = materials.find(m => m.id === item?.materialId);
        if (material && snapshot.projectId === material.projectId && item.delivery === 'inline_full' && item.contentVersionId === material.contentVersionId &&
          item.content === material.content && item.role === material.role && item.trustLabel === material.trustLabel &&
          item.sourceKind === material.sourceKind && item.instructionAuthority === 'none' && item.permissionScope === material.permissionScope &&
          item.offset === 0 && item.truncated === false && item.totalChars === Array.from(material.content).length &&
          item.nextOffset === item.totalChars) supplied.add(material.id);
      }
    }
  }
  return [...supplied];
}
