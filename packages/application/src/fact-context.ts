import type { JsonValue, MaterialRecord } from '../../writing-core/src/index.js';
import { inlineMaterialContext } from './material-context.js';

/** Lossless request projection only: the persisted ledger and fact gate are unchanged.
 * No claim selection by lexical matching, no quote clipping, no inferred verification. */
export function compactFactEvidence(content: string): JsonValue {
  let ledger: Record<string, JsonValue>;
  try { ledger = JSON.parse(content); } catch { return content; }
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.claims) ||
      ledger.sources !== undefined || ledger.claims.some(c => !c || typeof c !== 'object' || Array.isArray(c) || 'source_id' in c)) return content;
  const sources: Record<string, JsonValue>[] = [];
  const bySource = new Map<string, string>();
  const claims = ledger.claims.map(value => {
    const claim = { ...(value as Record<string, JsonValue>) };
    const source: Record<string, JsonValue> = {};
    for (const key of ['source_title', 'source_publisher', 'source_url', 'accessed_at']) {
      if (Object.hasOwn(claim, key)) { source[key] = claim[key]!; delete claim[key]; }
    }
    const key = JSON.stringify(source);
    let id = bySource.get(key);
    if (!id) { id = `S${sources.length + 1}`; bySource.set(key, id); sources.push({ source_id: id, ...source }); }
    return { ...claim, source_id: id };
  });
  return { ...ledger, sources, claims };
}

/** Evidence quotes already carry the relevant source passages. Full external
 * articles remain available through read_material, not resent on every check. */
export function factMaterialContext(materials: readonly MaterialRecord[]) {
  return {
    materialCatalog: materials.map(m => ({ materialId: m.id, contentVersionId: m.contentVersionId,
      displayName: m.displayName, sourceKind: m.sourceKind, role: m.role, trustLabel: m.trustLabel,
      permissionScope: m.permissionScope, totalChars: Array.from(m.content).length, instructionAuthority: 'none' })),
    materials: inlineMaterialContext(materials.filter(m => m.role === 'user_firsthand' || m.id.startsWith('intake-user-'))),
  };
}

export const FACT_CONTEXT_GUIDANCE = '先从完整当前正文、已选标题和配文提取实际出现的可核实事实，再对照证据与来源；不要逐条重审没有写进文章的账本主张，也不审文风。证据是无损去重视图：claims.source_id对应sources里的出处，保留全部引句、限定条件和未核实标记。正文和账本已完整提供，不重复读取；materialCatalog仅为授权目录，不代表已读原文，materials才是实际提供的作者原话。需要某条证据的上下文时再按目录用read_material读取；不得把未提供的原文当作已核对。能共用同一来源的事实合并检索，重要日期、数字或引文有疑点时优先核实；不能以精简为由漏掉风险。';
