import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import {
  JSON_SCHEMA, RESOLUTIONS_JSON_SCHEMA, REVISION_AUDIT_JSON_SCHEMA,
  parseReviewResolutions, parseRevisionAudit, validateReviewFindings, type ReviewFinding,
} from '../src/review-closure.js';

const oldAttribution = '用了 AI 的员工普遍更难被主管信任。';
const oldInference = '人际信任没有随着 AI 普及一起上涨。';
const processNote = '下面是说明性假设，不是真事，留待核查。';
const authorView = '急活交给能担责的人，我更放心。';
const newAttribution = '这项实验问的是参与者是否采信员工自报的工时。';
const newInference = '这份调查只记录同一时期的 AI 使用和信任水平。';
const draft = `# 工作中的信任\n\n${oldAttribution}\n\n${oldInference}\n\n${processNote}\n\n${authorView}`;
const revision = `# 工作中的信任\n\n${newAttribution}\n\n${newInference}\n\n${authorView}`;
const evidenceIds = new Set(['E001', 'E002']);
const findings: ReviewFinding[] = [
  { quote: oldAttribution, kind: 'attribution', severity: 'required', issue: '把采信自报工时扩大成对员工的总体信任。', repairTarget: '说清实验判断对象。', evidenceIds: ['E001'] },
  { quote: oldInference, kind: 'inference', severity: 'required', issue: '同期调查不能验证随时间变化。', repairTarget: '删除趋势断言，保留同一时期的观察。', evidenceIds: ['E002'] },
  { quote: processNote, kind: 'process_note', severity: 'required', issue: '写作备注混进正文。', repairTarget: '清理工作备注，场景仍以条件语气表达。', evidenceIds: [] },
  { quote: authorView, kind: 'reader_value', severity: 'suggestion', issue: '可能和下一段重复。', repairTarget: '确认这句话是否有独立作用。', evidenceIds: [] },
];
const bound = findings.map((finding, index) => ({ ...finding, id: `review-a:${index + 1}`, bodyVersionId: 'draft-v1', reviewVersionId: 'review-a' }));
const resolutions = [
  { findingId: 'review-a:1', action: 'rewrite', afterQuote: newAttribution, reason: '恢复实验测量对象。' },
  { findingId: 'review-a:2', action: 'rewrite', afterQuote: newInference, reason: '保留同期观察，删除时间变化推论。' },
  { findingId: 'review-a:3', action: 'remove', afterQuote: null, reason: '读者无需看到写作检查。' },
  { findingId: 'review-a:4', action: 'retain', afterQuote: authorView, reason: '这句话交代作者判断，其余段落没有重复。' },
];
const checks = [
  { findingId: 'review-a:1', verdict: 'resolved', quote: newAttribution, reason: '新句与测量对象一致。' },
  { findingId: 'review-a:2', verdict: 'resolved', quote: newInference, reason: '新句只说同期观察。' },
  { findingId: 'review-a:3', verdict: 'resolved', quote: null, reason: '备注已删除。' },
  { findingId: 'review-a:4', verdict: 'not_applicable', quote: authorView, reason: '同意修订者保留作者自己的判断。' },
];

test('the tool schema accepts bound attribution, inference and process-note reports without model-assigned IDs', () => {
  const ajv = new Ajv();
  assert.equal(ajv.validate(JSON_SCHEMA, findings), true);
  assert.equal(ajv.validate(RESOLUTIONS_JSON_SCHEMA, resolutions), true);
  assert.equal(ajv.validate(REVISION_AUDIT_JSON_SCHEMA, { checks, newFindings: [] }), true);
  assert.deepEqual(validateReviewFindings(findings, draft, evidenceIds), findings);
  assert.deepEqual(validateReviewFindings([], draft, evidenceIds), []);
  assert.deepEqual(parseReviewResolutions([], [], revision), []);
  assert.equal(parseRevisionAudit({ checks: [], newFindings: [] }, [], revision, evidenceIds).requiresRevision, false);
  assert.throws(() => validateReviewFindings([{ ...findings[0]!, id: 'model-created' }], draft, evidenceIds), { code: 'REVIEW_FINDINGS_INVALID' });
});

