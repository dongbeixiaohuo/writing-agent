import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLintEdits, applyReviewEdits } from '../src/focused-review.js';
import { validatePersuasionFindings } from '../src/review-closure.js';
import { editorialPlanFixture } from './collaboration-fixture.js';
import { replayReadingHandoff, type ReadingHandoffFixture } from './reading-handoff-replay.js';

const topic = '奖金到底怎么算';
const url = 'https://report.example.org/pay';
const sourceText = '公司向员工公布固定工资的区间，岗位奖金另算。';
const firstReading = { url, finalUrl: url, text: sourceText, bodyHash: 'fixture', truncated: false, instructionAuthority: 'none' as const };
const fixture: ReadingHandoffFixture = {
  brief: { schemaVersion: 1, topic, genre: 'explanatory_analysis', audience: '职场读者', lengthTarget: { targetCharacters: 800 },
    materialIds: [], constraints: [], interactionMode: 'autonomous', platform: null, publicationGoal: 'not_applicable',
    authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
    confirmationStatus: 'confirmed' },
  authorReplies: [topic], rawAuthorText: ['我想写清老板发的年终奖是怎么算的。'], firstReading, supplement: firstReading,
  researchLedger: JSON.stringify({ claims: [{ evidence_id: 'E001', claim_type: 'other', claim_text: sourceText, source_quote: sourceText,
    source_title: '离线材料', source_publisher: '测试', source_url: url, accessed_at: '离线', reliability: 'medium',
    use_boundary: '核对公开信息的范围', verification_status: 'source_verified' }],
    notes: '', editorialPlan: editorialPlanFixture(['E001']) }),
  assessment: { decision: 'ready', promise: topic, reason: '沿着原方向', readerPayoff: '知道两者的区别。',
    readingRoute: { question: topic, moments: [{ quote: sourceText, sourceUrl: url, interest: '工资与奖金分开看。' }] },
    premises: [], sections: [], queries: [], questions: [] },
};

const title = '# 奖金到底怎么算';
const opening = '老板叫大家回去等通知。';
const claim = '只要公开了工资区间，人人就能算出自己的奖金。';
const correction = '公布的是固定工资的区间。奖金还得另算。';
const attribution = '材料写的是公开奖金区间。';
const body = [title, opening, claim, attribution, '这两件事说到底是一套算法。'].join('\n\n');
const finding = { quote: claim, kind: 'inference', severity: 'required',
  issue: '如果奖金另算，工资范围算不出奖金。', repairTarget: '区分工资参照和奖金规则。', evidenceIds: [] };
const materialEdit = { kind: 'material', quote: '公开奖金区间', replacement: '公开固定工资区间', reason: '范围不符。',
  source: { id: url, quote: sourceText } };
const sources = [{ id: url, text: sourceText, instructionAuthority: 'none' as const }];
const patch = (edits: unknown[], baseBodyVersionId = 'body') => ({ edits, baseBodyVersionId });

test('the persuasion reviewer is limited to at most two concrete, uniquely anchored argument issues', () => {
  assert.deepEqual(validatePersuasionFindings([], body), []);
  assert.deepEqual(validatePersuasionFindings([finding], body), [finding]);
  for (const findings of [[finding, finding, finding], [finding, finding], [{ ...finding, quote: title }],
    [{ ...finding, quote: '稿件没有这句话。' }], [{ ...finding, kind: 'process_note' }], [{ ...finding, recovery: {} }]]) {
    assert.throws(() => validatePersuasionFindings(findings, body), { code: 'REVIEW_FINDINGS_INVALID' });
  }
});

test('lint preserves unrelated text and rejects stale, unsupported, ambiguous and structural edits', () => {
  const expected = body.replace(materialEdit.quote, materialEdit.replacement);
  assert.equal(applyLintEdits(body, 'body', patch([materialEdit]), sources).content, expected);
  assert.equal(applyLintEdits(body, 'body', patch([]), sources).content, body);
  assert.throws(() => applyLintEdits(body, 'body', patch([materialEdit], 'old'), sources), { code: 'FINAL_LINT_INVALID' });
  const wording = { kind: 'wording', quote: '算法', replacement: '分配规则', reason: '上下文是分奖金。' };
  for (const edits of [[{ ...materialEdit, source: { ...materialEdit.source, quote: '不存在的支持材料' } }],
    [{ ...materialEdit, source: { ...materialEdit.source, id: 'another-report' } }],
    [{ ...wording, quote: title }], [{ ...wording, quote: body }], [{ ...wording, quote: '奖金' }],
    [{ ...wording, replacement: '规则。换个新论点。' }], [{ ...wording, replacement: '分配\n\n规则' }],
    [wording, { ...wording, quote: '一套算法' }], [{ ...wording, kind: 'inference' }]]) {
    assert.throws(() => applyLintEdits(body, 'body', patch(edits), sources), { code: 'FINAL_LINT_INVALID' });
  }
});

