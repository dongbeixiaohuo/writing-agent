import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { applyLintEdits, applyReviewEdits, bindReviewExcerpt, findAdjacentRepeatCandidates } from '../src/focused-review.js';
import { articleParagraphs } from '../src/paragraph-revision.js';
import { assertCleanBodyStageContent } from '../src/workflow-tools.js';
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
const diagnosis = { quote: claim, kind: 'inference', severity: 'required', issue: '如果奖金另算，工资范围算不出奖金。' };
const finding = { ...diagnosis, evidenceIds: [] };
const materialEdit = { kind: 'material', quote: '公开奖金区间', replacement: '公开固定工资区间', reason: '范围不符。',
  source: { id: url, quote: sourceText } };
const sources = [{ id: url, text: sourceText, instructionAuthority: 'none' as const }];
const patch = (edits: unknown[], baseBodyVersionId = 'body') => ({ edits, baseBodyVersionId });
const rejectedIndexes = (result: ReturnType<typeof applyLintEdits>, code = 'FINAL_LINT_INVALID') =>
  result.rejected.filter(item => item.code === code).map(item => item.index);

test('the persuasion reviewer is limited to at most two concrete, uniquely anchored argument issues', () => {
  assert.deepEqual(validatePersuasionFindings([], body), []);
  assert.equal(validatePersuasionFindings([finding], body)[0]?.issue, finding.issue);
  assert.deepEqual(validatePersuasionFindings([diagnosis], body)[0]?.evidenceIds, []);
  for (const findings of [[finding, finding, finding], [finding, finding], [{ ...finding, quote: title }],
    [{ ...finding, quote: '稿件没有这句话。' }], [{ ...finding, kind: 'process_note' }], [{ ...finding, recovery: {} }],
    [{ ...finding, repairTarget: '主笔可以直接抄这句。' }], [{ ...finding, evidenceIds: ['E042'] }]]) {
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
    [{ ...wording, kind: 'inference' }]]) {
    const invalid = applyLintEdits(body, 'body', patch(edits), sources);
    assert.deepEqual(rejectedIndexes(invalid), [1]);
    assert.equal(invalid.content, body);
  }
  const overlapping = applyLintEdits(body, 'body', patch([wording, { ...wording, quote: '一套算法' }]), sources);
  assert.deepEqual(rejectedIndexes(overlapping), [2]);
  assert.equal(overlapping.content, body.replace(wording.quote, wording.replacement));
});

test('final reading keeps an inference about the figures while screening an actual source note', () => {
  const original = '至于公司整体毛利率和单个项目回本的关系，材料没有拆开。';
  const comparison = '这是公司整体的毛利率，不能单凭这 82%，认定一个项目已经回本。';
  const disclosure = '公司年报没有单列各项目的交付成本。';
  const note = '这是一则后人记述，细节未必都能核实。';
  const article = ['# 两笔账', opening, original, disclosure, correction].join('\n\n');
  const lint = applyLintEdits(article, 'body', patch([
    { kind: 'wording', quote: original, replacement: comparison, reason: '分清指标的统计单位。' },
    { kind: 'context', quote: correction, replacement: note, reason: '试图把审校说明带回正文。' },
  ]), [], [], { validateBody: (candidate, baseline) => assertCleanBodyStageContent('language_review', candidate, baseline, 'reader_review') });
  assert.deepEqual(lint.appliedIndexes, [1]);
  assert.deepEqual(lint.rejected.map(edit => [edit.index, edit.code]), [[2, 'BODY_STAGE_CONTAINS_EDITORIAL_CAVEATS']]);
  assert.equal(lint.content, article.replace(original, comparison));
  assert.doesNotThrow(() => assertCleanBodyStageContent('language_review',
    article.replace(original, '一个班的平均分不能证明每个孩子都有进步。'), article, 'reader_review'));
  assert.throws(() => assertCleanBodyStageContent('language_review',
    article.replace(original, '手头的材料不足以证明我们想说的结论。'), article, 'reader_review'),
    { code: 'BODY_STAGE_CONTAINS_EDITORIAL_CAVEATS' });
});

test('trims an unattributed research aside only when the article already states a self-contained distinction', () => {
  const aside = '至于这 82% 里有多少来自成熟客户占比、定价结构，材料没有拆开，';
  const limit = '不能把公司整体毛利率当成 FDE 单项目回本的证据。';
  const original = 'Palantir 的 82% 毛利率是公司整体口径。' + aside + limit;
  const quote = '他当时说：“材料没有拆清各店的贡献，不能把总额当成一家店的收入。”';
  const filing = '这份年报没有分别披露各分部的贡献，不能把集团的利润当成子公司的利润。';
  const uniqueNumber = '至于上一年的 36% 有多少来自新店，材料没有拆开，不能把当年的总收入当成长期收入。';
  const protectedSentence = '手头材料没有拆清，不能把报价当成最终到手金额。';
  const necessaryBreakdown = '数据没有拆分儿童和成年人，不能把总体发生率当成儿童的发生率。';
  const physicalMaterial = '材料没有拆开包装验收，不能把到货当成验收完毕。';
  const intro = '让读者看到一份材料的内容。';
  const narrative = '# 看两笔账\n\n' + [intro,original,quote,filing,uniqueNumber,protectedSentence,necessaryBreakdown,physicalMaterial].join('\n\n');
  const result = applyLintEdits(narrative, 'b', patch([], 'b'), [], [protectedSentence], { trimEditorialAsides: true });
  assert.equal(result.content, narrative.replace(aside, ''));
  assert.deepEqual(result.editorialCuts.filter(c => c.applied), [{ paragraphId: 'p3', removed: aside, applied: true }]);
  assert.equal(result.editorialCuts.find(c => c.paragraphId === 'p7')?.applied, false);
  assert.equal(applyLintEdits(result.content, 'b', patch([], 'b'), [], [protectedSentence], { trimEditorialAsides: true }).content, result.content);
  const rewrite = '全区营业额另有统计；各门店分别贡献了多少，现有数据无法拆开计算，因此不能把全区收入当成单店利润。';
  const another = applyLintEdits(narrative, 'b', patch([{ kind:'context', quote: original, replacement:rewrite, reason:'分清统计单位。' }], 'b'),
    [], [protectedSentence], { trimEditorialAsides: true });
  assert.deepEqual(another.appliedIndexes, [1]);
  assert.equal(another.content, narrative.replace(original,'全区营业额另有统计；不能把全区收入当成单店利润。'));
  const oldSaved = '毛利率是公司整体口径。材料没有拆清各因素分别贡献了多少，不能把它当成单个项目回本的证据。';
  assert.equal(applyLintEdits(oldSaved, 'b', patch([], 'b'), [], [], { trimEditorialAsides: true }).content,
    '毛利率是公司整体口径。不能把它当成单个项目回本的证据。');
  const repeated = '# 多个部门\n\n' + Array.from({ length: 101 }, (_, i) =>
    `部门${i + 1}公布了收入。材料没有拆开，不能把总额当成一家门店的收入。`).join('\n\n');
  const repeatedResult = applyLintEdits(repeated, 'b', patch([], 'b'), [], [], { trimEditorialAsides: true });
  assert.equal(repeatedResult.content, repeated);
  assert.equal(repeatedResult.editorialCuts.length, 101);
  assert.ok(repeatedResult.editorialCuts.every(cut => !cut.applied), 'a repeated anchor is ambiguous and must survive');
});

