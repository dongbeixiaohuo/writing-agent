import assert from 'node:assert/strict';
import test from 'node:test';
import { compactFactEvidence, factMaterialContext } from '../src/fact-context.js';

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
