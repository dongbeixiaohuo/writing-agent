import type { FactClaim, JsonValue, MaterialRecord, StoragePort } from '../../writing-core/src/index.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';
import type { SessionStore } from '../../runtime/session/src/index.js';
import { ToolExecutionFault, type ToolDefinition } from '../../runtime/tools/src/index.js';
import { inlineMaterialContext } from './material-context.js';
import { defaultFactTitleContent } from './publication-choice.js';

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
export type FactBinding = { body: FactArtifact; evidence: FactArtifact; titleVersionId: string | null; finalTitle?: string | undefined; distributionCopy?: string | undefined;
  generatedTitleContent?: string | undefined };
type PreparedClaim = { claimId: string; claimText: string; articleQuote: string; location: 'body' | 'title' | 'distributionCopy'; matchedEvidenceIds: string[];
  checkReason?: 'key_fact' | 'suspected_error' };
export type FactPreparation = { bodyVersionId: string; evidenceVersionId: string; titleVersionId: string | null; preparationId: string;
  claims: PreparedClaim[]; noFactualClaimsReason: string; defaultTitleContent?: string };
type FactStore = StoragePort & Pick<SessionStore, 'listRunEvents'>;

/** Persist extraction, not a fact conclusion. Reopening a bridge/run can reuse
 * it only while the article, evidence and publication choice are unchanged. */
export function factPreparation(storage: Pick<SessionStore, 'listRunEvents'>, runId: string, binding: FactBinding | null): FactPreparation | null {
  if (!binding) return null;
  const event = storage.listRunEvents(runId).findLast(e => e.type === 'tool.completed' && (e.payload.result as any)?.ok === true && (e.payload.result as any)?.toolName === 'prepare_fact_check');
  const saved = (event?.payload.result as any)?.result as FactPreparation | undefined;
  return saved && saved.bodyVersionId === binding.body.id && saved.evidenceVersionId === binding.evidence.id &&
    (saved.titleVersionId === binding.titleVersionId ||
      (saved.defaultTitleContent !== undefined && saved.defaultTitleContent === binding.generatedTitleContent)) ? saved : null;
}

/** Older outputs may discover a real error without the optional reason. Preserve
 * that finding without a correction round; unclassified successful extras do not
 * acquire a selection reason merely from a source URL or material agreement. */
function submittedSelectionReason(claim: Partial<FactClaim>): PreparedClaim['checkReason'] {
  if (claim.checkReason === 'key_fact' || claim.checkReason === 'suspected_error') return claim.checkReason;
  if (['UNSUPPORTED', 'CONTRADICTED', 'BROKEN_LINK', 'NEEDS_USER_SOURCE'].includes(claim.status ?? '') ||
    claim.risk === 'red' || claim.supportScope === 'partial' || claim.supportScope === 'none') return 'suspected_error';
  return undefined;
}

export function factSubmissionCoversPreparation(prepared: FactPreparation | null, argumentsValue: unknown): boolean {
  if (!prepared || !argumentsValue || typeof argumentsValue !== 'object') return false;
  const submitted = (argumentsValue as { claims?: Partial<FactClaim>[] }).claims;
  return Array.isArray(submitted) && prepared.claims.every(c => submitted.some(s => s.claimId === c.claimId && s.claimText === c.claimText)) &&
    submitted.every(s => prepared.claims.some(c => s.claimId === c.claimId && s.claimText === c.claimText) ||
      submittedSelectionReason(s) !== undefined);
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
    return { id: a.id, kind: a.kind, content: { projection: 'fact_selected_evidence', delivery: 'selected_full', claimFields: fields,
      claimRows: claims.map(c => fields.map(k => (c as any)[k] ?? null)),
      sources: Array.isArray(ledger?.sources) ? ledger.sources.filter(s => sourceIds.has((s as any).source_id)) : [],
      sharedNotesAvailableVia: 'read_fact_evidence', legacyLedger: ledger === null,
      instruction: '只提供待核实条目选中的证据；每行保留全部引句、核实状态及适用边界。其余证据和共同notes按需读取，省略不等于已核实。' } };
  });
}

function searchRows(text: string): Record<string, unknown>[] | null {
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : Array.isArray(value.results) ? value.results : null; } catch { return null; }
}

/** Citation wrappers/fragments identify the same fetched page. Preserve balanced
 * parentheses in real URLs (e.g. journal article IDs) and both HTTP/HTTPS. */
