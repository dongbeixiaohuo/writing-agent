import assert from 'node:assert/strict';
import test from 'node:test';
import { applyParagraphEdits, articleParagraphs, paragraphRepairScope } from '../src/paragraph-revision.js';
import { parseRevisionAudit, JSON_SCHEMA, REVISION_AUDIT_JSON_SCHEMA } from '../src/review-closure.js';

const body = '# 标题\r\n\r\n  有效开场。\r\n\r\n必须本人在场。\r\n\r\n不必本人在场，伙计已经办好。\r\n\r\n保留的结尾。\r\n';
const issues = [{ quote: '必须本人在场。', paragraphIds: ['p3', 'p4'] }];
test('paragraph repair preserves all unaddressed bytes, whitespace, title and order', () => {
  const changed = applyParagraphEdits(body, 'v1', { baseBodyVersionId: 'v1', edits: [{ paragraphId: 'p3', replacement: '当事人交给伙计代办。' }] }, issues);
  assert.equal(changed.content, body.replace('必须本人在场。', '当事人交给伙计代办。'));
  assert.deepEqual(changed.changedParagraphIds, ['p3']);
  assert.deepEqual(changed.untouchedParagraphIds, ['p1', 'p2', 'p4', 'p5']);
  assert.deepEqual(paragraphRepairScope(body, [{ quote: '必须本人在场。\r\n\r\n不必本人在场，伙计已经办好。' }]).editableParagraphIds, ['p3', 'p4']);
  assert.equal(articleParagraphs(body).length, 5);
  assert.deepEqual(paragraphRepairScope(body, [{ quote: '必须本人在场。', paragraphIds: [] }]).editableParagraphIds, ['p3']);
});
test('rejects stale, duplicate, unapproved and title edits without partial application', () => {
  const patch = { baseBodyVersionId: 'v1', edits: [{ paragraphId: 'p3', replacement: '新句。' }] };
  assert.throws(() => applyParagraphEdits(body, 'v2', patch, issues));
  for (const paragraphId of ['p1', 'p2', 'p99']) assert.throws(() => applyParagraphEdits(body, 'v1', { ...patch, edits: [{ paragraphId, replacement: '新句。' }] }, issues));
  assert.throws(() => applyParagraphEdits(body, 'v1', { ...patch, edits: [...patch.edits, ...patch.edits] }, issues));
  assert.throws(() => applyParagraphEdits(body, 'v1', { ...patch, edits: [{ paragraphId: 'p3', replacement: '# 偷换标题' }] }, issues));
  assert.equal(applyParagraphEdits(body, 'v1', { ...patch, edits: [] }, issues).content, body);
});
test('a grounded contradiction blocks delivery independently of an optimistic overall reading verdict', () => {
  const audit = parseRevisionAudit({ consistency: [{ claim: '必须本人在场。', against: '不必本人在场，伙计已经办好。',
    verdict: 'conflict', reason: '同一事项对在场要求的判断相反。', repairTarget: '根据实际代办经过修正总论。' }],
    checks: [], newFindings: [], reading: { verdict: 'delivered', takeaway: '读者知道有人代办。', quote: '有效开场。', reason: '开场清楚。', repairTarget: '无需修改。', queries: [], questions: [] },
  }, [], body, new Set(), body, true);
  assert.equal(audit.requiresRevision, true);
  assert.deepEqual(audit.newFindings[0]!.paragraphIds, ['p3', 'p4']);
  assert.equal(audit.newFindings[0]!.severity, 'required');
  assert.throws(() => parseRevisionAudit({ consistency: [{ claim: '不存在的句子', against: '有效开场。', verdict: 'conflict', reason: '错', repairTarget: '改' }], checks: [], newFindings: [] }, [], body, new Set()));
});

test('reviewer schemas leave paragraph anchors to the application', () => {
  assert.equal(JSON.stringify(JSON_SCHEMA).includes('paragraphIds'), false);
  assert.equal(JSON.stringify(REVISION_AUDIT_JSON_SCHEMA).includes('paragraphIds'), false);
  const audit = parseRevisionAudit({ checks: [], newFindings: [{ quote: '必须本人在场。', kind: 'inference', severity: 'required',
    issue: '与代办的实际经过冲突。', repairTarget: '依实际经过修正此段。', evidenceIds: [] }] }, [], body, new Set());
  assert.deepEqual(audit.newFindings[0]!.paragraphIds, ['p3']);
});