test('lint accepts a uniquely quoted full paragraph longer than one line without expanding the edit', () => {
  const paragraph = `公开的是固定工资。\n${'后面的材料进一步描述了固定工资的发放规则。'.repeat(18)}员工仍然要求说明怎么算奖金。`;
  assert.ok(paragraph.length > 320);
  const input = [title, opening, paragraph, attribution].join('\n\n');
  const edit = { ...materialEdit, quote: paragraph, replacement: correction };
  const result = applyLintEdits(input, 'body', patch([edit]), sources);
  assert.deepEqual(result.appliedIndexes, [1]);
  assert.equal(result.content, input.replace(paragraph, correction));
  const repeated = applyLintEdits(input + '\n\n' + paragraph, 'body', patch([edit]), sources);
  assert.deepEqual(rejectedIndexes(repeated), [1]);
});

test('reading edits do not import a sample size from another section when clarifying a reference', () => {
  const first = '调查纳入100款新能源车型，其中60款纯电车型的电池单件零整比下降。';
  const later = '这一零整比变化离单次维修费还有距离。';
  const note = '这里要收一个边界。';
  const article = ['# 续保', '## 样本', first, '## 保费', note + '续保看的是另一笔账。', later].join('\n\n');
  const wrongScope = { kind: 'wording', quote: later, replacement: '前述100款新能源样本车型的电池单件零整比下降。', reason: '指代不清。' };
  const removeNote = { kind: 'wording', quote: note, replacement: '', reason: '编辑的过场话。' };
  const result = applyLintEdits(article, 'body', patch([wrongScope, removeNote]), []);
  assert.deepEqual(result.appliedIndexes, [2]);
  assert.match(result.rejected[0]!.message, /100款/u);
  assert.equal(result.content, article.replace(note, ''));
  // A reference can stay qualitative, and an in-place edit can retain its existing denominator.
  const echo = { ...wrongScope, replacement: '前面说的是电池配件价格。' };
  const local = { ...wrongScope, quote: first, replacement: '这100款样本车型里，60款纯电车型的电池单件零整比下降。' };
  assert.deepEqual(applyLintEdits(article, 'body', patch([echo, local]), []).appliedIndexes, [1, 2]);
});