function sourceUrl(value: string): string | null {
  let raw = value.replace(/[.,;!?，。；！？、’”」』]+$/gu, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】']]) {
    while (raw.endsWith(close!) && raw.split(close!).length > raw.split(open!).length) raw = raw.slice(0, -1);
  }
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function sourceUrls(text: string): string[] {
  return (text.replace(/\\\//gu, '/').match(/https?:\/\/[^\s"<>\\]+/gu) ?? [])
    .map(sourceUrl).filter((url): url is string => url !== null);
}

/** Network provenance is established by successful tool records, not a model's
 * assertion or a URL copied from supplied material. This is NOT semantic proof. */
export function normalizeFactVerification(
  events: readonly { type: string; payload: Readonly<Record<string, unknown>> }[],
  prepared: Pick<FactPreparation, 'claims'> | null,
  claims: readonly FactClaim[],
): FactClaim[] {
  const records = new Map<string, string[]>();
  for (const event of events) {
    const envelope = event.payload.result as any;
    if (event.type !== 'tool.completed' || envelope?.ok !== true || typeof envelope.callId !== 'string') continue;
    const result = envelope.result;
    if (envelope.toolName === 'search_fact_sources' && result?.mode === 'external' && typeof result.evidenceText === 'string') {
      const rows = searchRows(result.evidenceText);
      records.set(envelope.callId, rows ? rows.filter(row => String(row.excerpt ?? row.content ?? '').trim())
        .flatMap(row => sourceUrls(String(row.url ?? ''))) : sourceUrls(result.evidenceText));
    } else if (envelope.toolName === 'read_fact_source' && typeof result?.text === 'string' && result.text.trim() && typeof result.finalUrl === 'string') {
      records.set(envelope.callId, [result.finalUrl, ...(typeof result.requestedUrl === 'string' ? [result.requestedUrl] : [])].flatMap(sourceUrls));
    }
  }
  return claims.map(claim => {
    const selected = prepared?.claims.find(c => c.claimId === claim.claimId && c.claimText === claim.claimText);
    const checkReason = selected?.checkReason ?? submittedSelectionReason(claim);
    if (prepared && !selected && checkReason !== 'key_fact' && checkReason !== 'suspected_error') {
      throw new ToolExecutionFault('FACT_CLAIM_SELECTION_REQUIRED', '新发现的待查事实须填写checkReason=key_fact或suspected_error，说明为何需要核对；保留原有待查条目，可直接修正本次提交，不必重读全文。');
    }
    const urls = sourceUrls(claim.sourceReference ?? '');
    const recordIds = [...new Set(claim.verificationRecordIds ?? [])];
    const hasRecords = recordIds.length > 0 && recordIds.every(id => records.get(id)?.some(url => urls.includes(url)));
    let verificationMethod = claim.verificationMethod;
    if (verificationMethod === 'external_source' && !hasRecords) {
      throw new ToolExecutionFault('FACT_EXTERNAL_RECORD_REQUIRED', '不能把与材料一致写成已联网查证。external_source必须引用本轮成功搜索/读取的callId及同一具体来源URL；否则使用material_comparison或model_review，并如实保留不确定项。');
    }
    if (!verificationMethod) verificationMethod = claim.sourceReference === 'model-knowledge:unverified' ? 'model_review' : 'material_comparison';
    return { ...claim, ...(checkReason ? { checkReason } : {}), verificationMethod,
      verificationRecordIds: verificationMethod === 'external_source' ? recordIds : [] };
  });
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

/** Identify an active paged source without mixing versions or search rows. */
function factReadResource(message: ModelMessage): string | null {
  if (message.role !== 'tool') return null;
  try {
    const envelope = JSON.parse(message.content), r = envelope.result;
    if (envelope.ok !== true || !r) return null;
    if (message.name === 'read_fact_article' && typeof r.bodyVersionId === 'string') return JSON.stringify([message.name, r.bodyVersionId]);
    if (message.name === 'read_material' && typeof r.materialId === 'string' && typeof r.contentVersionId === 'string')
      return JSON.stringify([message.name, r.materialId, r.contentVersionId]);
    if (message.name === 'read_fact_record' && typeof r.callId === 'string') return JSON.stringify([message.name, r.callId, r.source ?? null]);
  } catch { /* Unknown legacy results stay conservative. */ }
  return null;
}

/** Request-only excerpt; original tool events are retained in SQLite. All URL
 * locators survive. Exact passages are readable locally without another search. */
export function projectFactToolResult(message: ModelMessage, context?: { readonly messages: readonly ModelMessage[]; readonly index: number }): string {
  if (message.role !== 'tool') return message.content;
  const localRead = ['read_fact_article', 'read_fact_evidence', 'read_material', 'read_fact_record'].includes(message.name ?? '');
  if (!localRead && !['search_fact_sources', 'read_fact_source'].includes(message.name ?? '')) return message.content;
  try {
    const envelope = JSON.parse(message.content);
    if (envelope.ok !== true || !envelope.result) return message.content;
    const result = envelope.result;
    if (localRead) {
      // The latest parallel batch and all pages of its active resources remain
      // jointly visible. Other old reads become locators, never evidence.
      // A schema-correction user message does not consume the latest batch.
      const latestBatch = context?.messages.findLastIndex(m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
      if (!context || latestBatch === undefined || latestBatch < 0 || context.index > latestBatch) return message.content;
      const resource = factReadResource(message);
      if (resource !== null && context.messages.slice(latestBatch + 1).some(m => factReadResource(m) === resource)) return message.content;
      const invocation = context.messages.slice(0, context.index).findLast(m => m.role === 'assistant' &&
        m.toolCalls?.some(call => call.id === message.toolCallId));
      const call = invocation?.role === 'assistant' ? invocation.toolCalls?.find(c => c.id === message.toolCallId && c.name === message.name) : undefined;
      if (!call) return message.content;
      const metadata = Object.fromEntries(['bodyVersionId', 'evidenceVersionId', 'materialId', 'contentVersionId', 'callId', 'resultIndex',
        'offset', 'nextOffset', 'totalChars', 'truncated', 'instructionAuthority'].filter(k => k in result).map(k => [k, result[k]]));
      return JSON.stringify({ ok: true, toolName: message.name, callId: message.toolCallId, result: { ...metadata,
        ...(message.name === 'read_fact_evidence' ? { evidenceIds: Array.isArray(result.claims) ? result.claims.map((c: any) => c.evidence_id) : [] } : {}),
        contentAvailableVia: { tool: message.name, arguments: call.arguments }, requestProjection: 'read_receipt_not_source',
        instruction: '定位记录不是证据；旧全文不重复传入，需要限定时按相同参数本地重读。' } });
    }
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
    description: 'Lightweight factual review for self-media articles, not academic citation auditing. Screen the COMPLETE final article, select error-prone important facts and suspected errors only. Omit stable common knowledge, ordinary background, author-confirmed firsthand facts and wording differences unless genuinely suspect. Each selected claim needs checkReason; articleQuote locates it, not a verbatim source comparison.',
    inputSchema: { type: 'object', properties: { claims: { type: 'array', maxItems: 80, items: { type: 'object', properties: {
      claimText: { type: 'string', minLength: 1, maxLength: 600 }, articleQuote: { type: 'string', minLength: 1, maxLength: 1200 },
      location: { type: 'string', enum: ['body', 'title', 'distributionCopy'] }, matchedEvidenceIds: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      checkReason: { type: 'string', enum: ['key_fact', 'suspected_error'], description: 'key_fact: error-prone or uncertain dates, identities/events, figures or quotations important to this article. suspected_error: possible invention, contradiction or changed factual meaning, even a minor detail. Not every factual sentence needs a citation.' },
    }, required: ['claimText', 'articleQuote', 'location', 'matchedEvidenceIds', 'checkReason'], additionalProperties: false } }, noFactualClaimsReason: { type: 'string', maxLength: 500 } }, required: ['claims', 'noFactualClaimsReason'], additionalProperties: false },
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
        ...(binding.titleVersionId === null || binding.generatedTitleContent !== undefined ? { defaultTitleContent: defaultFactTitleContent(binding.body.content) } : {}),
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

export const FACT_CONTEXT_GUIDANCE = '这是公众号、头条等文章的轻量事实复核，不是论文审稿，不要求每个点都有出处或论文引用。extract收到完整当前成稿与已选标题，筛查关键事实与可疑信息：易错、时效性强或存疑的重要时间、人物身份、事件、数字、引语记key_fact；明显矛盾、疑似幻觉或含义改变记suspected_error。普通背景、稳定常识、作者确认的亲历和同义转述无疑点时不单独列项；没有引用不等于事实错误。调用prepare_fact_check，提供定位原句articleQuote、位置、checkReason及匹配证据编号（无则空列表）；完整筛查后没有待查事实可用空claims并说明范围与理由。verify只收到待查条目及相关证据，保留所有preparedClaims的claimId/claimText；新发现的问题可在提交中补充并给checkReason，不删掉实际问题来制造通过。按需要用已有材料、模型知识或联网结果判断，不因启用搜索就强制所有条目联网；作者自述不要求公开证明。缺少论文本身不阻断，真实矛盾、疑似虚构或仍无法判断的重要事实要说明问题和最小纠正动作。verificationMethod如实记录material_comparison、model_review或external_source；外部方式附成功工具callId和对应具体URL，只证明取得该来源，是否支持事实仍由模型判断。正文上下文用read_fact_article，证据用read_fact_evidence，本轮来源用read_fact_record按需回读；索引或网址不等于已读原文，短摘录足够核实简单事实时不强求全文，关键限定不足时再读。不查旧稿或未使用条目，不重复搜索；共用来源合并检索，searchBudget耗尽使用已有结果并说明真正的未决问题。分发文案可选，未选择不核查、不等待确认。' + [
  '\nverify阶段不是第二次全文筛查：不从头重读完整正文和全部原始素材。preparedClaims已包含当前成稿待查原句，fact_selected_evidence中claimFields是列名、claimRows逐行按列对应完整证据，引句和适用边界都已提供，不重复读取这些已提供的证据。先用它们判断；只在具体主张缺少关键限定或上下文时补读相应段落。旧格式ledger未提供选中引句时可以按需补读。',
  'read_receipt_not_source定位记录不是证据，也不表示事实已核实；完整原文保留在本地，可用contentAvailableVia中的参数重读。最新一批补读片段仍完整提供，先完成这些主张的判断，不机械分页遍历整个素材。多个待查点共用相同来源时一次读取或检索，不为已足够的信息追加工具轮。',
  'evidenceSummary只写核对的关键结果与必要限制，不逐字抄回长引文或整段材料；recommendedAction写实际问题的最小处理。无问题时用短句，不交长篇审计报告。分类不在约定类型时用other，事实结论和核查方式仍须严格使用约定值。',
].join('\n');
