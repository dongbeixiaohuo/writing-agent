import assert from 'node:assert/strict';
import test from 'node:test';
import { compactFactEvidence, factMaterialContext, factEvidenceCatalog, projectFactToolResult, createFactContextTools, factPreparation, factVerificationArtifacts, factSubmissionCoversPreparation, factRecordCatalog, normalizeFactVerification, FACT_CONTEXT_GUIDANCE } from '../src/fact-context.js';
import { defaultFactTitleContent } from '../src/publication-choice.js';

test('fact continuation retires consumed read pages, keeps the latest parallel batch and all failures', () => {
  const read = (id: string, name: string, result: any): any => ({ role: 'tool', name, toolCallId: id,
    content: JSON.stringify({ ok: true, toolName: name, result }) });
  const call = (id: string, name: string, args: any): any => ({ role: 'assistant', content: '',
    toolCalls: [{ id, name, arguments: args }] });
  const history: any[] = [
    { role: 'system', content: 'check' }, { role: 'user', content: 'bound claims and selected evidence' },
    call('article', 'read_fact_article', { offset: 0, maxChars: 4000 }),
    read('article', 'read_fact_article', { bodyVersionId: 'body', offset: 0, nextOffset: 4000, totalChars: 5000, text: 'OLD_ARTICLE'.repeat(400), truncated: true }),
    call('material', 'read_material', { materialId: 'source', offset: 4000, maxChars: 4000 }),
    read('material', 'read_material', { materialId: 'source', contentVersionId: 'source-v1', offset: 4000, nextOffset: 8000, totalChars: 9000, content: 'OLD_MATERIAL'.repeat(500) }),
    call('evidence', 'read_fact_evidence', { evidenceIds: ['E001'] }),
    read('evidence', 'read_fact_evidence', { evidenceVersionId: 'ledger', claims: [{ evidence_id: 'E001', source_quote: 'OLD_QUOTE'.repeat(400) }], sources: [] }),
    call('record', 'read_fact_record', { callId: 'search-record', resultIndex: 2, offset: 0, maxChars: 4000 }),
    read('record', 'read_fact_record', { callId: 'search-record', offset: 0, text: 'OLD_RECORD'.repeat(400) }),
    call('fail', 'read_fact_source', { url: 'https://example.test/denied' }),
    { role: 'tool', name: 'read_fact_source', toolCallId: 'fail', content: JSON.stringify({ ok: false, error: { code: 'WEB_HTTP_STATUS_REJECTED', details: { httpStatus: 403 } } }) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'fresh-a', name: 'read_fact_article', arguments: { offset: 4000, maxChars: 1000 } },
      { id: 'fresh-b', name: 'read_material', arguments: { materialId: 'source', offset: 8000, maxChars: 1000 } }] },
    read('fresh-a', 'read_fact_article', { bodyVersionId: 'body-new', offset: 4000, nextOffset: 5000, text: 'FRESH_ARTICLE_限定', truncated: false }),
    read('fresh-b', 'read_material', { materialId: 'another-source', contentVersionId: 'source-v2', offset: 8000, nextOffset: 9000, content: 'FRESH_SOURCE_限定' }),
    { role: 'user', content: 'schema correction: claimType enum' },
  ];
  const original = JSON.stringify(history);
  const projected = history.map((message, index) => ({ ...message,
    content: projectFactToolResult(message, { messages: history, index } as any) }));
  for (const index of [3, 5, 7, 9]) {
    assert.ok(projected[index]!.content.length < 900, 'consumed pages must not accumulate in fact requests');
    const result = JSON.parse(projected[index]!.content).result;
    assert.equal(result.requestProjection, 'read_receipt_not_source');
    assert.equal(result.contentAvailableVia.tool, history[index]!.name);
    assert.equal(result.contentAvailableVia.arguments.offset, history[index - 1]!.toolCalls[0].arguments.offset);
  }
  assert.equal(JSON.parse(projected[5]!.content).result.contentVersionId, 'source-v1');
  assert.deepEqual(JSON.parse(projected[7]!.content).result.evidenceIds, ['E001']);
  assert.match(projected[13]!.content, /FRESH_ARTICLE_限定/);
  assert.match(projected[14]!.content, /FRESH_SOURCE_限定/);
  assert.equal(projected[11]!.content, history[11]!.content, 'source failure and HTTP status must remain visible');
  assert.equal(JSON.stringify(history), original, 'request projection must never mutate stored raw reads');
  assert.equal(projectFactToolResult(history[3]), history[3].content, 'without history, do not guess that a page was consumed');
});

