import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { factCheckCompletionSummary } from '../src/fact-summary.js';

const passedAssessment = (claims: readonly Record<string, unknown>[], noFactualClaimsReason = '') => ({
  status: 'passed',
  blockers: [],
  payload: {
    coverage: { body: true, title: true, distributionCopy: true },
    claims,
    noFactualClaimsReason,
  },
});

describe('fact-check completion summary', () => {
  it('keeps ordinary supported background in details, not a verbose main-chat audit', () => {
    const summary = factCheckCompletionSummary(passedAssessment([
      { claimId: 'C001', claimText: 'Brett 是一名编程 20 多年的程序员。', claimType: 'person',
        status: 'SUPPORTED', risk: 'green', supportScope: 'full', sourceReference: 'https://www.csdn.net/',
        verificationMethod: 'material_comparison', evidenceSummary: '超过20年与20多年一致，无需修改。' },
      { claimId: 'C002', claimText: '该视频发布于2026年9月。', claimType: 'date', checkReason: 'key_fact',
        status: 'SUPPORTED', risk: 'green', supportScope: 'full', sourceReference: 'https://video.example/record',
        verificationMethod: 'external_source', verificationRecordIds: ['read-video'], evidenceSummary: '视频页面记载发布日期。' },
    ]));
    assert.doesNotMatch(summary, /Brett|超过20年|20多年/u);
    assert.match(summary, /该视频发布于2026年9月/u);
    assert.match(summary, /外部来源核对.*1.*材料对照.*1/u);
    assert.match(summary, /事实核查.*详情/u);
    assert.doesNotMatch(summary, /- 依据：|- 来源：/u, 'normal facts should not expand into an audit');
  });

  it('prioritizes actual problems even after many supported claims and never announces a blocked report as exportable', () => {
    const assessment = passedAssessment([
      ...Array.from({ length: 10 }, (_, i) => ({ claimId: `C${i}`, claimText: `普通背景${i}`,
        status: 'SUPPORTED', risk: 'green', supportScope: 'full', verificationMethod: 'material_comparison' })),
      { claimId: 'C011', claimText: '报道把发生年份写成2025年。', checkReason: 'suspected_error',
        status: 'CONTRADICTED', risk: 'yellow', supportScope: 'none',
        evidenceSummary: '原始公告记载为2024年。', recommendedAction: '将年份纠正为2024年。' },
    ]);
    assessment.status = 'blocked';
    const summary = factCheckCompletionSummary(assessment);
    assert.match(summary, /报道把发生年份写成2025年/u);
    assert.match(summary, /将年份纠正为2024年/u);
    assert.doesNotMatch(summary, /可以导出|点击.*导出文章/u);
    assert.match(summary, /下一步.*修改|下一步.*补充/u);
  });

  it('does not count a URL or a model-declared method without runtime records as external verification', () => {
    const summary = factCheckCompletionSummary(passedAssessment([{ claimId: 'C001', claimText: '一个事件',
      status: 'SUPPORTED', risk: 'green', supportScope: 'full', checkReason: 'key_fact',
      sourceReference: 'https://www.csdn.net/', verificationMethod: 'external_source' }]));
    assert.match(summary, /未记录外部查证/u);
    assert.doesNotMatch(summary, /外部来源核对 1/u);
  });

  it('ends every passed report with an actionable path to export, without requiring illustrations', () => {
    for (const assessment of [null, passedAssessment([], '个人感受'), passedAssessment([{ claimText: '事实', status: 'SUPPORTED' }])]) {
      const summary = factCheckCompletionSummary(assessment);
      assert.match(summary, /下一步[\s\S]*查看当前稿件[\s\S]*导出文章/);
      assert.match(summary, /配图.*可选/);
      assert.match(summary, /不会自动发布/);
    }
  });
  it('summarizes selected key facts and leaves full evidence and source lists in details', () => {
    const summary = factCheckCompletionSummary(passedAssessment([
      {
        claimId: 'C001',
        claimText: '该标准于 2025 年发布。',
        location: '正文第 2 段',
        status: 'SUPPORTED',
        risk: 'green',
        supportScope: 'full',
        matchedEvidenceId: 'E001',
        sourceReference: 'https://standards.example/2025',
        evidenceSummary: '标准官网的发布日期为 2025 年 3 月。',
        recommendedAction: '保留。',
        checkReason: 'key_fact', verificationMethod: 'external_source', verificationRecordIds: ['read-standard'],
      },
    ]));

    assert.match(summary, /^这版文章已完成事实核查，可以导出。/u);
    assert.match(summary, /核查范围：文章正文、标题和发布配文/u);
    assert.match(summary, /共核对 1 条可核实信息/u);
    assert.match(summary, /该标准于 2025 年发布/u);
    assert.match(summary, /外部来源核对/u);
    assert.doesNotMatch(summary, /外部来源支持/u, 'fetch provenance is not a deterministic semantic guarantee');
    assert.match(summary, /外部来源核对 1/u);
    assert.doesNotMatch(summary, /- 依据：|- 来源：/u);
    assert.doesNotMatch(summary, /证据账本|E001|快照|门禁/u);
    assert.match(summary, /不代表事实绝对正确/u);
  });

  it('makes model-only verification limitations explicit without exposing an internal marker as a source', () => {
    const summary = factCheckCompletionSummary(passedAssessment([
      {
        claimId: 'C001',
        claimText: '水在标准大气压下于 100°C 沸腾。',
        location: '正文第 1 段',
        status: 'SUPPORTED',
        risk: 'green',
        supportScope: 'full',
        matchedEvidenceId: null,
        sourceReference: 'model-knowledge:unverified',
        evidenceSummary: '模型知识复核，未联网验证。',
        recommendedAction: '如用于严谨场景，请补充权威来源。',
      },
    ]));

    assert.match(summary, /仅模型复核，未联网验证/u);
    assert.match(summary, /模型知识不是外部证据/u);
    assert.doesNotMatch(summary, /model-knowledge:unverified/u);
  });

  it('shows the remaining problem count after the first eight items', () => {
    const summary = factCheckCompletionSummary({ ...passedAssessment(Array.from({ length: 11 }, (_, i) => ({
      claimText: `问题${i + 1}`, status: 'CONTRADICTED', risk: 'yellow', supportScope: 'none',
    }))), status: 'blocked' });
    assert.match(summary, /还有 3 条问题.*事实核查.*详情/u);
    assert.doesNotMatch(summary, /可以导出/u);
  });

  it('counts each method once, honoring the explicit method over legacy text', () => {
    const summary = factCheckCompletionSummary(passedAssessment([{ claimText: '作者已提供的事实', status: 'SUPPORTED',
      verificationMethod: 'material_comparison', sourceReference: 'material:author',
      evidenceSummary: '旧说明：模型知识复核，未联网验证。现已对照作者原话。' }]));
    assert.match(summary, /材料对照 1 条，模型复核 0 条/u);
  });

  it('reports the persisted reason when no externally verifiable claims were identified', () => {
    const summary = factCheckCompletionSummary(passedAssessment(
      [],
      '全文仅为作者个人感受，没有日期、数字、引语或其他外部事实主张。',
    ));

    assert.match(summary, /未发现需要进一步查证的易错或可疑事实/u);
    assert.match(summary, /全文仅为作者个人感受/u);
    assert.match(summary, /未列出的信息做外部验证/u);
  });

  it('handles an older passed record without displayable assessment data conservatively', () => {
    const summary = factCheckCompletionSummary(null);

    assert.match(summary, /这版文章此前已完成事实核查，可以导出/u);
    assert.match(summary, /旧记录没有保存可展示的逐条核查说明/u);
    assert.doesNotMatch(summary, /快照|门禁/u);
    assert.doesNotMatch(summary, /已核对 \d+ 条/u);
  });

  it('uses a readable source label without exposing a technical evidence id', () => {
    const summary = factCheckCompletionSummary(passedAssessment([
      {
        claimId: 'C001', claimText: '内部流程包含三步。', location: '正文第 1 段',
        status: 'SUPPORTED', risk: 'red', supportScope: 'full',
        matchedEvidenceId: 'E009', sourceReference: null,
        evidenceSummary: '用户提供的流程材料列出了三步。', recommendedAction: '保留。',
      },
      {
        claimId: 'C002', claimText: '报告样本量为 120 家。', location: '正文第 2 段',
        status: 'SUPPORTED', risk: 'red', supportScope: 'full',
        matchedEvidenceId: null, sourceReference: '《行业报告》第 6 页',
        evidenceSummary: '报告正文写明样本量。', recommendedAction: '保留。',
      },
    ]));

    assert.match(summary, /来源：已提供材料/u);
    assert.match(summary, /来源：《行业报告》第 6 页/u);
    assert.doesNotMatch(summary, /E009|证据账本/u);
  });
});
