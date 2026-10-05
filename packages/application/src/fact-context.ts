import type { JsonValue, MaterialRecord, StoragePort } from '../../writing-core/src/index.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';
import type { SessionStore } from '../../runtime/session/src/index.js';
import { ToolExecutionFault, type ToolDefinition } from '../../runtime/tools/src/index.js';
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

/** Claim index, NOT proof: keep claim text and limitations, fetch exact quotes
 * only for facts actually in the article. Never select evidence by word overlap. */
function factLedger(content: string): Record<string, JsonValue> | null {
  try {
    const compact = compactFactEvidence(content);
    const value = typeof compact === 'string' ? JSON.parse(compact) : compact;
    return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.claims) &&
      value.claims.every((c: unknown) => c && typeof c === 'object' && !Array.isArray(c)) ? value : null;
  } catch { return null; }
}

export function factEvidenceCatalog(content: string): JsonValue {
  const ledger = factLedger(content);
  if (!ledger || !Array.isArray(ledger.claims)) {
    return { projection: 'fact_evidence_catalog', legacyLedger: true, characters: content.length,
      contentAvailableVia: 'read_fact_evidence', instruction: '旧格式账本未提供全文；按需读取，不得猜测引文。' };
  }
  const fields = ['evidence_id', 'claim_type', 'claim_text', 'source_id', 'reliability', 'use_boundary', 'verification_status'];
  return { projection: 'fact_evidence_catalog', claimFields: fields,
    claimRows: ledger.claims.map(c => fields.map(k => (c as Record<string, JsonValue>)[k] ?? null)),
    sources: ledger.sources ?? [], omittedFields: ['source_quote', 'notes', 'other_ledger_fields'],
    contentAvailableVia: 'read_fact_evidence', instruction: '索引不是原文，不代表已核实；正文中需要核实的条目再按编号取完整引文和来源。' };
}

type FactArtifact = { id: string; kind: string; content: string };
export type FactBinding = { body: FactArtifact; evidence: FactArtifact; titleVersionId: string | null; finalTitle?: string | undefined; distributionCopy?: string | undefined };
type PreparedClaim = { claimId: string; claimText: string; articleQuote: string; location: 'body' | 'title' | 'distributionCopy'; matchedEvidenceIds: string[] };
export type FactPreparation = { bodyVersionId: string; evidenceVersionId: string; titleVersionId: string | null; preparationId: string;
  claims: PreparedClaim[]; noFactualClaimsReason: string };
type FactStore = StoragePort & Pick<SessionStore, 'listRunEvents'>;

/** Persist extraction, not a fact conclusion. Reopening a bridge/run can reuse
 * it only while the article, evidence and publication choice are unchanged. */
export function factPreparation(storage: Pick<SessionStore, 'listRunEvents'>, runId: string, binding: FactBinding | null): FactPreparation | null {
  if (!binding) return null;
  const event = storage.listRunEvents(runId).findLast(e => e.type === 'tool.completed' && (e.payload.result as any)?.ok === true && (e.payload.result as any)?.toolName === 'prepare_fact_check');
  const saved = (event?.payload.result as any)?.result as FactPreparation | undefined;
  return saved && saved.bodyVersionId === binding.body.id && saved.evidenceVersionId === binding.evidence.id &&
    saved.titleVersionId === binding.titleVersionId ? saved : null;
}

export function factSubmissionCoversPreparation(prepared: FactPreparation | null, argumentsValue: unknown): boolean {
  if (!prepared || !argumentsValue || typeof argumentsValue !== 'object') return false;
  const submitted = (argumentsValue as { claims?: { claimId: string; claimText: string }[] }).claims;
  return Array.isArray(submitted) && prepared.claims.every(c => submitted.some(s => s.claimId === c.claimId && s.claimText === c.claimText));
}

/** The extraction turn sees the complete final article but only an evidence
 * locator index. It has no search/submit tools, so cannot skip extraction. */