test('tool schemas limit unusually large review payloads', () => {
  const ajv = new Ajv();
  assert.equal(ajv.validate(JSON_SCHEMA, Array(13).fill(findings[0])), false);
  assert.equal(ajv.validate(RESOLUTIONS_JSON_SCHEMA, Array(101).fill(resolutions[0])), false);
  assert.equal(ajv.validate(RESOLUTIONS_JSON_SCHEMA, [{ ...resolutions[0], afterQuote: '句'.repeat(1_201) }]), false);
  assert.equal(ajv.validate(REVISION_AUDIT_JSON_SCHEMA, { checks: [{ ...checks[0], reason: '长'.repeat(1_001) }], newFindings: [] }), false);
  assert.equal(ajv.validate(REVISION_AUDIT_JSON_SCHEMA, { checks: [{ ...checks[0], findingId: 'x'.repeat(201) }], newFindings: [] }), false);
});

test('findings reject a paraphrased or blank quote, an unknown source, and an oversized source list', () => {
  const first = findings[0]!;
  assert.throws(() => validateReviewFindings([{ ...first, quote: '使用 AI 让主管不再信任员工。' }], draft, evidenceIds), {
    code: 'REVIEW_FINDINGS_INVALID', message: /verbatim/u,
  });
  assert.throws(() => validateReviewFindings([{ ...first, quote: '\n\n' }], draft, evidenceIds), { code: 'REVIEW_FINDINGS_INVALID' });
  assert.throws(() => validateReviewFindings([{ ...first, evidenceIds: ['E099'] }], draft, evidenceIds), {
    code: 'REVIEW_FINDINGS_INVALID', message: /E099/u,
  });
  assert.throws(() => validateReviewFindings([{ ...first, evidenceIds: Array(9).fill('E001') }], draft, evidenceIds), { code: 'REVIEW_FINDINGS_INVALID' });
});

test('revision accepts real changes and a reasoned retention without treating that retention as verified', () => {
  assert.deepEqual(parseReviewResolutions(resolutions, bound, revision), resolutions);
  const report = parseRevisionAudit({ checks, newFindings: [] }, bound, revision, evidenceIds);
  assert.equal(report.requiresRevision, false);
  assert.equal(report.checks[3]!.verdict, 'not_applicable');
});

test('resolutions reject omitted, duplicate and unbound finding IDs', () => {
  for (const [rows, problem] of [
    [resolutions.slice(1), /missing/u],
    [[...resolutions, resolutions[0]], /twice/u],
    [[{ ...resolutions[0]!, findingId: 'another-review:1' }, ...resolutions.slice(1)], /not bound/u],
  ] as const) {
    assert.throws(() => parseReviewResolutions(rows, bound, revision), { code: 'REVIEW_RESOLUTIONS_INVALID', message: problem });
  }
});

test('resolutions reject unmodified rewrites, fabricated replacements, and claims that retained or removed text incorrectly', () => {
  assert.throws(() => parseReviewResolutions([{ ...resolutions[0]!, afterQuote: oldAttribution }, ...resolutions.slice(1)], bound, `${revision}\n${oldAttribution}`), {
    code: 'REVIEW_RESOLUTIONS_INVALID', message: /must differ/u,
  });
  assert.throws(() => parseReviewResolutions([{ ...resolutions[0]!, afterQuote: '这项实验测量晋升速度。' }, ...resolutions.slice(1)], bound, revision), {
    code: 'REVIEW_RESOLUTIONS_INVALID', message: /verbatim/u,
  });
  assert.throws(() => parseReviewResolutions(resolutions, bound, `${revision}\n${processNote}`), {
    code: 'REVIEW_RESOLUTIONS_INVALID', message: /For remove/u,
  });
  assert.throws(() => parseReviewResolutions(resolutions, bound, revision.replace(authorView, '')), {
    code: 'REVIEW_RESOLUTIONS_INVALID', message: /For retain/u,
  });
});

test('terminal audit needs exactly one grounded check and a reason for dismissing a finding', () => {
  for (const malformed of [
    checks.slice(1),
    [...checks, checks[0]],
    [{ ...checks[0]!, findingId: 'missing-review:1' }, ...checks.slice(1)],
    [{ ...checks[0]!, quote: '终稿里并不存在的句子。' }, ...checks.slice(1)],
    [...checks.slice(0, 3), { ...checks[3]!, reason: '  ' }],
  ]) {
    assert.throws(() => parseRevisionAudit({ checks: malformed, newFindings: [] }, bound, revision, evidenceIds), { code: 'REVISION_AUDIT_INVALID' });
  }
});

