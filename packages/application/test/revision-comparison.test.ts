import assert from 'node:assert/strict';
import test from 'node:test';
import { JSON_SCHEMA, parseRevisionComparison } from '../src/revision-comparison.js';

const original = { id: 'draft', content: '# 窗边\n\n他终于放松下来。街上已经安静。\n\n他没有开灯。' };
const revised = { id: 'revision', content: '# 窗边\n\n他把手机扣在桌上，靠着窗听楼下的脚步。街上已经安静。\n\n他没有开灯。' };
const binding = { original, revised, allowOriginal: true };
const gain = { before: '他终于放松下来。', after: '他把手机扣在桌上，靠着窗听楼下的脚步。', why: '动作让读者自己感受到情绪变化。' };
const report = { selectedVersionId: revised.id, reason: '修订后的开头更具体。', gains: [gain], losses: [], retainedQuotes: ['他没有开灯。'] };

test('preserves an evidence-backed comparison of the two bound versions', () => {
  assert.deepEqual(parseRevisionComparison(report, binding, revised.content), report);
  assert.equal(JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(JSON_SCHEMA.required, ['selectedVersionId', 'reason', 'gains', 'losses', 'retainedQuotes']);
});

test('allows choosing the original based on an evidenced loss, unless the binding prohibits it', () => {
  const keep = { ...report, selectedVersionId: original.id, gains: [], losses: [{ ...gain, why: '修订引入了未经作者证实的现场细节。' }] };
  assert.deepEqual(parseRevisionComparison(keep, binding, original.content), keep);
  assert.throws(() => parseRevisionComparison(keep, { ...binding, allowOriginal: false }, original.content), { code: 'REVISION_SELECTION_NOT_ALLOWED' });
  assert.throws(() => parseRevisionComparison(report, { ...binding, allowOriginal: false }, original.content), { code: 'REVISION_SELECTION_NOT_ALLOWED' });
  assert.throws(() => parseRevisionComparison({ ...report, selectedVersionId: 'another-body' }, binding, revised.content), { code: 'REVISION_SELECTION_NOT_ALLOWED' });
});

test('rejects fabricated, reversed, whitespace, and unchanged passages offered as evidence', () => {
  for (const entry of [
    { ...gain, before: '原文没有这句话。' },
    { ...gain, before: gain.after, after: gain.before },
    { ...gain, before: ' ' },
    { ...gain, why: ' ' },
    { ...gain, before: '他没有开灯。', after: '他没有开灯。' },
    { ...gain, before: '街上已经安静。', after: '他没有开灯。' },
  ]) {
    assert.throws(() => parseRevisionComparison({ ...report, gains: [entry] }, binding, revised.content), { code: 'REVISION_COMPARISON_INVALID' });
  }
});

test('requires each retained quote in both the chosen version and final body', () => {
  assert.throws(() => parseRevisionComparison(report, binding, revised.content.replace('他没有开灯。', '')), { code: 'REVISION_COMPARISON_INVALID' });
  assert.throws(() => parseRevisionComparison({ ...report, retainedQuotes: [gain.before] }, binding, original.content), { code: 'REVISION_COMPARISON_INVALID' });
});

test('requires an explanation and a concrete comparison for changed versions', () => {
  assert.throws(() => parseRevisionComparison({}, binding, revised.content), { code: 'REVISION_COMPARISON_INVALID' });
  assert.throws(() => parseRevisionComparison({ ...report, reason: ' ' }, binding, revised.content), { code: 'REVISION_COMPARISON_INVALID' });
  assert.throws(() => parseRevisionComparison({ ...report, gains: [] }, binding, revised.content), { code: 'REVISION_COMPARISON_INVALID' });
  const unchanged = { ...report, reason: '初稿已经清楚，修订稿未改变正文。', gains: [] };
  const equivalent = { ...binding, revised: { ...revised, content: `${original.content.replaceAll('\n', '\r\n')}\r\n` } };
  assert.deepEqual(parseRevisionComparison(unchanged, equivalent, original.content), unchanged);
  assert.throws(() => parseRevisionComparison(report, equivalent, original.content), { code: 'REVISION_COMPARISON_INVALID' });
});