export function factExtractionArtifacts(artifacts: readonly FactArtifact[]): JsonValue[] {
  return artifacts.filter(a => a.kind === 'body' || a.kind === 'evidence').map(a => {
    if (a.kind === 'body') return { ...a };
    const ledger = factLedger(a.content);
    return { ...a, content: ledger && Array.isArray(ledger.claims) ? { projection: 'fact_evidence_locator',
      claimFields: ['evidence_id', 'claim_text'], claimRows: ledger.claims.map(c => [(c as any).evidence_id ?? null, (c as any).claim_text ?? null]),
      contentAvailableVia: 'read_fact_evidence', instruction: '这里只用于匹配编号，不含证据和限定，不可据此判定支持。' } : factEvidenceCatalog(a.content) };
  });
}

/** Verification sees actual article claims and FULL selected evidence values,
 * not the source article, all unused evidence, or an old conversation. */
export function factVerificationArtifacts(artifacts: readonly FactArtifact[], prepared: FactPreparation): JsonValue[] {
  const ids = new Set(prepared.claims.flatMap(c => c.matchedEvidenceIds));
  return artifacts.filter(a => a.kind === 'body' || a.kind === 'evidence').map(a => {
    if (a.kind === 'body') return { id: a.id, kind: a.kind, content: { projection: 'fact_article_catalog', characters: a.content.length, contentAvailableVia: 'read_fact_article' } };
    const ledger = factLedger(a.content);
    const claims = ledger && Array.isArray(ledger.claims) ? ledger.claims.filter(c => ids.has(String((c as any).evidence_id))) : [];
    const fields = [...new Set(claims.flatMap(c => Object.keys(c as object)))];
    const sourceIds = new Set(claims.map(c => (c as any).source_id));
    return { id: a.id, kind: a.kind, content: { projection: 'fact_selected_evidence', claimFields: fields,
      claimRows: claims.map(c => fields.map(k => (c as any)[k] ?? null)),
      sources: Array.isArray(ledger?.sources) ? ledger.sources.filter(s => sourceIds.has((s as any).source_id)) : [],
      sharedNotesAvailableVia: 'read_fact_evidence', legacyLedger: ledger === null,
      instruction: '只提供待核实条目选中的证据；每行保留全部引句、核实状态及适用边界。其余证据和共同notes按需读取，省略不等于已核实。' } };
  });
}

function searchRows(text: string): Record<string, unknown>[] | null {
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : Array.isArray(value.results) ? value.results : null; } catch { return null; }
}

/** A new verification scope must still be able to reuse earlier searches in
 * this run. Expose locators, not their long texts or old model conversation. */
