import assert from 'node:assert/strict';
import test from 'node:test';
import { compactFactEvidence, factMaterialContext, factEvidenceCatalog, projectFactToolResult, createFactContextTools, factPreparation, factVerificationArtifacts, factSubmissionCoversPreparation, factRecordCatalog } from '../src/fact-context.js';

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
  assert.equal(JSON.stringify(verify).includes('不应重查'), false);
  binding = { ...binding, titleVersionId: 'new-title' };
  assert.equal(factPreparation(storage, 'run', binding), null, 'changed publication title invalidates extraction, not only final assessment');
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
