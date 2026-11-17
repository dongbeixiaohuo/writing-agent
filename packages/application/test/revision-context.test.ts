import assert from 'node:assert/strict';
import { it } from 'node:test';
import { redevelopmentReference, redevelopmentProblems, redevelopmentHistory } from '../src/revision-context.js';
import { needsArticleRedevelopment, type BoundReviewFinding } from '../src/review-closure.js';
import type { ModelMessage } from '../../runtime/llm/src/index.js';

const finding: BoundReviewFinding = { id: 'f', bodyVersionId: 'b', reviewVersionId: 'r', kind: 'attribution', severity: 'required',
  quote: '旧稿的有误归属。', issue: '主体错了。', repairTarget: '使用来源中实际的出资方。', evidenceIds: ['E1'] };

it('routes a factual correction locally and a required reading failure to structural rewriting', () => {
  assert.equal(needsArticleRedevelopment([finding]), false);
  assert.equal(needsArticleRedevelopment([{ ...finding, kind: 'reader_value', severity: 'suggestion' }]), false);
  assert.equal(needsArticleRedevelopment([finding, { ...finding, kind: 'reader_value' }]), true);
});

it('retains a bound title and author-cited prose without converting a rejection to a preserve instruction', () => {
  const original = '# 原标题\n\n开头的好句应该留着。\n\n旧稿的有误归属。\n\n其余正文不作模板。';
  const replies = ['保留“开头的好句应该留着。”', '删除“旧稿的有误归属。”', '保留“并不在这篇文章里的句子”。'];
  const projected = redevelopmentReference(original, replies);
  assert.equal(projected.requiredTitle, '# 原标题');
  assert.deepEqual(projected.authorCitations, [
    { quote: '开头的好句应该留着。', authorInstruction: replies[0] },
    { quote: '旧稿的有误归属。', authorInstruction: replies[1] },
  ]);
  assert.ok(!JSON.stringify(projected).includes('其余正文'));
  assert.equal(original.includes('其余正文不作模板。'), true);
});

it('keeps diagnosed problems and repair objectives while withholding old example prose', () => {
  const structural = { ...finding, id: 's', kind: 'reader_value' as const, issue: '材料重复证明同一句判断。', repairTarget: '展开人物不同选择的后果。' };
  const result = redevelopmentProblems([finding, structural, { ...finding, id: 'optional', severity: 'suggestion' }]);
  assert.deepEqual(result.map(f => [f.id, f.issue, f.repairTarget]), [[finding.id, finding.issue, finding.repairTarget], ['s', structural.issue, structural.repairTarget]]);
  assert.ok(result.every(f => !Object.hasOwn(f, 'quote')));
  assert.equal(finding.quote, '旧稿的有误归属。');
});

it('removes both halves of stale draft/review reads after resumption and retains source tool pairs', () => {
  const call = (id: string, name: string) => ({ id, name, arguments: {}, rawArguments: '{}' });
  const messages: ModelMessage[] = [
    { role: 'system', content: '当前任务' }, { role: 'user', content: '作者原话' },
    { role: 'assistant', content: '旧稿复述也不继承', toolCalls: [call('a', 'read_artifact_version'), call('b', 'read_material')] },
    { role: 'tool', toolCallId: 'a', name: 'read_artifact_version', content: '完整旧稿' },
    { role: 'tool', toolCallId: 'b', name: 'read_material', content: '原始来源' },
    { role: 'assistant', content: '', toolCalls: [call('c', 'read_review_discussion')] },
    { role: 'tool', toolCallId: 'c', name: 'read_review_discussion', content: '旧审校全文' },
  ];
  const result = redevelopmentHistory(messages);
  assert.equal(result.length, 4);
  assert.equal(result[2]!.content, '');
  assert.equal((result[2] as Extract<ModelMessage, { role: 'assistant' }>).toolCalls![0]!.id, 'b');
  assert.equal(result[3]!.content, '原始来源');
  assert.ok(!JSON.stringify(result).includes('旧稿'));
  assert.equal(messages.length, 7, 'saved history stays unchanged');
});