export function factRecordCatalog(storage: Pick<SessionStore, 'listRunEvents'>, runId: string, _preparationId?: string): JsonValue[] {
  const events = storage.listRunEvents(runId);
  // A fresh runtime does not have the previous verify conversation. Include
  // locators from BEFORE and AFTER preparation, never the original long text.
  return events.flatMap(event => {
    const envelope = event.payload.result as any;
    if (event.type !== 'tool.completed' || !envelope?.ok || typeof envelope.callId !== 'string' ||
        !['search_fact_sources', 'read_fact_source'].includes(envelope.toolName)) return [];
    const result = envelope.result;
    const text = result?.evidenceText ?? result?.text;
    if (typeof text !== 'string' || !text) return [];
    const rows = envelope.toolName === 'search_fact_sources' ? searchRows(text) : null;
    return [{ callId: envelope.callId, tool: envelope.toolName, sourceFields: ['title', 'url'],
      ...(rows ? { sourceRows: rows.map(row => [String(row.title ?? '').slice(0, 120), String(row.url ?? '')]) }
        : { sourceRows: [...new Set([...(typeof result.finalUrl === 'string' ? [result.finalUrl] : []),
          ...(text.match(/https?:\/\/[^\s"<>\\]+/gu) ?? [])])].map(url => ['', url]) }),
      contentAvailableVia: 'read_fact_record', instructionAuthority: 'none', verificationStatus: 'unverified_source_record' }];
  });
}

/** Request-only excerpt; original tool events are retained in SQLite. All URL
 * locators survive. Exact passages are readable locally without another search. */
export function projectFactToolResult(message: ModelMessage): string {
  if (message.role !== 'tool' || !['search_fact_sources', 'read_fact_source'].includes(message.name ?? '')) return message.content;
  try {
    const envelope = JSON.parse(message.content);
    if (envelope.ok !== true || !envelope.result) return message.content;
    const result = envelope.result;
    const text = message.name === 'search_fact_sources' ? result.evidenceText : result.text;
    if (typeof text !== 'string' || !text) return message.content;
    const metadata = Object.fromEntries(['mode', 'provider', 'finalUrl', 'notice', 'errorCode', 'cached'].filter(k => k in result).map(k => [k, result[k]]));
    const rows = message.name === 'search_fact_sources' ? searchRows(text) : null;
    const fullResultAvailableVia = { tool: 'read_fact_record', callId: message.toolCallId };
    return JSON.stringify({ ...envelope, result: { ...metadata, fullResultAvailableVia,
      ...(rows ? { sources: rows.map((row, resultIndex) => ({ resultIndex, title: String(row.title ?? '').slice(0, 120), url: row.url,
        ...(resultIndex < 2 ? { excerpt: String(row.excerpt ?? row.content ?? '').slice(0, 240) } : {}),
        excerptTruncated: resultIndex >= 2 || String(row.excerpt ?? row.content ?? '').length > 240 })) }
        : { excerpt: text.slice(0, 1800), excerptTruncated: text.length > 1800,
          sourceUrls: [...new Set(text.match(/https?:\/\/[^\s"<>\\]+/gu) ?? [])] }),
      requestProjection: 'excerpt_not_full_source', instruction: '这里只是摘录，不等于完整原文。需要相关限定或后文时按callId读取原记录，不重复联网检索。' } });
  } catch { return message.content; }
}

export function createFactContextTools(storage: FactStore, projectId: string, bindingForRun?: (runId: string) => FactBinding | null): ToolDefinition<never, JsonValue>[] {
  const prepare: ToolDefinition<{ claims: Omit<PreparedClaim, 'claimId'>[]; noFactualClaimsReason: string }, JsonValue> = {
    name: 'prepare_fact_check', version: '1.0.0', effect: 'local_idempotent', permissions: ['fact:submit'],
    description: 'Extract all verifiable claims from the COMPLETE current article/selected title before searching. articleQuote must be an exact passage there, never a previous draft or conversation. Extraction is NOT verification.',
    inputSchema: { type: 'object', properties: { claims: { type: 'array', maxItems: 80, items: { type: 'object', properties: {
      claimText: { type: 'string', minLength: 1, maxLength: 600 }, articleQuote: { type: 'string', minLength: 1, maxLength: 1200 },
      location: { type: 'string', enum: ['body', 'title', 'distributionCopy'] }, matchedEvidenceIds: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    }, required: ['claimText', 'articleQuote', 'location', 'matchedEvidenceIds'], additionalProperties: false } }, noFactualClaimsReason: { type: 'string', maxLength: 500 } }, required: ['claims', 'noFactualClaimsReason'], additionalProperties: false },
    execute(args, context) {
      const binding = bindingForRun?.(context.runId);
      if (!binding || context.projectId !== projectId) throw new ToolExecutionFault('FACT_INPUTS_CHANGED', '核查绑定版本不存在或已变化，需要重新提取当前成稿。');
      const ledger = factLedger(binding.evidence.content);
      const valid = new Set(Array.isArray(ledger?.claims) ? ledger.claims.map(c => String((c as any).evidence_id)) : []);
      if (!args.claims.length && !args.noFactualClaimsReason.trim()) throw new ToolExecutionFault('FACT_EXTRACTION_REQUIRED', '无事实主张时说明已覆盖全文及为何没有需要核实的事实。');
      for (const c of args.claims) {
        const article = c.location === 'body' ? binding.body.content : c.location === 'title' ? binding.finalTitle : binding.distributionCopy;
        if (!article?.includes(c.articleQuote)) throw new ToolExecutionFault('FACT_CLAIM_NOT_IN_ARTICLE', 'articleQuote必须是当前成稿或已选标题/配文中的连续原句，不能核查历史聊天或未使用证据。');
        if (c.matchedEvidenceIds.some(id => !valid.has(id))) throw new ToolExecutionFault('FACT_EVIDENCE_NOT_FOUND', '只能匹配当前索引中的证据编号；未匹配时使用空列表。');
      }
      const existing = factPreparation(storage, context.runId, binding);
      if (existing) return existing as unknown as JsonValue;
      const prepared: FactPreparation = { bodyVersionId: binding.body.id, evidenceVersionId: binding.evidence.id, titleVersionId: binding.titleVersionId,
        preparationId: context.operationId, claims: args.claims.map((c, i) => ({ ...c, claimId: `C${String(i + 1).padStart(3, '0')}` })), noFactualClaimsReason: args.noFactualClaimsReason };
      // Runtime settles the tool result and persists it atomically. No second
      // event-write transaction or ephemeral in-memory preparation state.
      return prepared as unknown as JsonValue;
    },
  };
  const evidence: ToolDefinition<{ evidenceIds: string[] }, JsonValue> = {
    name: 'read_fact_evidence', version: '1.0.0', effect: 'read_only', permissions: ['artifact:read'],
    description: 'Read full bound evidence claims and their exact quotes by evidence ID. Choose only claims relevant to current article facts. Empty IDs reads legacy ledger or shared notes.',
    inputSchema: { type: 'object', properties: { evidenceIds: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1 } } }, required: ['evidenceIds'], additionalProperties: false },
    execute(args, context) {
      const id = bindingForRun ? bindingForRun(context.runId)?.evidence.id : storage.inspectProject(projectId)?.currentEvidenceVersionId;
      const version = id ? storage.getArtifactVersion(id) : null;
      if (!version || version.kind !== 'evidence' || version.projectId !== projectId) throw new ToolExecutionFault('FACT_EVIDENCE_NOT_FOUND', '当前证据版本不存在，不能读取其他项目。');
      const ledger = factLedger(version.content);
      if (!ledger || !Array.isArray(ledger.claims)) {
        if (args.evidenceIds.length) throw new ToolExecutionFault('FACT_EVIDENCE_NOT_FOUND', '旧格式账本没有这个证据编号；使用空列表读取原账本。');
        return { evidenceVersionId: id!, content: version.content, instructionAuthority: 'none' };
      }
      const claims = ledger.claims.filter(c => c && typeof c === 'object' && !Array.isArray(c) && args.evidenceIds.includes(String(c.evidence_id)));
      if (claims.length !== args.evidenceIds.length) throw new ToolExecutionFault('FACT_EVIDENCE_NOT_FOUND', '只使用当前证据索引中真实登记的编号，不猜测编号。');
      const sourceIds = new Set(claims.map(c => (c as Record<string, JsonValue>).source_id));
      return { evidenceVersionId: id!, claims, sources: Array.isArray(ledger.sources) ? ledger.sources.filter(s => s && typeof s === 'object' && !Array.isArray(s) && sourceIds.has(s.source_id)) : [],
        ...(args.evidenceIds.length ? {} : { notes: ledger.notes ?? null }), instructionAuthority: 'none' };
    },
  };
  const article: ToolDefinition<{ offset?: number; maxChars?: number }, JsonValue> = {
    name: 'read_fact_article', version: '1.0.0', effect: 'read_only', permissions: ['artifact:read'],
    description: 'Read a necessary passage of the bound final article, after extraction; not old drafts. No network.',
    inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 4000 } }, additionalProperties: false },
    execute(args, context) {
      const binding = bindingForRun?.(context.runId);
      if (!binding || context.projectId !== projectId) throw new ToolExecutionFault('FACT_INPUTS_CHANGED', '当前核查正文已变化。');
      const offset = args.offset ?? 0, nextOffset = Math.min(binding.body.content.length, offset + (args.maxChars ?? 2000));
      return { bodyVersionId: binding.body.id, offset, nextOffset, totalChars: binding.body.content.length, text: binding.body.content.slice(offset, nextOffset),
        truncated: nextOffset < binding.body.content.length, instructionAuthority: 'none' };
    },
  };
  const record: ToolDefinition<{ callId: string; resultIndex?: number; offset?: number; maxChars?: number }, JsonValue> = {
    name: 'read_fact_record', version: '1.0.0', effect: 'read_only', permissions: ['artifact:read'],
    description: 'Read an exact passage from a full locally saved search/source result in THIS run. No network or search quota. resultIndex chooses a search source; offset pages its text.',
    inputSchema: { type: 'object', properties: { callId: { type: 'string', minLength: 1 }, resultIndex: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 4000 } }, required: ['callId'], additionalProperties: false },
    execute(args, context) {
      const envelope = storage.listRunEvents(context.runId).filter(e => e.type === 'tool.completed')
        .map(e => e.payload.result as any).find(r => r?.ok === true && r.callId === args.callId && ['search_fact_sources', 'read_fact_source'].includes(r.toolName));
      if (!envelope) throw new ToolExecutionFault('FACT_RECORD_NOT_FOUND', '只能读取当前运行已保存的搜索或来源记录；使用摘录中的callId。');
      const result = envelope.result;
      let text = String(result.evidenceText ?? result.text ?? '');
      let source: JsonValue = result.finalUrl ?? null;
      if (args.resultIndex !== undefined) {
        const row = searchRows(text)?.[args.resultIndex];
        if (!row) throw new ToolExecutionFault('FACT_RECORD_NOT_FOUND', '搜索记录没有这个来源序号，不能据此猜测原文。');
        text = String(row.excerpt ?? row.content ?? ''); source = { title: String(row.title ?? ''), url: String(row.url ?? '') };
      }
      const offset = args.offset ?? 0, nextOffset = Math.min(text.length, offset + (args.maxChars ?? 4000));
      return { callId: args.callId, source, offset, nextOffset, totalChars: text.length, text: text.slice(offset, nextOffset), truncated: nextOffset < text.length,
        instructionAuthority: 'none', notice: '本地记录的原始摘录/来源文本，不是新的联网请求，也不是已核实证明。' };
    },
  };
  return [evidence, record, prepare, article] as unknown as ToolDefinition<never, JsonValue>[];
}

export const FACT_CONTEXT_GUIDANCE = '核查分为extract和verify两个步骤。extract收到完整当前成稿和已选标题，只提取其中实际出现的全部可核实事实，调用prepare_fact_check：给主张、连续原句articleQuote、位置和匹配证据编号，未匹配用空列表；不核查旧稿、未入正文的账本条目或文风。verify只收到待核实条目、选中证据的全部引文与限定；逐条查证后提交submit_fact_check，保留preparedClaims中每条claimId和claimText，不删掉未证实条目来制造通过。此时正文全文不重复传入，需看上下文用read_fact_article，其他证据用read_fact_evidence，旧格式账本用空编号读取。索引不是依据，不能猜测省略内容已经支持。搜索历史只提供短摘录，按callId用read_fact_record回读完整本地记录的必要段落，不重复搜索同一事实；摘录不足不能判为支持。能共用同一来源的事实合并检索，优先关键日期、数字和引语，searchBudget耗尽后使用已有结果并诚实说明未验证项。分发文案可选，未选择则不核查、不等待确认。材料目录不代表已读原文，必要时读取授权材料。';
