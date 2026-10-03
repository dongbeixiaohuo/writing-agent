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
  it('ends every passed report with an actionable path to export, without requiring illustrations', () => {
    for (const assessment of [null, passedAssessment([], '个人感受'), passedAssessment([{ claimText: '事实', status: 'SUPPORTED' }])]) {
      const summary = factCheckCompletionSummary(assessment);
      assert.match(summary, /下一步[\s\S]*查看当前稿件[\s\S]*导出文章/);
      assert.match(summary, /配图.*可选/);
      assert.match(summary, /不会自动发布/);
    }
  });
  it('reports the checked facts with their persisted evidence and sources', () => {
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
      },
    ]));

    assert.match(summary, /^这版文章已完成事实核查，可以导出。/u);
    assert.match(summary, /核查范围：文章正文、标题和发布配文/u);
    assert.match(summary, /共核对 1 条可核实信息/u);
    assert.match(summary, /该标准于 2025 年发布/u);
    assert.match(summary, /标准官网的发布日期为 2025 年 3 月/u);
    assert.match(summary, /https:\/\/standards\.example\/2025/u);
    assert.match(summary, /\*\*1\. 该标准于 2025 年发布。.*\*\*\n\n- 结论：与来源一致\n- 依据：标准官网的发布日期为 2025 年 3 月。\n- 来源：https:\/\/standards\.example\/2025/u);
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

    assert.match(summary, /结论：仅模型复核，未联网验证/u);
    assert.match(summary, /模型知识不是外部证据/u);
    assert.doesNotMatch(summary, /model-knowledge:unverified/u);
  });

  it('reports the persisted reason when no externally verifiable claims were identified', () => {
    const summary = factCheckCompletionSummary(passedAssessment(
      [],
      '全文仅为作者个人感受，没有日期、数字、引语或其他外部事实主张。',
    ));

    assert.match(summary, /未识别出需要逐条查证的客观信息/u);
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
        status: 'SUPPORTED', risk: 'green', supportScope: 'full',
        matchedEvidenceId: 'E009', sourceReference: null,
        evidenceSummary: '用户提供的流程材料列出了三步。', recommendedAction: '保留。',
      },
      {
        claimId: 'C002', claimText: '报告样本量为 120 家。', location: '正文第 2 段',
        status: 'SUPPORTED', risk: 'green', supportScope: 'full',
        matchedEvidenceId: null, sourceReference: '《行业报告》第 6 页',
        evidenceSummary: '报告正文写明样本量。', recommendedAction: '保留。',
      },
    ]));

    assert.match(summary, /来源：已提供材料/u);
    assert.match(summary, /来源：《行业报告》第 6 页/u);
    assert.doesNotMatch(summary, /E009|证据账本/u);
  });
});
