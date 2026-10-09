import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFactToolResult } from '../src/fact-context.js';

/** Isolated review regressions for the RC74 request-history projection.
 * These supplement fact-context.test.ts without weakening its assertions. */

const page = (filler: string, size = 4000): string => filler.repeat(Math.ceil(size / filler.length)).slice(0, size);

function batch(history: unknown[], calls: { id: string; name: string; arguments: unknown }[], results: { id: string; name: string; result: unknown }[]): void {
  history.push({ role: 'assistant', content: '', toolCalls: calls.map(call => ({ ...call })) });
  for (const result of results) history.push({ role: 'tool', name: result.name, toolCallId: result.id,
    content: JSON.stringify({ ok: true, toolName: result.name, result: result.result }) });
}

function project(history: unknown[]): string[] {
  return (history as any[]).map((message, index) => projectFactToolResult(message, { messages: history as any, index }));
}

test('version switch retires the old version only; a parallel latest batch stays fully readable', () => {
  const history: unknown[] = [{ role: 'system', content: 'check' }, { role: 'user', content: 'claims' }];
  batch(history, [{ id: 'a1', name: 'read_material', arguments: { materialId: 'm', offset: 0, maxChars: 4000 } }],
    [{ id: 'a1', name: 'read_material', result: { materialId: 'm', contentVersionId: 'v1', offset: 0, nextOffset: 4000, content: page('V1_QUALIFIER_') } }]);
  batch(history, [
    { id: 'b1', name: 'read_material', arguments: { materialId: 'm', offset: 0, maxChars: 4000 } },
    { id: 'b2', name: 'read_material', arguments: { materialId: 'n', offset: 0, maxChars: 4000 } },
  ], [
    { id: 'b1', name: 'read_material', result: { materialId: 'm', contentVersionId: 'v2', offset: 0, nextOffset: 4000, content: page('V2_LATEST_') } },
    { id: 'b2', name: 'read_material', result: { materialId: 'n', contentVersionId: 'n1', offset: 0, nextOffset: 4000, content: page('N_PARALLEL_') } },
  ]);
  const projected = project(history);
  assert.equal(JSON.parse(projected[3]!).result.requestProjection, 'read_receipt_not_source', 'v1 of the switched material must retire');
  assert.match(projected[5]!, /V2_LATEST_/);
  assert.match(projected[6]!, /N_PARALLEL_/);
  assert.equal(JSON.parse(projected[5]!).result.contentVersionId, 'v2');
});

test('history growth is bounded: distinct consumed resources become fixed-size receipts, not accumulating pages', () => {
  const history: unknown[] = [{ role: 'system', content: 'check' }, { role: 'user', content: 'claims' }];
  for (let i = 0; i < 6; i++) batch(history,
    [{ id: `r${i}`, name: 'read_material', arguments: { materialId: `mat-${i}`, offset: 0, maxChars: 4000 } }],
    [{ id: `r${i}`, name: 'read_material', result: { materialId: `mat-${i}`, contentVersionId: `v${i}`, offset: 0, nextOffset: 4000, content: page(`SRC_${i}_`) } }]);
  batch(history, [{ id: 'final', name: 'submit_fact_check', arguments: { claims: [] } }],
    [{ id: 'final', name: 'submit_fact_check', result: { ok: true } }]);
  const raw = (history as any[]).filter(m => m.role === 'tool').reduce((sum, m) => sum + m.content.length, 0);
  const projected = project(history).filter((_, i) => (history as any[])[i].role === 'tool');
  const total = projected.reduce((sum, c) => sum + c.length, 0);
  assert.ok(raw > 24_000, `raw history should exceed 24k (was ${raw})`);
  for (const content of projected.slice(0, 6)) assert.ok(content.length < 600, `retired receipt must stay small (was ${content.length})`);
  assert.ok(total < 600 * 6 + 200, `projected tool history must stay bounded (was ${total})`);
});

test('interleaving other tools retires pages only until the same source is read again, then all pages return together', () => {
  const history: unknown[] = [{ role: 'system', content: 'check' }, { role: 'user', content: 'claims' }];
  for (const offset of [0, 4000, 8000]) batch(history,
    [{ id: `p${offset}`, name: 'read_material', arguments: { materialId: 'm', offset, maxChars: 4000 } }],
    [{ id: `p${offset}`, name: 'read_material', result: { materialId: 'm', contentVersionId: 'v1', offset, nextOffset: offset + 4000,
      content: offset === 0 ? 'PAGE1_仅适用2024年数据' : offset === 4000 ? 'PAGE2_不得跨年推断' : 'PAGE3_反例记录' } }]);
  batch(history, [{ id: 'rec', name: 'read_fact_record', arguments: { callId: 'search-1', resultIndex: 1, offset: 0 } }],
    [{ id: 'rec', name: 'read_fact_record', result: { callId: 'search-1', source: { title: 't', url: 'https://e.test/a' }, offset: 0, nextOffset: 4000, text: page('RECORD_') } }]);
  let projected = project(history);
  assert.equal(JSON.parse(projected[3]!).result.requestProjection, 'read_receipt_not_source', 'pages retire while another tool holds the latest batch');
  batch(history, [{ id: 'p12000', name: 'read_material', arguments: { materialId: 'm', offset: 12000, maxChars: 4000 } }],
    [{ id: 'p12000', name: 'read_material', result: { materialId: 'm', contentVersionId: 'v1', offset: 12000, nextOffset: 16000, content: 'PAGE4_续读' } }]);
  projected = project(history);
  for (const index of [3, 5, 7, 11]) assert.equal(JSON.parse(projected[index]!).result.requestProjection, undefined,
    `page at slot ${index} must be fully visible again once its source is re-read`);
  assert.match(projected[3]!, /PAGE1_仅适用2024年数据/);
  assert.match(projected[5]!, /PAGE2_不得跨年推断/);
  assert.match(projected[7]!, /PAGE3_反例记录/);
  assert.match(projected[11]!, /PAGE4_续读/);
});