test('fact continuation keeps all pages of an actively read source together instead of losing cross-page qualifiers', () => {
  const history: any[] = [{ role: 'system', content: 'check' }, { role: 'user', content: 'selected claims' }];
  for (const [i, resource] of ['other-source', 'source', 'source'].entries()) {
    const id = `read-${i}`;
    history.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_material', arguments: { materialId: resource, offset: i * 4000, maxChars: 4000 } }] },
      { role: 'tool', name: 'read_material', toolCallId: id, content: JSON.stringify({ ok: true, result: { materialId: resource, contentVersionId: `${resource}-v1`,
        offset: i * 4000, nextOffset: (i + 1) * 4000, content: i === 1 ? 'FIRST_PAGE_只适用这一人群' : 'NEXT_PAGE_不得推断因果' } }) });
  }
  const projected = history.map((m, index) => projectFactToolResult(m, { messages: history, index }));
  assert.equal(JSON.parse(projected[3]!).result.requestProjection, 'read_receipt_not_source');
  assert.match(projected[5]!, /FIRST_PAGE_只适用这一人群/);
  assert.match(projected[7]!, /NEXT_PAGE_不得推断因果/);
  assert.equal(JSON.parse(projected[5]!).result.requestProjection, undefined, 'all pages of the active same-version source must remain jointly readable');
});