test('language review can put a study finding and its adjacent caveat into one grounded paragraph', async () => {
  const first = '调查发现，使用者在找资料时感觉省力。';
  const second = '这是一项面向二十名读者的自报调查。';
  const evidence = '二十名受访读者自述，使用工具后查找资料感觉更快。';
  const article = [title, opening, '## 调查', first, second, '## 下一节', '核对时，读者要自己回到原文。'].join('\r\n\r\n');
  const source = { id: url, quote: evidence };
  const savedSources = [{ id: url, text: evidence, instructionAuthority: 'none' as const }];
  const merge = { kind: 'merge', quote: first, nextQuote: second,
    replacement: '二十名受访读者说，用工具找资料时感觉更快。', reason: '把自报范围同调查发现一起交给读者。', source };
  const expected = article.replace(`${first}\r\n\r\n${second}`, merge.replacement);
  assert.equal(applyLintEdits(article, 'body', patch([merge]), savedSources).content, expected);
  for (const bad of [
    { ...merge, nextQuote: '核对时，读者要自己回到原文。' },
    { ...merge, quote: '## 调查', nextQuote: first },
    { ...merge, quote: second, nextQuote: '## 下一节' },
    { ...merge, source: { ...source, quote: '没有找到这项材料。' } },
    { ...merge, replacement: '## 覆盖标题' },
  ]) assert.deepEqual(rejectedIndexes(applyLintEdits(article, 'body', patch([bad]), savedSources)), [1]);
  assert.deepEqual(rejectedIndexes(applyLintEdits(article, 'body', patch([merge]), savedSources, [second])), [1]);
  assert.deepEqual(rejectedIndexes(applyLintEdits(article, 'body', patch([merge, { kind: 'wording', quote: second, replacement: '另写这段。',
    reason: '同一段已参加合并。' }]), savedSources)), [2]);

  const experiment = { ...fixture, firstReading: { ...firstReading, text: `${sourceText}\n${evidence}` } };
  const replay = await replayReadingHandoff(experiment, 'not_authorized', { body: article,
    answer(request, stage) {
      if (stage === 'review_editor') return { findings: [] };
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'central_revision') return { reviewEdits: patch([], state.baseBodyVersionId) };
      assert.equal(state.body, article);
      return { lintEdits: patch([merge], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('language review repairs a stale subheading and combines repeated policy explanations with both sources', async () => {
  const heading = '## 油钱变成了修车账单 ##';
  const lead = '少加的油留在车主的预算里，保费按预计赔付定价。';
  const first = '2025年指导意见提出开放三电配件供给。';
  const second = '2026年通知鼓励以修代换，并推进车型综合分级。';
  const recap = '开放三电配件是给修理厂更多进货渠道，以修代换则是能修的部件尽量修。';
  const ending = '省下的油钱没有抵消更高的维修成本。';
  const policyUrl = 'https://report.example.org/repair';
  const article = [title, lead, heading, opening, '## 政策', first, second, recap, ending].join('\r\n\r\n');
  const source = { id: url, quote: first };
  const otherSource = { id: policyUrl, quote: second };
  const merge = { kind: 'merge', quote: first, nextQuote: second, followingQuote: recap,
    replacement: '2025年指导意见推动三电配件开放。2026年通知鼓励能修则修，也提出按车型细分风险。',
    reason: '把同一措施说一次，保留两份文件各自的内容。', source, supportingSources: [otherSource] };
  const subheading = { kind: 'section_heading', quote: heading, replacement: '保费按哪本账定', reason: '正文已分开两笔支出。' };
  const conclusion = { kind: 'context', quote: ending, replacement: '每趟少花的油钱到账了。续保时，车主还得面对另一张报价单。',
    reason: '保留反差，去掉材料未支持的金额判断。' };
  const edits = [merge, subheading, conclusion];
  const expected = article.replace(heading, '## 保费按哪本账定 ##')
    .replace([first, second, recap].join('\r\n\r\n'), merge.replacement).replace(ending, conclusion.replacement);
  const savedSources = [source, otherSource].map(ref => ({ id: ref.id, text: ref.quote, instructionAuthority: 'none' as const }));
  for (const edit of [{ ...subheading, kind: 'wording' }, { ...subheading, quote: title }, { ...subheading, quote: '油钱变成了修车账单' },
    { ...subheading, replacement: '### 改层级' }, { ...subheading, quote: first },
    { ...merge, followingQuote: ending }, { ...merge, supportingSources: [] }, { ...merge, supportingSources: [source] },
    { ...merge, supportingSources: [{ ...otherSource, quote: '未经提供的材料' }] }]) {
    assert.deepEqual(rejectedIndexes(applyLintEdits(article, 'body', patch([edit]), savedSources)), [1]);
  }
  assert.deepEqual(rejectedIndexes(applyLintEdits([title, '```md', heading, '```'].join('\n\n'), 'body', patch([subheading]), savedSources)), [1]);
  assert.equal(applyLintEdits(article, 'body', patch(edits), savedSources).content, expected);

  const firstReading = { ...fixture.firstReading, text: first };
  const secondReading = { ...fixture.firstReading, url: policyUrl, finalUrl: policyUrl, text: second, bodyHash: 'policy-fixture' };
  const ledger = JSON.parse(fixture.researchLedger);
  const claimFrom = (reading: typeof firstReading, id: string) => ({ ...ledger.claims[0], evidence_id: id,
    claim_text: reading.text, source_quote: reading.text, source_url: reading.url });
  const replay = await replayReadingHandoff({ ...fixture, firstReading, supplement: secondReading,
    researchLedger: JSON.stringify({ ...ledger, claims: [claimFrom(firstReading, 'E001'), claimFrom(secondReading, 'E002')],
      editorialPlan: editorialPlanFixture(['E001', 'E002']) }),
    assessment: { ...fixture.assessment, readingRoute: { question: topic,
      moments: [{ quote: first, sourceUrl: url, interest: '配件能从哪里买。' }] } },
    recordedResearch: { queries: new Map(), followupQueries: [], readings: [firstReading, secondReading] },
  }, 'not_authorized', { body: article,
    answer(request, stage) {
      if (stage === 'review_editor') return { findings: [] };
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'central_revision') return { reviewEdits: patch([], state.baseBodyVersionId) };
      assert.deepEqual(state, { actor: 'language_review', stage: 'language_review', baseBodyVersionId: state.baseBodyVersionId, body: article });
      assert.match(request.messages[0]!.content, /小标题和结尾也要接得上正文/u);
      const badContext = { kind: 'context', quote: opening, replacement: '这是一则后人记述，细节未必都能核实。', reason: '试图插入审校说明。' };
      return { lintEdits: patch([null, merge, { ...subheading, quote: title }, badContext, subheading, conclusion], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
  assert.equal(replay.reviewRequests.length, 3);
  const save = replay.runEvents.findLast(event => event.type === 'tool.completed' &&
    (event.payload.result as any).result?.stage === 'language_review')!.payload.result as any;
  assert.deepEqual(save.result.lintAppliedIndexes, [2, 5, 6]);
  assert.deepEqual(save.result.lintRejectedEdits.map((item: { index: number; code: string }) => [item.index, item.code]),
    [[1, 'FINAL_LINT_INVALID'], [3, 'FINAL_LINT_INVALID'], [4, 'BODY_STAGE_CONTAINS_EDITORIAL_CAVEATS']]);
});

test('review repairs keep legacy sentence edits readable for recovery', () => {
  const anchors = [{ id: 'f1', quote: claim }];
  const hypothesis = { findingId: 'f1', kind: 'hypothesis', condition: '公司只公布工资区间', consequence: '员工可能还是算不出奖金' };
  const result = applyReviewEdits(body, 'body', patch([hypothesis]), anchors, sources, true);
  const sentence = '如果公司只公布工资区间，员工可能还是算不出奖金。';
  assert.equal(result.content, body.replace(claim, sentence));
  assert.deepEqual(result.protectedHypotheses, [sentence]);
  const source = { id: url, quote: sourceText };
  const sourceEdit = { findingId: 'f1', kind: 'source', source, replacement: correction };
  assert.equal(applyReviewEdits(body, 'body', patch([sourceEdit]), anchors, sources).content, body.replace(claim, correction));
  const recordedSource = { findingId: 'f1', kind: 'source', source };
  assert.equal(applyReviewEdits(body, 'body', patch([recordedSource]), anchors, sources, true).content, body.replace(claim, sourceText));
  assert.equal(applyReviewEdits(body, 'body', patch([{ ...hypothesis, lead: '要是' }]), anchors, sources, true).protectedHypotheses[0],
    '要是公司只公布工资区间，员工可能还是算不出奖金。');
  for (const edit of [hypothesis, { kind: 'remove', findingId: 'f1' }, recordedSource, { ...sourceEdit, source: { ...source, quote: '已有法院支持开除。' } },
    { ...sourceEdit, replacement: '# 不能换标题' }, { ...sourceEdit, replacement: '第一段\n\n第二段' },
    { ...sourceEdit, replacement: claim + correction },
    { ...hypothesis, consequence: '员工可能算不出奖金。已有法院支持开除。' },
    { ...hypothesis, findingId: 'unrelated' }, { ...hypothesis, replacement: '另有法院支持开除。' }]) {
    assert.throws(() => applyReviewEdits(body, 'body', patch([edit]), anchors, sources), { code: 'REVIEW_EDITS_INVALID' });
  }
  assert.deepEqual(rejectedIndexes(applyLintEdits(result.content, 'body', patch([{ kind: 'wording', quote: '如果公司只公布工资区间，',
    replacement: '公司只公布工资区间，', reason: '试图去掉条件。' }]), sources, result.protectedHypotheses)), [1]);
});

test('final lint reconnects a missing premise in its own paragraph, including after a legacy sentence edit', () => {
  const advice = '可以先问主管，哪几种情况需要下班后回消息。';
  const ending = `${advice}他也可能不肯公开说清楚。讨论能不能回，先得知道谁在定规矩。`;
  const draft = [title, opening, ending].join('\r\n\r\n');
  const anchors = [{ id: 'f1', quote: advice }];
  const paragraph = { findingId: 'f1', kind: 'paragraph',
    replacement: '先问清哪几种情况需要下班后回消息。主管若连这个问题也不愿说清，员工就只能猜。' };
  assert.deepEqual(applyReviewEdits(draft, 'body', patch([paragraph]), anchors, sources),
    { content: draft.replace(ending, paragraph.replacement), protectedHypotheses: [] });
  assert.throws(() => applyReviewEdits(draft, 'body', patch([paragraph, paragraph]), anchors, sources), { code: 'REVIEW_EDITS_INVALID' });
  const legacy = applyReviewEdits(draft, 'body', patch([{ findingId: 'f1', kind: 'hypothesis', condition: '员工要求定规矩',
    consequence: '主管可能会拒绝' }]), anchors, sources, true);
  const context = { kind: 'context', quote: '员工要求定规矩', replacement: paragraph.replacement,
    reason: '前面的修改删掉了要约定的具体事。' };
  assert.equal(applyLintEdits(legacy.content, 'body', patch([context]), sources, legacy.protectedHypotheses).content,
    draft.replace(ending, paragraph.replacement));
  for (const change of [{ ...context, quote: title }, { ...context, replacement: '' },
    { ...context, replacement: '这是一段。\n\n这是下一段。' }]) {
    assert.deepEqual(rejectedIndexes(applyLintEdits(legacy.content, 'body', patch([change]), sources, legacy.protectedHypotheses)), [1]);
  }
});

test('a sourced correction replaces the anchored paragraph only, preserving the title and separators', () => {
  const caseParagraph = `公司先公布工资区间。${claim}员工于是问奖金怎么算。`;
  const article = [title, opening, caseParagraph, attribution].join('\r\n\r\n');
  const result = applyReviewEdits(article, 'body', patch([{ findingId: 'f1', kind: 'source', replacement: correction,
    source: { id: url, quote: sourceText } }]), [{ id: 'f1', quote: claim }], sources);
  assert.equal(result.content, article.replace(caseParagraph, correction));
});

test('one finding can fix the same inference in the body and ending without widening other edits', async () => {
  const anchor = '只要公开工资区间，员工就能算出奖金。';
  const repeated = '看过工资范围，年终奖便能自己算清。';
  const heading = '## 年底怎么收尾';
  const detail = '同事举了一个工资区间的例子。';
  const ending = `${repeated}先把两笔钱分开聊。`;
  const article = [title, opening, anchor, detail, heading, ending].join('\r\n\r\n');
  const endingEdit = { paragraphId: 'p6', quote: repeated, reason: '仍从固定工资范围推出可以算出奖金。',
    replacement: '工资是工资，奖金还得看它按什么分。先把两笔钱分开聊。' };
  const expected = article.replace(anchor, correction).replace(ending, endingEdit.replacement);
  const proposal = { findingId: 'f1', kind: 'paragraph', replacement: correction, relatedEdits: [endingEdit] };
  const anchors = [{ id: 'f1', quote: anchor }];
  assert.equal(applyReviewEdits(article, 'body', patch([proposal]), anchors, sources).content, expected);
  assert.equal(applyReviewEdits(article, 'body', patch([proposal]), anchors, sources, true).content, expected);
  for (const invalid of [
    { ...endingEdit, paragraphId: 'p4' },
    { ...endingEdit, quote: '并未出现的推断。' },
    { ...endingEdit, paragraphId: 'p5', quote: heading },
    { ...endingEdit, replacement: '# 新标题' },
    { ...endingEdit, replacement: ending + '再说明一遍。' },
    { ...endingEdit, paragraphId: 'p3', quote: anchor },
  ]) {
    assert.throws(() => applyReviewEdits(article, 'body', patch([{ ...proposal, relatedEdits: [invalid] }]), anchors, sources),
      { code: 'REVIEW_EDITS_INVALID' });
  }
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [{ ...finding, quote: anchor,
        issue: '知道“工资范围”仍然无法推出奖金，因为奖金另算。' }] };
      if (stage === 'central_revision') {
        assert.match(request.messages[0]!.content, /同一个不成立判断/u);
        assert.deepEqual(state.paragraphScope.directParagraphIds, ['p3']);
        assert.deepEqual(state.paragraphScope.endingParagraphIds, ['p6']);
        assert.deepEqual(state.relatedEndingCandidates, [{ findingId: state.revisionFeedback.findings[0].id,
          paragraphs: [{ id: 'p6', text: ending }] }]);
        assert.ok(state.paragraphScope.paragraphs.every((p: Record<string, unknown>) => !('editable' in p)));
        return { reviewEdits: patch([{ ...proposal, findingId: state.revisionFeedback.findings[0].id }], state.baseBodyVersionId) };
      }
      assert.equal(state.body, expected);
      return { lintEdits: patch([], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('a finding anchored in the close can repair the original inference before the closing section', async () => {
  const early = '报表没对上，就是交接漏了一笔。';
  const late = '忙到最后还没对上报表，就知道是谁的交接出了问题。';
  const routine = '她把昨天的交接表和今天的报表并排放在桌上。';
  const article = [title, opening, '## 交接', early, '## 收尾', routine, late].join('\r\n\r\n');
  const narrowed = '报表没对上，先查交接表里哪一项还没核清。';
  const close = '临下班，她手里还翻着那张交接表。';
  const expected = article.replace(early, narrowed).replace(late, close);
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const message = request.messages[1]!.content;
      const state = JSON.parse(message.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [{ ...finding, quote: late,
        issue: '报表没对上就判断交接有问题，读者会查错方向。' }] };
      if (stage === 'central_revision') {
        assert.match(request.messages[0]!.content, /原地收窄归因/u);
        assert.match(request.messages[0]!.content, /约80–120字/u);
        assert.match(message, /即使不在 directParagraphIds/u);
        assert.deepEqual(state.paragraphScope.directParagraphIds, ['p7']);
        assert.deepEqual(state.precedingBody, [{ id: 'p2', text: opening }, { id: 'p4', text: early }]);
        return { reviewEdits: patch([{ findingId: state.revisionFeedback.findings[0].id, kind: 'paragraph', replacement: close,
          relatedEdits: [{ paragraphId: 'p4', quote: early, reason: '原来把同一个迹象当成对交接的判断。', replacement: narrowed }] }],
        state.baseBodyVersionId) };
      }
      assert.equal(state.body, expected);
      return { lintEdits: patch([], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('an explicitly selected excerpt binds the earlier sentence and writes the two accepted closing edits locally', async () => {
  const early = '报表没对上，就是交接漏了一笔。';
  const late = '对不上的地方，就是交接出错的位置。';
  const routine = '她把昨天的交接表和今天的报表并排放在桌上。';
  const oldClose = '忙到最后还没对上报表，就能知道该找谁。';
  const after = '报表没对上，先查交接表里哪一项还没核清。';
  const close = '临下班，她手里还翻着那张交接表。';
  const article = [title, opening, `有三份报表要交。${early}这份今天交。`, routine + late, oldClose].join('\r\n\r\n');
  const baseBodyHash = createHash('sha256').update(article).digest('hex');
  const selection = { baseBodyHash, findingQuote: late, quote: early,
    fixedEdits: [{ quote: late, replacement: '' }, { quote: oldClose, replacement: close }] };
  const modelText = `${after}还可以再加一段保证这套办法有效。`;
  const expected = article.replace(early, after).replace(late, '').replace(oldClose, close);
  const base = { id: 'base', contentHash: baseBodyHash, content: article };
  const anchored = [{ id: 'selected', quote: late }];
  assert.throws(() => bindReviewExcerpt({ ...base, contentHash: 'old' }, anchored, selection), { code: 'REVIEW_EDITS_INVALID' });
  assert.throws(() => bindReviewExcerpt(base, [], selection), { code: 'REVIEW_EDITS_INVALID' });
  assert.throws(() => bindReviewExcerpt(base, anchored, { ...selection, quote: title }), { code: 'REVIEW_EDITS_INVALID' });
  assert.throws(() => bindReviewExcerpt(base, anchored, { ...selection, quote: late }), { code: 'REVIEW_EDITS_INVALID' });
  const bound = bindReviewExcerpt(base, anchored, selection);
  assert.throws(() => bound.apply({ baseBodyVersionId: 'other', replacement: modelText }), { code: 'REVIEW_EDITS_INVALID' });
  assert.equal(bound.apply({ baseBodyVersionId: 'base', replacement: modelText }).content, expected);

  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article, reviewExcerpt: selection,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [{ ...finding, quote: late }, { ...finding, quote: oldClose }] };
      if (stage === 'central_revision') {
        assert.deepEqual(state.target, { paragraphId: 'p3', quote: early });
        assert.equal(state.finding.quote, late);
        assert.equal(state.paragraphScope, undefined);
        assert.equal(state.revisionOutputSchema.properties.reviewEdits.properties.baseBodyVersionId.const, state.baseBodyVersionId);
        return { reviewEdits: { baseBodyVersionId: state.baseBodyVersionId, replacement: modelText } };
      }
      assert.equal(state.body, expected);
      return { lintEdits: patch([], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('the normal focused-review handoff binds a verified earlier inference to a sentence edit', async () => {
  const origin = '表没对上，就是交接漏了一笔。';
  const echo = '这一次对不上，足够认定要追问交接人。';
  const context = '桌上还有昨天的交接表。';
  const narrowed = '表没对上，先对一遍交接时记下的项目。';
  const close = '她把两张表并排摊开。';
  const article = [title, opening, `下班前要核两张表。${origin}${context}`, '## 收尾', echo].join('\n\n');
  const issue = { ...finding, quote: echo, originQuote: origin };
  assert.equal(validatePersuasionFindings([issue], article)[0]?.originQuote, origin);
  for (const originQuote of [null, '不存在的原句。', title, `${origin}${context}`]) {
    assert.equal(validatePersuasionFindings([{ ...issue, originQuote }], article)[0]?.originQuote, undefined);
  }
  const modelEdit = { findingId: 'f1', kind: 'sentence', replacement: `${narrowed}另外还应排除其它可能。`,
    relatedEdits: [{ paragraphId: 'p5', quote: echo, reason: '结尾重复使用同一个推断。', replacement: close }] };
  const anchored = [{ id: 'f1', quote: echo, originQuote: origin }];
  const expected = article.replace(origin, narrowed).replace(echo, close);
  assert.equal(applyReviewEdits(article, 'body', patch([modelEdit]), anchored, []).content, expected);
  assert.equal(applyReviewEdits(article, 'body', patch([modelEdit]), anchored, [], true).content, expected);
  assert.throws(() => applyReviewEdits(article, 'body', patch([{ ...modelEdit, kind: 'paragraph' }]), anchored, []),
    { code: 'REVIEW_EDITS_INVALID' });

  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [issue] };
      if (stage === 'central_revision') {
        const saved = state.revisionFeedback.findings[0];
        assert.equal(saved.originQuote, origin);
        assert.equal(saved.quote, echo);
        return { reviewEdits: patch([{ ...modelEdit, findingId: saved.id }], state.baseBodyVersionId) };
      }
      assert.equal(state.body, expected);
      return { lintEdits: patch([], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('drops independently removable claims in the body and ending and preserves the rest verbatim', () => {
  const anchor = '先问怎么交稿的人一定更熟悉流程。';
  const repeated = '第一句话暴露了这个人熟不熟悉手里的工作。';
  const draft = [title, `${anchor}规定的交稿时间没有变。`, '## 收尾', `再回到那个早晨。${repeated}纸上的交稿时间还是十点。`].join('\r\n\r\n');
  const related = { paragraphId: 'p4', quote: repeated, reason: '仍用第一反应诊断对流程的熟悉程度。' };
  const drop = { findingId: 'f1', kind: 'drop_claim', relatedEdits: [related] };
  const anchors = [{ id: 'f1', quote: anchor }];
  const expected = draft.replace(anchor, '').replace(repeated, '');
  assert.equal(applyReviewEdits(draft, 'body', patch([drop]), anchors, []).content, expected);
  assert.equal(applyReviewEdits(draft, 'body', patch([drop]), anchors, [], true).content, expected);
  for (const relatedEdits of [[{ ...related, quote: '暴露了这个人熟不熟悉手里的工作。' }], [related, related]]) {
    assert.throws(() => applyReviewEdits(draft, 'body', patch([{ ...drop, relatedEdits }]), anchors, []), { code: 'REVIEW_EDITS_INVALID' });
  }
});

test('checks applied lint patches for newly repeated adjacent study statements', () => {
  const first = '受访者自述的情况是：当他们对AI能力比较有信心时，会觉得批判性思考这件事变省力了；但当他们对自己的专业判断有信心时，反而会觉得评估和采用AI给出的答案更费劲。';
  const second = '信AI多的人，容易觉得核验这一步没那么费力；信自己多的人，反而更愿意在评估和采用AI答案上多花时间。';
  const repeat = '对AI能力更有信心的受访者，更容易觉得完成批判性思考任务没那么费力；对自身专业能力更有信心的受访者，则更容易觉得评估和采用AI答案更费劲。';
  const example = [title, '## 调查', first, second, '## 下一节', '别动这一段。'].join('\n\n');
  const evidence = [{ id: 'study', text: first, instructionAuthority: 'none' as const }];
  const edit = { kind: 'material', quote: second, replacement: repeat, reason: '保留调查的自报口径。', source: { id: 'study', quote: first } };
  const rejected = applyLintEdits(example, 'body', patch([edit]), evidence);
  assert.deepEqual(rejectedIndexes(rejected, 'FINAL_LINT_ADJACENT_REPEAT'), [1]);
  assert.deepEqual(rejected.rejected[0]!.paragraphPairs, [['p3', 'p4']]);
  const recovered = '数据和引文是谁查过的，才看得出核验落在谁手里。';
  assert.equal(applyLintEdits(example, 'body', patch([{ ...edit, replacement: recovered }]), evidence).content,
    example.replace(second, recovered));
  assert.equal(applyLintEdits(example, 'body', patch([edit]), evidence, [], { checkIntroducedRepeats: false }).content, example.replace(second, repeat));

  const measurements = [title, '## 实验', '54名大学生做了限时20分钟写作，第四轮换组。',
    '54人在20分钟内作答，第四轮只剩18人。'].join('\n\n');
  assert.ok(findAdjacentRepeatCandidates(articleParagraphs(measurements)).some(item => item.basis === 'measures' && !item.strong));
  assert.equal(applyLintEdits(measurements, 'body', patch([]), sources).content, measurements);
  assert.equal(findAdjacentRepeatCandidates(articleParagraphs(measurements.replace('\n\n54人', '\n\n## 另一节\n\n54人'))).length, 0);
});

test('lint only rejects the edit that removed the local comparison its wording still refers to', () => {
  const comparison = '零整比从49.59%降到44.17%，是样本比值。';
  const lead = '维修价格会影响成本端。';
  const reference = '这一零整比变化只说明样本中的配件价格占比有所下降。';
  const section = '## 政策效应';
  const ending = '两笔钱撞在同一只钱包。';
  const article = [title, '## 行业数据', comparison, section, lead + comparison, ending].join('\n\n');
  const heading = { kind: 'section_heading', quote: section, replacement: '成本从哪儿降', reason: '把问题说清。' };
  const edit = { kind: 'wording', quote: lead + comparison, replacement: lead + reference, reason: '压缩前文写过的数字。' };
  const close = { kind: 'wording', quote: ending, replacement: '续保时，两笔账会一块儿摆在车主眼前。', reason: '回到车主。' };
  const result = applyLintEdits(article, 'body', patch([heading, edit, close]), sources);
  assert.deepEqual(result.appliedIndexes, [1, 3]);
  assert.deepEqual(rejectedIndexes(result, 'FINAL_LINT_DETACHED_REFERENCE'), [2]);
  assert.deepEqual(result.rejected[0]!.reference, { paragraphId: 'p5', phrase: '这一零整比变化' });
  assert.equal(result.content, article.replace(section, '## ' + heading.replacement).replace(ending, close.replacement));

  for (const replacement of [
    lead + '前文的零整比数据看的是配件价格占比。',
    lead + '零整比下降。这一零整比变化只反映配件价格占比。',
    lead + '这一零整比变化（从49.59%降到44.17%）只反映样本中的价格占比。',
  ]) assert.deepEqual(applyLintEdits(article, 'body', patch([{ ...edit, replacement }]), sources).appliedIndexes, [1]);
  const neighboring = [title, section, comparison, reference, ending].join('\n\n');
  const removePremise = { ...edit, quote: comparison, replacement: lead };
  assert.deepEqual(rejectedIndexes(applyLintEdits(neighboring, 'body', patch([removePremise]), sources), 'FINAL_LINT_DETACHED_REFERENCE'), [1]);
  const oldReference = neighboring.replace(comparison, lead);
  assert.deepEqual(applyLintEdits(oldReference, 'body', patch([close]), sources).appliedIndexes, [1]);
});

test('final lint reads the bound article and can shorten just the later cross-section repeat', async () => {
  const claim = '交付变快，首单就一定能回本。';
  const earlier = '报告记下来的是整合平均 14 天，接入从 45 天减到 4 天。';
  const repeated = '再看一遍，整合平均14天，接入从45天减到4天。';
  const article = [title, opening, '## 交付耗时', earlier, '## 付款', claim, '结尾仍保留。'].join('\n\n');
  const newParagraph = `${repeated}先看谁愿意为这次交付付钱。`;
  const echo = '前面讲的是交付变快。';
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [{ ...finding, quote: claim, issue: '交付耗时不等于已经下单。' }] };
      if (stage === 'central_revision') {
        assert.match(request.messages[0]!.content, /最影响结论的读者疑问/u);
        return { reviewEdits: patch([{ findingId: state.revisionFeedback.findings[0].id, kind: 'paragraph', replacement: newParagraph }], state.baseBodyVersionId) };
      }
      assert.deepEqual(state, { actor: 'language_review', stage: 'language_review', baseBodyVersionId: state.baseBodyVersionId,
        body: article.replace(claim, newParagraph) });
      return { lintEdits: patch([{ kind: 'wording', quote: repeated, replacement: echo, reason: '数据已经说明。' }], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, article.replace(claim, newParagraph.replace(repeated, echo)));
  assert.deepEqual(replay.publicQueries, []);
});

test('final lint can remove a research note and clean an ending using only the bound manuscript', async () => {
  const start = '假如一年跑一万五千公里，这辆车一共省了六千块油钱。';
  const earlier = '车主续保时觉得“怎么又涨了”，要把续保报价和自己这款车所属车系的风险、赔付记录放在一起看，而不是拿这一年少加的几箱油去比。';
  const note = '接下来应分别核对电池和配件价格、维修渠道开放程度和车型风险定价怎样影响保费，并观察这些影响是否随时间变化。';
  const repeated = '保费涨的那部分，先要对着自己车系的赔付记录和配件价格看，而不是拿少加的几箱油去比。';
  const close = '六千块是一程一程省下的。续保多出的两千块，却得一笔付清。';
  const article = ['# 车险', start, '## 续保', earlier, '## 维修', '政策盯的是修车账单。' + note, repeated].join('\n\n');
  const expected = article.replace(note, '').replace(repeated, close);
  assert.equal(applyLintEdits(article, 'body', patch([]), []).content, article);

  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') return { findings: [] };
      if (stage === 'central_revision') {
        assert.match(request.messages[0]!.content, /末两段留给读者收束/u);
        return { reviewEdits: patch([], state.baseBodyVersionId) };
      }
      assert.equal(state.body, article);
      assert.match(request.messages[0]!.content, /假设已点明.*省掉第二次声明/u);
      return { lintEdits: patch([
        { kind: 'wording', quote: note, replacement: '', reason: '删去研究待办。' },
        { kind: 'context', quote: repeated, replacement: close, reason: '结尾回到开篇这笔账。' },
      ], state.baseBodyVersionId) };
    },
  });
  assert.equal(replay.finalBody, expected);
});

test('a changed instruction reaches the action sentence and its section heading without removing a necessary qualification', async () => {
  const heading = '## 先问报价软件三个问题';
  const advice = '用它之前，先问生成这份报价的软件是哪几项让总价变高了。请它解释一遍，就能知道自己该付多少钱。';
  const revisedAdvice = '拿到报价单，先对照自己勾选的项目。单上多出来的服务，请门店说明怎么计费。';
  const objection = '这不意味着话越肯定越不可信。';
  const next = '店员把原单翻了出来。';
  const limit = '报价不等于成交价，最后支付多少还要看双方确认的订单。';
  const article = [title, opening, heading, advice, objection + next, limit].join('\n\n');
  const newHeading = '拿到报价单，先核对自己选了什么';
  let revisionPrompt = '', lintPrompt = '';
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body: article,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') {
        assert.match(request.messages[0]!.content, /quote 就圈出让读者去做那件事的指令/u);
        return { findings: [{ ...finding, quote: '用它之前，先问生成这份报价的软件是哪几项让总价变高了。',
          issue: '报价软件不知道门店实际收取哪些费用，不能靠它验证自己的报价。' }] };
      }
      if (stage === 'central_revision') {
        revisionPrompt = request.messages[0]!.content;
        return { reviewEdits: patch([{ findingId: state.revisionFeedback.findings[0].id, kind: 'paragraph',
          replacement: revisedAdvice }], state.baseBodyVersionId) };
      }
      lintPrompt = request.messages[0]!.content;
      assert.deepEqual(state, { actor: 'language_review', stage: 'language_review',
        baseBodyVersionId: state.baseBodyVersionId, body: article.replace(advice, revisedAdvice) });
      return { lintEdits: patch([
        { kind: 'section_heading', quote: heading, replacement: newHeading, reason: '读者先核对单据，再问门店。' },
        { kind: 'wording', quote: objection, replacement: '', reason: '前文没有按语气判断报价。' },
      ], state.baseBodyVersionId) };
    },
  });
  assert.match(revisionPrompt, /原来的操作句/u);
  assert.match(lintPrompt, /谁.*什么时候.*向谁/u);
  assert.match(lintPrompt, /反驳.*误解/u);
  assert.equal(replay.finalBody, [title, opening, '## ' + newHeading, revisedAdvice, next, limit].join('\n\n'));
  assert.deepEqual(replay.publicQueries, []);
  const noChange = applyLintEdits(article, 'body', patch([
    { kind: 'section_heading', quote: heading, replacement: heading.slice(3), reason: '正文做法需改。' },
    { kind: 'wording', quote: objection, replacement: '', reason: '直接接店员的行动。' },
  ]), []);
  assert.match(noChange.rejected[0]!.message, /新小标题与原文相同/u);
  assert.equal(noChange.content, article.replace(objection, ''));
});

test('mixed review findings identify exactly which edit needs a sentence or a paragraph', () => {
  const first = '账目没对上，就是漏录了。', later = '看到账不对，就知道漏录了。';
  const instruction = '让录入的人对照自己填的数，就能保证账目无误。';
  const article = [title, opening + first, later, instruction].join('\n\n');
  const findings = [{ id: 'f1', quote: later, originQuote: first }, { id: 'f2', quote: instruction }];
  const narrow = { findingId: 'f1', kind: 'sentence', replacement: '账目没对上，先找出第一笔差额。' };
  const action = { findingId: 'f2', kind: 'paragraph', replacement: '拿到原始凭据，再请另一人核对金额。' };
  assert.throws(() => applyReviewEdits(article, 'body', patch([{ ...narrow, kind: 'paragraph' }, action]), findings, []),
    /edits\[0\]\.kind.*f1.*sentence/u);
  assert.throws(() => applyReviewEdits(article, 'body', patch([narrow, { ...action, kind: 'sentence' }]), findings, []),
    /edits\[1\]\.kind.*f2.*paragraph/u);
  assert.equal(applyReviewEdits(article, 'body', patch([narrow, action]), findings, []).content,
    article.replace(first, narrow.replacement).replace(instruction, action.replacement));
});

for (const severity of ['required', 'suggestion', null] as const) test(`the saved article goes through only targeted review and lint (${severity ?? 'no finding'})`, async () => {
  const noEdits = severity !== 'required';
  const replay = await replayReadingHandoff(fixture, 'not_authorized', { body,
    answer(request, stage) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
      if (stage === 'review_editor') {
        assert.equal(state.artifacts[0].content, body);
        assert.equal(state.reviewOutputSchema.properties.findings.maxItems, 2);
        assert.equal(state.reviewOutputSchema.properties.findings.items.properties.repairTarget, undefined);
        assert.equal(state.reviewOutputSchema.properties.reading, undefined);
        return { findings: severity ? [{ ...diagnosis, severity }] : [] };
      }
      if (stage === 'central_revision') {
        const target = state.paragraphScope.paragraphs.find((p: { text: string }) => p.text === claim);
        assert.deepEqual(state.paragraphScope.directParagraphIds, severity ? [target.id] : []);
        assert.deepEqual(state.sources, sources);
        assert.deepEqual(state.revisionFeedback.findings.map(({ issue, severity }: { issue: string; severity: string }) => [issue, severity]),
          severity ? [[finding.issue, severity]] : []);
        assert.ok(state.revisionFeedback.findings.every((item: Record<string, unknown>) => !('repairTarget' in item)));
        return { reviewEdits: { baseBodyVersionId: state.baseBodyVersionId,
          edits: noEdits ? [] : [{ findingId: state.revisionFeedback.findings[0].id, kind: 'source',
            source: { id: url, quote: sourceText }, replacement: correction }] } };
      }
      assert.equal(state.body, noEdits ? body : body.replace(claim, correction));
      assert.deepEqual(Object.keys(state).sort(), ['actor', 'baseBodyVersionId', 'body', 'stage']);
      const { source: _source, ...wording } = materialEdit;
      return { lintEdits: patch(noEdits ? [] : [{ ...wording, kind: 'wording' }], state.baseBodyVersionId) };
    },
  });
  assert.deepEqual(replay.completedStages, ['research', 'outline', 'draft', 'review_editor', 'central_revision', 'language_review']);
  assert.equal(replay.reviewRequests.length, 3);
  assert.equal(replay.bodyVersions.length, noEdits ? 1 : 3);
  assert.equal(replay.finalBody, noEdits ? body : body.replace(claim, correction).replace(materialEdit.quote, materialEdit.replacement));
});