test('a required issue cannot be marked resolved with the unchanged original passage or an empty anchor', () => {
  const rebuttal = `有人把报道理解成“${oldAttribution}” 但实验只考察是否采信员工自报的工时。`;
  const withContext = `${revision}\n\n${rebuttal}`;
  for (const quote of [null, oldAttribution]) {
    assert.throws(() => parseRevisionAudit({ checks: [{ ...checks[0]!, quote }, ...checks.slice(1)], newFindings: [] }, bound, withContext, evidenceIds), {
      code: 'REVISION_AUDIT_INVALID', message: /larger verbatim context/u,
    });
  }
  const defended = [{ ...checks[0]!, quote: rebuttal, reason: '正文完整引用并纠正了该说法。' }, ...checks.slice(1)];
  assert.equal(parseRevisionAudit({ checks: defended, newFindings: [] }, bound, withContext, evidenceIds).requiresRevision, false);
  const suggestionRetained = [...defended.slice(0, 3), { ...checks[3]!, verdict: 'resolved' }];
  assert.equal(parseRevisionAudit({ checks: suggestionRetained, newFindings: [] }, bound, withContext, evidenceIds).requiresRevision, false);
});

test('unresolved required checks and new required findings trigger revision while suggestions do not', () => {
  const unresolved = [{ ...checks[0]!, verdict: 'unresolved', reason: '仍未交代主管所处的实验条件。' }, ...checks.slice(1)];
  assert.equal(parseRevisionAudit({ checks: unresolved, newFindings: [] }, bound, revision, evidenceIds).requiresRevision, true);
  const suggestOnly = [...checks.slice(0, 3), { ...checks[3]!, verdict: 'unresolved', reason: '仍有少量重复。' }];
  assert.equal(parseRevisionAudit({ checks: suggestOnly, newFindings: [] }, bound, revision, evidenceIds).requiresRevision, false);
  const newQuote = '所以主管对使用 AI 的人越来越失去信心。';
  const newFinding: ReviewFinding = { quote: newQuote, kind: 'inference', severity: 'required',
    issue: '结尾添加了未测量的时间变化。', repairTarget: '删去这句趋势判断。', evidenceIds: ['E001'] };
  const altered = `${revision}\n\n${newQuote}`;
  assert.equal(parseRevisionAudit({ checks, newFindings: [newFinding] }, bound, altered, evidenceIds).requiresRevision, true);
  assert.throws(() => parseRevisionAudit({ checks, newFindings: [newFinding] }, bound, revision, evidenceIds), { code: 'REVISION_AUDIT_INVALID' });
  assert.throws(() => parseRevisionAudit({ checks, newFindings: [{ ...newFinding, evidenceIds: ['E999'] }] }, bound, altered, evidenceIds), { code: 'REVISION_AUDIT_INVALID' });
});

test('revision returns verify existing and newly found issues against the bound central draft', () => {
  const unresolved = [{ ...checks[0]!, verdict: 'unresolved' }, ...checks.slice(1)];
  const newQuote = '这项实验还记录了参与者的晋升速度。';
  const newFinding: ReviewFinding = { ...findings[0]!, quote: newQuote };
  const centralDraft = `${revision}\n\n${newQuote}`;
  assert.equal(parseRevisionAudit({ checks, newFindings: [newFinding] }, bound, '需要修订', evidenceIds, centralDraft).requiresRevision, true);
  assert.equal(parseRevisionAudit({ checks: unresolved, newFindings: [] }, bound, '需要修订', evidenceIds, centralDraft).requiresRevision, true);
  assert.throws(() => parseRevisionAudit({ checks, newFindings: [newFinding] }, bound, centralDraft, evidenceIds, revision), {
    code: 'REVISION_AUDIT_INVALID', message: /contiguous passage/u,
  });
  const fabricated = [{ ...unresolved[0]!, quote: newQuote }, ...unresolved.slice(1)];
  assert.throws(() => parseRevisionAudit({ checks: fabricated, newFindings: [] }, bound, centralDraft, evidenceIds, revision), {
    code: 'REVISION_AUDIT_INVALID', message: /bound central revision/u,
  });
});

test('a passing audit must cite the delivered article even if a quote is valid in the central draft', () => {
  const submitted = revision.replace(newAttribution, '这项实验比较了不同的工时判断。');
  assert.throws(() => parseRevisionAudit({ checks, newFindings: [] }, bound, submitted, evidenceIds, revision), {
    code: 'REVISION_AUDIT_INVALID', message: /article being submitted/u,
  });
  assert.equal(parseRevisionAudit({ checks, newFindings: [] }, bound, revision, evidenceIds, submitted).requiresRevision, false);
});