test('external verification requires a successful local record for the cited source, not source-material agreement', () => {
  const base: any = { claimId: 'C001', claimText: '事件发生于2024年', status: 'SUPPORTED',
    sourceReference: 'https://example.test/event', verificationMethod: 'external_source', verificationRecordIds: ['source1'] };
  const prepare: any = { claims: [{ claimId: 'C001', claimText: base.claimText, checkReason: 'key_fact' }] };
  const source = { type: 'tool.completed', payload: { result: { ok: true, callId: 'source1', toolName: 'read_fact_source',
    result: { finalUrl: base.sourceReference, text: '事件发生于2024年。' } } } };
  assert.throws(() => normalizeFactVerification([], prepare, [base]), { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
  assert.throws(() => normalizeFactVerification([{ ...source, payload: { result: { ...source.payload.result, ok: false } } }], prepare, [base]),
    { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
  assert.throws(() => normalizeFactVerification([source], prepare, [{ ...base, sourceReference: 'https://example.test/different' }]),
    { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
  const claims = normalizeFactVerification([source], prepare, [{ ...base, checkReason: 'suspected_error' }]);
  assert.equal(claims[0]!.checkReason, 'key_fact', 'cannot relabel a selected key fact at submission');
  assert.equal(claims[0]!.verificationMethod, 'external_source');
  assert.deepEqual(claims[0]!.verificationRecordIds, ['source1']);
  const material = normalizeFactVerification([], prepare, [{ ...base, verificationMethod: 'material_comparison', verificationRecordIds: [] }]);
  assert.equal(material[0]!.verificationMethod, 'material_comparison', 'a source URL does not prove a network check');
  assert.doesNotThrow(() => normalizeFactVerification([], prepare, [material[0]!]),
    'enabling search must not impose external proof on every selected fact');
  assert.doesNotThrow(() => normalizeFactVerification([], prepare, [{ ...material[0]!, status: 'UNSUPPORTED' }]),
    'an honest unknown must remain submit-able after a search failure or quota exhaustion');
  assert.doesNotThrow(() => normalizeFactVerification([], prepare, [material[0]!]),
    'model-only mode must not require unavailable external tools');
  const empty = { ...source, payload: { result: { ...source.payload.result, result: { ...source.payload.result.result, text: '' } } } };
  assert.throws(() => normalizeFactVerification([empty], prepare, [base]), { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
});

test('author firsthand facts can use supplied material without a public citation', () => {
  const claim: any = { claimId: 'C001', claimText: '我昨天参加了客户会议', status: 'SUPPORTED',
    sourceReference: 'material:author-firsthand', verificationMethod: 'material_comparison' };
  const prepared: any = { claims: [{ claimId: 'C001', claimText: claim.claimText, checkReason: 'key_fact' }] };
  const normalized = normalizeFactVerification([], prepared, [claim]);
  assert.equal(normalized[0]!.verificationMethod, 'material_comparison');
  assert.deepEqual(normalized[0]!.verificationRecordIds, []);
});

test('new verification claims require a selection reason instead of bypassing extraction', () => {
  const prepared: any = { claims: [{ claimId: 'C001', claimText: '已选主张', checkReason: 'suspected_error' }] };
  const selected: any = { claimId: 'C001', claimText: '已选主张', status: 'SUPPORTED', verificationMethod: 'material_comparison' };
  const extra: any = { claimId: 'C002', claimText: '新发现的日期', status: 'SUPPORTED', verificationMethod: 'model_review' };
  assert.equal(factSubmissionCoversPreparation(prepared, { claims: [selected, extra] }), false);
  assert.throws(() => normalizeFactVerification([], prepared, [selected, extra]), { code: 'FACT_CLAIM_SELECTION_REQUIRED' });
  const corrected = { ...extra, checkReason: 'suspected_error' };
  assert.equal(factSubmissionCoversPreparation(prepared, { claims: [selected, corrected] }), true);
  assert.doesNotThrow(() => normalizeFactVerification([], prepared, [selected, corrected]));
  const actualProblem = { ...extra, status: 'CONTRADICTED' };
  assert.equal(factSubmissionCoversPreparation(prepared, { claims: [selected, actualProblem] }), true,
    'do not reject an actual problem merely because an older model output omitted the optional reason');
  assert.equal(normalizeFactVerification([], prepared, [selected, actualProblem])[1]!.checkReason, 'suspected_error');
});

test('external provenance accepts Parallel text, Tavily JSON and HTTP redirects, not failed or empty searches', () => {
  const claim: any = { claimId: 'C001', claimText: '事件发生于2024年', status: 'SUPPORTED',
    verificationMethod: 'external_source', verificationRecordIds: ['lookup'],
    sourceReference: '[原始公告](http://example.test/announcement(2024)#date)' };
  const event = (toolName: string, result: unknown, ok = true): any => ({ type: 'tool.completed',
    payload: { result: { ok, toolName, callId: 'lookup', result } } });
  const url = 'http://example.test/announcement(2024)';
  for (const evidenceText of [
    `原始公告：事件发生于2024年。\n[公告](${url})`,
    JSON.stringify([{ url, excerpt: '事件发生于2024年。' }]),
    JSON.stringify({ results: [{ url, content: '事件发生于2024年。' }] }),
  ]) {
    const search = event('search_fact_sources', { mode: 'external', evidenceText });
    assert.doesNotThrow(() => normalizeFactVerification([search], null, [claim]));
    assert.throws(() => normalizeFactVerification([{ ...search, payload: { result: { ...search.payload.result, ok: false } } }], null, [claim]),
      { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
  }
  assert.doesNotThrow(() => normalizeFactVerification([event('read_fact_source', {
    requestedUrl: url, finalUrl: 'https://example.test/announcement(2024)', text: '事件发生于2024年。',
  })], null, [claim]));
  assert.doesNotThrow(() => normalizeFactVerification([event('read_fact_source', {
    finalUrl: url, text: '事件发生于2024年。',
  })], null, [{ ...claim, sourceReference: `原文（${url}）。` }]), 'Chinese citation punctuation must not become part of the URL');
  for (const result of [
    { mode: 'external', evidenceText: '' },
    { mode: 'external', evidenceText: JSON.stringify([{ url, excerpt: '' }]) },
    { mode: 'unavailable', evidenceText: `检索失败：${url}` },
  ]) assert.throws(() => normalizeFactVerification([event('search_fact_sources', result)], null, [claim]),
    { code: 'FACT_EXTERNAL_RECORD_REQUIRED' });
});

test('persisting an identical body-derived title preserves preparation, actual author/title/input changes do not', async () => {
  const body = { id: 'body', kind: 'body', content: '# 会议经历\n\n昨天我开了客户会议。' };
  const evidence = { id: 'evidence', kind: 'evidence', content: JSON.stringify({ claims: [] }) };
  const binding = { body, evidence, titleVersionId: null };
  const events: any[] = [];
  const storage: any = { listRunEvents: () => events };
  const prepare = createFactContextTools(storage, 'p', () => binding).find(t => t.name === 'prepare_fact_check')!;
  const saved: any = await prepare.execute({ claims: [], noFactualClaimsReason: '全文是作者自述，无需进一步查证的公开事实。' } as never,
    { projectId: 'p', runId: 'r', operationId: 'prep' } as any);
  events.push({ type: 'tool.completed', payload: { result: { ok: true, toolName: 'prepare_fact_check', result: saved } } });
  const generated = { ...binding, titleVersionId: 'auto-title', generatedTitleContent: defaultFactTitleContent(body.content) };
  assert.equal(factPreparation(storage, 'r', generated), saved);
  assert.equal(factPreparation(storage, 'r', { ...generated, titleVersionId: 'another-identical-auto-title' }), saved);
  assert.equal(factPreparation(storage, 'r', { ...generated, generatedTitleContent: undefined, finalTitle: '作者另选的标题' }), null);
  assert.equal(factPreparation(storage, 'r', { ...generated, generatedTitleContent: '不同标题/配文' }), null);
  assert.equal(factPreparation(storage, 'r', { ...generated, body: { ...body, id: 'new-body' } }), null);
  assert.equal(factPreparation(storage, 'r', { ...generated, evidence: { ...evidence, id: 'new-evidence' } }), null);
  delete saved.defaultTitleContent;
  assert.equal(factPreparation(storage, 'r', generated), null, 'older preparation cannot infer semantic equivalence');
});


test('fact extraction is bound to current article and selected title; verification resends only actual claims and selected evidence', async () => {
  const ledger = JSON.stringify({ claims: [{ evidence_id: 'E001', claim_text: '今年增长12%', source_quote: '只在A地区增长12%', use_boundary: '只适用A地区', verification_status: '未经独立核实' },
    { evidence_id: 'E002', claim_text: '没有写进文章的事实', source_quote: '不应重查'.repeat(3000) }] });
  const body = { id: 'body', kind: 'body', content: '# 标题\n\n今年增长12%。' };
  const evidence = { id: 'evidence', kind: 'evidence', content: ledger };
  let binding: any = { body, evidence, titleVersionId: 'title', finalTitle: '增长12%意味着什么' };
  const events: any[] = [];
  const storage: any = { listRunEvents: () => events, recordRunEvent: (e: any) => { events.push(e); return e; },
    getArtifactVersion: (id: string) => id === 'evidence' ? { ...evidence, projectId: 'p' } : null };
  const prepare = createFactContextTools(storage, 'p', () => binding).find(t => t.name === 'prepare_fact_check')!;
  const context: any = { projectId: 'p', runId: 'run', operationId: 'extract' };
  await assert.rejects(async () => prepare.execute({ claims: [{ claimText: '旧稿主张', articleQuote: '历史对话中有过', location: 'body', matchedEvidenceIds: [] }], noFactualClaimsReason: '' } as never, context), { code: 'FACT_CLAIM_NOT_IN_ARTICLE' });
  const result = await prepare.execute({ claims: [{ claimText: '今年增长12%', articleQuote: '今年增长12%', location: 'body', matchedEvidenceIds: ['E001'] }], noFactualClaimsReason: '' } as never, context);
  events.push({ type: 'tool.completed', payload: { result: { ok: true, toolName: 'prepare_fact_check', result } } });
  const saved = factPreparation(storage, 'run', binding)!;
  assert.equal(saved.claims[0]!.claimId, 'C001');
  assert.equal(factSubmissionCoversPreparation(saved, { claims: [] }), false, 'cannot drop an unverified extracted claim to pass');
  assert.equal(factSubmissionCoversPreparation(saved, { claims: [{ claimId: 'C001', claimText: '今年增长12%' }] }), true);
  const verify: any = factVerificationArtifacts([body, evidence], saved);
  assert.equal(verify[0].content.projection, 'fact_article_catalog');
  assert.equal(JSON.stringify(verify).includes('今年增长12%。'), false, 'full body must not recur after extraction');
  assert.equal(JSON.stringify(verify).includes('只在A地区增长12%'), true, 'selected quote and all limitations remain exact');
  assert.equal(verify[1].content.delivery, 'selected_full', 'selected evidence is not an unread directory');
  assert.equal(JSON.stringify(verify).includes('不应重查'), false);
  binding = { ...binding, titleVersionId: 'new-title' };
  assert.equal(factPreparation(storage, 'run', binding), null, 'changed publication title invalidates extraction, not only final assessment');
});

test('verification guidance uses supplied selected quotes and only fills real context gaps', () => {
  assert.match(FACT_CONTEXT_GUIDANCE, /claimFields.*claimRows/);
  assert.match(FACT_CONTEXT_GUIDANCE, /不从头重读.*正文.*原始素材/);
  assert.match(FACT_CONTEXT_GUIDANCE, /不重复读取.*已提供.*证据/);
  assert.match(FACT_CONTEXT_GUIDANCE, /定位记录不是证据/);
});

test('fact evidence source dedup is lossless, retaining every claim, qualifier and provenance without clipping', () => {
  const source = { source_title: '同一篇权威资料'.repeat(12), source_publisher: '机构', source_url: 'http://example.com/source', accessed_at: '2026-10-03' };
  const ledger = { notes: '尚未取得原始研究，不得冒充一手证据。', claims: Array.from({ length: 20 }, (_, i) => ({
    ...source, evidence_id: `E${String(i + 1).padStart(3, '0')}`, claim_type: 'number', claim_text: `主张${i}`, source_quote: `带有限定条件的原文${i}`,
    reliability: 'medium', use_boundary: '不能推断因果，也不能推广到另一人群', verification_status: '转引未核实', extra: '旧版字段保留',
  })) };
  const compact: any = compactFactEvidence(JSON.stringify(ledger));
  assert.equal(compact.sources.length, 1);
  const expanded = compact.claims.map(({ source_id, ...claim }: any) => {
    const { source_id: _id, ...provenance } = compact.sources.find((s: any) => s.source_id === source_id);
    return { ...provenance, ...claim };
  });
  assert.deepEqual(expanded, ledger.claims);
  assert.equal(compact.notes, ledger.notes);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(ledger).length * 0.7);
  assert.equal(compactFactEvidence('legacy plain text'), 'legacy plain text');
  assert.equal(compactFactEvidence('{"claims":[null]}'), '{"claims":[null]}');
});

test('fact scope supplies claim catalogue instead of every source quote, with full evidence accessible on demand', async () => {
  const ledger = { notes: '研究过程说明'.repeat(1000), claims: Array.from({ length: 30 }, (_, i) => ({
    evidence_id: `E${i}`, claim_type: 'number', claim_text: `事实${i}`, source_quote: '完整限定引文'.repeat(500),
    use_boundary: '不可推广，不得推断因果', verification_status: '尚未联网验证', source_url: 'https://example.com/source',
  })) };
  const content = JSON.stringify(ledger);
  const catalog: any = factEvidenceCatalog(content);
  assert.equal(catalog.projection, 'fact_evidence_catalog');
  assert.equal(catalog.claimRows.length, 30);
  assert.equal(catalog.claimRows[0][catalog.claimFields.indexOf('use_boundary')], ledger.claims[0]!.use_boundary);
  assert.equal(catalog.claimRows[0][catalog.claimFields.indexOf('verification_status')], '尚未联网验证');
  assert.equal(catalog.claimFields.includes('source_quote'), false);
  assert.ok(JSON.stringify(catalog).length < content.length / 10);
  const canonical: any = compactFactEvidence(content);
  assert.deepEqual(factEvidenceCatalog(JSON.stringify(canonical)), catalog, 'compact-source ledgers must remain readable, not downgraded to an empty legacy catalogue');
  const storage: any = { inspectProject: () => ({ currentEvidenceVersionId: 'v' }), getArtifactVersion: () => ({ id: 'v', projectId: 'p', kind: 'evidence', content }), listRunEvents: () => [] };
  const tools = createFactContextTools(storage, 'p');
  const result: any = await tools.find(t => t.name === 'read_fact_evidence')!.execute({ evidenceIds: ['E2'] } as never, { runId: 'run' } as any);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].source_quote, ledger.claims[2]!.source_quote);
  await assert.rejects(async () => tools[0]!.execute({ evidenceIds: ['invented'] } as never, { runId: 'run' } as any), { code: 'FACT_EVIDENCE_NOT_FOUND' });
});

test('search and source history are bounded excerpts, preserving all locators and full local readback', async () => {
  const results = Array.from({ length: 5 }, (_, i) => ({ title: `来源${i}`, url: `https://example.com/${i}`, excerpt: `原文${i}`.repeat(1500) }));
  const envelope = { ok: true, callId: 'search1', toolName: 'search_fact_sources', result: { mode: 'external', provider: 'tavily', evidenceText: JSON.stringify({ results }), notice: '未核实' } };
  const message: any = { role: 'tool', name: 'search_fact_sources', toolCallId: 'search1', content: JSON.stringify(envelope) };
  const projected: any = JSON.parse(projectFactToolResult(message));
  assert.ok(JSON.stringify(projected).length < 4000);
  assert.deepEqual(projected.result.sources.map((r: any) => r.url), results.map(r => r.url));
  assert.equal(projected.result.fullResultAvailableVia.callId, 'search1');
  assert.equal(projected.result.sources[0].excerptTruncated, true);
  const source: any = { role: 'tool', name: 'read_fact_source', toolCallId: 'source1', content: JSON.stringify({ ok: true, result: { finalUrl: results[0]!.url, text: '本文原文'.repeat(4000) } }) };
  assert.ok(projectFactToolResult(source).length < 3000);
  const failed: any = { ...message, content: JSON.stringify({ ok: false, error: { code: 'SEARCH_TIMEOUT', message: '搜索超时' } }) };
  assert.equal(projectFactToolResult(failed), failed.content, 'failures must never be erased');
  const unavailable = { ...message, content: JSON.stringify({ ok: true, result: { mode: 'unavailable', failureCode: 'SEARCH_LIMIT_REACHED', evidenceText: '' } }) };
  assert.equal(projectFactToolResult(unavailable), unavailable.content, 'no excerpt wrapper or text inflation for an unavailable search');
  const storage: any = { listRunEvents: (runId: string) => runId === 'run' ? [{ type: 'tool.completed', payload: { result: envelope } }] : [] };
  const catalog: any = factRecordCatalog(storage, 'run');
  assert.equal(catalog.length, 1, 'rework/reopening can find saved search records without the old model history');
  assert.equal(catalog[0].callId, 'search1');
  assert.deepEqual(catalog[0].sourceRows.map((row: any[]) => row[1]), results.map(row => row.url));
  assert.equal(JSON.stringify(catalog).includes('原文0'), false, 'catalogue must not reintroduce long source text');
  const history: any = { listRunEvents: () => [
    { type: 'tool.completed', payload: { result: envelope } },
    { type: 'tool.completed', payload: { result: { ok: true, toolName: 'prepare_fact_check', result: { preparationId: 'prep' } } } },
    { type: 'tool.completed', payload: { result: { ...envelope, callId: 'already-in-new-history' } } },
  ] };
  assert.deepEqual(factRecordCatalog(history, 'run', 'prep').map((row: any) => row.callId), ['search1', 'already-in-new-history'],
    'after interruption the fresh model history must still locate sources from the same preparation');
  const reader = createFactContextTools(storage, 'p').find(t => t.name === 'read_fact_record')!;
  const full: any = await reader.execute({ callId: 'search1', resultIndex: 0 } as never, { runId: 'run' } as any);
  assert.equal(full.text, results[0]!.excerpt.slice(0, 4000));
  assert.equal(full.truncated, true);
  await assert.rejects(async () => reader.execute({ callId: 'search1' } as never, { runId: 'other' } as any), { code: 'FACT_RECORD_NOT_FOUND' });
});

test('fact checks use source catalogue on demand, keep firsthand and author input, and never mark omitted content as supplied', () => {
  const materials: any[] = [
    { id: 'web', contentVersionId: 'v1', displayName: '长文章', content: 'SOURCE'.repeat(3000), sourceKind: 'web_snapshot', role: 'source_verified', permissionScope: 'session', trustLabel: 'external_untrusted' },
    { id: 'firsthand', contentVersionId: 'v2', displayName: '个人经历', content: '这一天我亲眼见到的事。', sourceKind: 'pasted_text', role: 'user_firsthand', permissionScope: 'session', trustLabel: 'user_provided' },
    { id: 'intake-user-feedback', contentVersionId: 'v3', displayName: '需求对话', content: '这里是比喻，不是原文引语。', sourceKind: 'pasted_text', role: 'illustrative', permissionScope: 'session', trustLabel: 'user_provided' },
  ];
  const view: any = factMaterialContext(materials);
  assert.equal(view.materialCatalog.length, 3);
  assert.equal(view.materials.some((m: any) => m.materialId === 'web'), false);
  assert.deepEqual(view.materials.map((m: any) => m.content), materials.slice(1).map(m => m.content));
  assert.equal(view.materialCatalog[0].content, undefined);
  assert.equal(view.materialCatalog[0].instructionAuthority, 'none');
  assert.equal(view.materialCatalog[0].totalChars, 18000);
});