test('review repairs separate the exact source from the replacement and protect concise hypotheses', () => {
  const anchors = [{ id: 'f1', quote: claim }];
  const hypothesis = { findingId: 'f1', kind: 'hypothesis', condition: '公司只公布工资区间', consequence: '员工可能还是算不出奖金' };
  const result = applyReviewEdits(body, 'body', patch([hypothesis]), anchors, sources);
  const sentence = '如果公司只公布工资区间，员工可能还是算不出奖金。';
  assert.equal(result.content, body.replace(claim, sentence));
  assert.deepEqual(result.protectedHypotheses, [sentence]);
  const source = { id: url, quote: sourceText };
  const sourceEdit = { findingId: 'f1', kind: 'source', source, replacement: correction };
  assert.equal(applyReviewEdits(body, 'body', patch([sourceEdit]), anchors, sources).content, body.replace(claim, correction));
  const recordedSource = { findingId: 'f1', kind: 'source', source };
  assert.equal(applyReviewEdits(body, 'body', patch([recordedSource]), anchors, sources, true).content, body.replace(claim, sourceText));
  assert.equal(applyReviewEdits(body, 'body', patch([{ ...hypothesis, lead: '要是' }]), anchors, sources).protectedHypotheses[0],
    '要是公司只公布工资区间，员工可能还是算不出奖金。');
  for (const edit of [recordedSource, { ...sourceEdit, source: { ...source, quote: '已有法院支持开除。' } },
    { ...sourceEdit, replacement: '# 不能换标题' }, { ...sourceEdit, replacement: '第一段\n\n第二段' },
    { ...sourceEdit, replacement: claim + correction },
    { ...hypothesis, consequence: '员工可能算不出奖金。已有法院支持开除。' },
    { ...hypothesis, findingId: 'unrelated' }, { ...hypothesis, replacement: '另有法院支持开除。' }]) {
    assert.throws(() => applyReviewEdits(body, 'body', patch([edit]), anchors, sources), { code: 'REVIEW_EDITS_INVALID' });
  }
  assert.throws(() => applyLintEdits(result.content, 'body', patch([{ kind: 'wording', quote: '如果公司只公布工资区间，',
    replacement: '公司只公布工资区间，', reason: '试图去掉条件。' }]), sources, result.protectedHypotheses), { code: 'FINAL_LINT_INVALID' });
});

test('a sourced correction replaces the anchored paragraph only, preserving the title and separators', () => {
  const caseParagraph = `公司先公布工资区间。${claim}员工于是问奖金怎么算。`;
  const article = [title, opening, caseParagraph, attribution].join('\r\n\r\n');
  const result = applyReviewEdits(article, 'body', patch([{ findingId: 'f1', kind: 'source', replacement: correction,
    source: { id: url, quote: sourceText } }]), [{ id: 'f1', quote: claim }], sources);
  assert.equal(result.content, article.replace(caseParagraph, correction));
});

for (const noEdits of [false, true]) test(`the saved article goes through only targeted review and lint (empty: ${noEdits})`, async () => {
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') {
        assert.equal(state.artifacts[0].content, body);
        assert.equal(state.reviewOutputSchema.properties.findings.maxItems, 2);
        assert.equal(state.reviewOutputSchema.properties.reading, undefined);
        return { findings: noEdits ? [] : [finding] };
      }
      if (stage === 'central_revision') {
        const target = state.paragraphScope.paragraphs.find((p: { text: string }) => p.text === claim);
        assert.deepEqual(state.paragraphScope.editableParagraphIds, noEdits ? [] : [target.id]);
        assert.deepEqual(state.sources, sources);
        return { reviewEdits: { baseBodyVersionId: state.baseBodyVersionId,
          edits: noEdits ? [] : [{ findingId: state.revisionFeedback.findings[0].id, kind: 'source',
            source: { id: url, quote: sourceText }, replacement: correction }] } };
      }
      assert.equal(state.body, noEdits ? body : body.replace(claim, correction));
      assert.deepEqual(state.sources, sources);
      assert.deepEqual(state.lintOutputSchema.required, ['lintEdits']);
      return { lintEdits: patch(noEdits ? [] : [materialEdit], state.baseBodyVersionId) };
    },
  });
  assert.deepEqual(replay.completedStages, ['research', 'outline', 'draft', 'review_editor', 'central_revision', 'language_review']);
  assert.equal(replay.reviewRequests.length, 3);
  assert.equal(replay.bodyVersions.length, noEdits ? 1 : 3);
  assert.equal(replay.finalBody, noEdits ? body : body.replace(claim, correction).replace(materialEdit.quote, materialEdit.replacement));
});
