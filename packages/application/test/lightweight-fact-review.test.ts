import assert from 'node:assert/strict';
import test from 'node:test';
import * as facts from '../src/fact-context.js';
import { createFactCheckInputSnapshot, evaluateFactCheck } from '../../writing-core/src/index.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';

test('lightweight gate ignores medium/low outcomes without falsely changing their verdicts', () => {
  const contents = { bodyContent: '# 示例\n正文', titleContent: '- 选择状态：已锁定\n- 最终标题：「示例」\n', evidenceContent: '{"claims":[],"notes":"示例记录"}' };
  const snapshot = createFactCheckInputSnapshot({ ...contents, snapshotId: 's', bodyVersionId: 'b', titleVersionId: 't', evidenceVersionId: 'e' });
  const claims = ['green', 'yellow', 'red'].map((risk, i) => ({ claimId: `C00${i + 1}`, claimText: '待核实事实', claimType: 'event' as const,
    location: 'body', risk: risk as 'green' | 'yellow' | 'red', status: 'UNSUPPORTED' as const, supportScope: 'none' as const,
    matchedEvidenceId: null, sourceReference: null, evidenceSummary: '暂未找到来源', recommendedAction: '核对' }));
  const payload = { schemaVersion: 'fact-check-v2' as const, snapshotId: 's', bodyVersionId: 'b', titleVersionId: 't',
    coverage: { body: true as const, title: true as const, distributionCopy: true as const }, claims, noFactualClaimsReason: '' };
  assert.deepEqual(evaluateFactCheck(snapshot, contents, payload).blockers, ['C003']);
  assert.equal(evaluateFactCheck(snapshot, contents, { ...payload, claims: claims.slice(0, 2) }).status, 'passed');
  assert.equal(claims[0]!.status, 'UNSUPPORTED', 'ignoring is not verification');
  const noCitation = { ...claims[0]!, status: 'SUPPORTED' as const, supportScope: 'full' as const };
  assert.equal(evaluateFactCheck(snapshot, contents, { ...payload, claims: [noCitation] }).status, 'passed', 'a missing citation is not itself an article error');
});

test('extraction and verification have compact, distinct prompts without writing-style instructions', () => {
  const builder = (facts as any).factReviewPrompt;
  assert.equal(typeof builder, 'function');
  const extract = builder('extract', true), verify = builder('verify', true);
  assert.match(extract, /写作助手.*提取/u);
  assert.match(verify, /事实核查专员/u);
  for (const prompt of [extract, verify]) {
    assert.ok(prompt.length < 1400, `prompt is ${prompt.length} chars`);
    assert.match(prompt, /中低风险/u);
    assert.match(prompt, /不可信数据/u);
    assert.doesNotMatch(prompt, /作者声音|文体规则|去 AI|盲测|反方|文风统一/u);
  }
  assert.match(verify, /合并检索/u);
  assert.match(verify, /callId.*URL/u);
  assert.match(builder('verify', false), /未联网/u);
});

test('extraction omits explicit medium/low items before any search and preserves important facts exactly', async () => {
  const body = { id: 'b', kind: 'body', content: '# 事件\n关键事件发生在2025年。' };
  const evidence = { id: 'e', kind: 'evidence', content: '{"claims":[],"notes":"没有独立核查"}' };
  const store: any = { listRunEvents: () => [] };
  const prepare = facts.createFactContextTools(store, 'p', () => ({ body, evidence, titleVersionId: null })).find(tool => tool.name === 'prepare_fact_check')!;
  const context: any = { projectId: 'p', runId: 'r', operationId: 'prepare' };
  const background = { claimText: '普通转述', articleQuote: '无需核对的背景', location: 'body', matchedEvidenceIds: [], checkReason: 'key_fact', risk: 'yellow' };
  const important = { ...background, claimText: '事件发生在2025年', articleQuote: '关键事件发生在2025年。', risk: 'red' };
  const result: any = await prepare.execute({ claims: [background, important], noFactualClaimsReason: '' } as never, context);
  assert.deepEqual(result.claims, [{ ...important, claimId: 'C001' }]);
  const empty: any = await prepare.execute({ claims: [background], noFactualClaimsReason: '' } as never, context);
  assert.deepEqual(empty.claims, []);
  assert.match(empty.noFactualClaimsReason, /中低风险/u);
});

test('retired failed submission drafts leave request history, but latest feedback and real source results survive', () => {
  const project = (facts as any).projectFactHistory;
  assert.equal(typeof project, 'function');
  const messages: ModelMessage[] = [ { role: 'system', content: '规则' }, { role: 'user', content: '当前条目' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'search_fact_sources', rawArguments: '{"query":"事件"}', arguments: { query: '事件' } }] },
    { role: 'tool', name: 'search_fact_sources', toolCallId: 'search', content: '{"ok":true,"result":{"evidenceText":"原始来源"}}' },
    ...['old', 'latest'].flatMap(id => [
      { role: 'assistant' as const, content: '', toolCalls: [{ id, name: 'submit_fact_check', rawArguments: '{}', arguments: { claims: [{ claimId: 'C001', evidenceSummary: id.repeat(1000) }] } }] },
      { role: 'tool' as const, name: 'submit_fact_check', toolCallId: id, content: JSON.stringify({ ok: false, error: { code: 'FACT_SUBMISSION_INCOMPLETE', details: { missingClaimIds: ['C002'] } } }) },
    ]),
  ];
  const original = JSON.stringify(messages), projected = project(messages);
  assert.equal(JSON.stringify(messages), original, 'durable/original messages must not be mutated');
  assert.equal(projected.some((m: ModelMessage) => m.role === 'assistant' && m.toolCalls?.some(c => c.id === 'old')), false);
  assert.equal(projected.some((m: ModelMessage) => m.role === 'tool' && m.toolCallId === 'old'), false);
  assert.equal(projected.some((m: ModelMessage) => m.role === 'tool' && m.toolCallId === 'search'), true);
  assert.match(JSON.stringify(projected), /missingClaimIds/u);
  assert.match(JSON.stringify(projected), /latestlatest/u);
});
