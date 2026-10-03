import assert from 'node:assert/strict';
import test from 'node:test';
import { authorContext, compactReworkReport, deduplicateReviewDiscussion, factStatusContext, projectInlineRead } from '../src/agent-context.js';

const longBody = '正文中段。'.repeat(800) + '尾部事实限定：不是因果，也不适用于儿童。';
const status: any = { status: 'stale', currentSnapshotId: 's', snapshot: { bodyVersionId: 'old-body' }, invalidations: [{ reason: 'body_version_changed', changedVersionId: 'new-body' }],
  assessment: { id: 'check', status: 'blocked', blockers: ['C2'], reportContent: '重复报告'.repeat(1000), payload: {
    claims: [{ claimId: 'C1', status: 'SUPPORTED', supportScope: 'full', risk: 'green', evidenceSummary: '已支持'.repeat(1000) },
      { claimId: 'C2', status: 'UNSUPPORTED', claimText: '错误事实', evidenceSummary: '缺少来源', recommendedAction: '请补来源而非删掉观点' }], noFactualClaimsReason: '', coverage: { scope: 'test-limit' } } } };

test('intent keeps current review and all author decisions, but not manuscript or repeated fact reports', () => {
  const history = [{ sequence: 1, role: 'user', content: '保留我的反对意见，不要照旧报告全改。' },
    { sequence: 2, role: 'assistant', content: '旧解释'.repeat(900) },
    { sequence: 3, role: 'assistant', content: '这版只改第二处，可以继续吗？' }];
  const view: any = authorContext({ currentBody: { versionId: 'new-body', content: longBody, blocks: [] } as any,
    history, factCheck: status, currentExpertReview: { stage: 'review_reader', content: '第二处的具体建议' } }, 'intent');
  assert.equal(view.currentBody.content, undefined);
  assert.equal(view.history[0].content, history[0]!.content);
  assert.equal(view.history[1].sequence, 2);
  assert.equal(view.history[1].contentAvailableVia, 'read_conversation_history');
  assert.equal(view.history[2].content, history[2]!.content);
  assert.equal(view.currentExpertReview.content, '第二处的具体建议');
  assert.equal(view.factCheck.status, 'stale');
  assert.equal(view.factCheck.assessment.reportContent, undefined);
});

test('illustrator keeps full article tail, plan and author constraints without full assessment or draft block duplication', () => {
  const state: any = { currentBody: { versionId: 'v', content: longBody, blocks: [{ id: 'b', ordinal: 0, kind: 'paragraph', content: longBody }] },
    brief: { constraints: ['不用人物'] }, history: [], factCheck: status,
    selectedPublication: '已选标题', publicationCandidates: '旧候选'.repeat(1000), illustrationPlan: [{ id: 'plan', prompts: ['保持手绘'] }] };
  const view: any = authorContext(state, 'discussion', 'illustrator');
  assert.equal(view.currentBody.content, longBody);
  assert.equal(view.currentBody.blocks, undefined);
  assert.deepEqual(view.brief, state.brief);
  assert.deepEqual(view.illustrationPlan, state.illustrationPlan);
  assert.equal(view.publicationCandidates, undefined);
  assert.equal(view.factCheck.assessment.claims, undefined);
  const revision: any = authorContext(state, 'revision', 'central_revision');
  assert.equal(revision.currentBody.blocks[0].content, longBody);
  assert.equal(revision.currentBody.blocks[0].id, 'b');
  assert.equal(revision.currentBody.content, undefined);
});

test('director and rework views keep every unresolved finding and stale binding without rendered report duplication', () => {
  const view: any = factStatusContext(status, true);
  assert.equal(view.status, 'stale');
  assert.equal(view.assessment.claimCount, 2);
  assert.deepEqual(view.assessment.claims, [status.assessment.payload.claims[1]]);
  assert.deepEqual(view.invalidations, status.invalidations);
  assert.equal(view.assessment.reportContent, undefined);
  assert.deepEqual(view.assessment.coverage, status.assessment.payload.coverage);
  const report: any = compactReworkReport(JSON.stringify({ markerIds: ['m'], revisionInput: { bodyVersionId: 'new-body', factCheck: status } }));
  assert.equal(report.revisionInput.bodyVersionId, 'new-body');
  assert.deepEqual(report.revisionInput.factCheck.assessment.claims, view.assessment.claims);
  assert.equal(compactReworkReport('legacy report'), 'legacy report');
});

test('dedup removes only exact assistant report echoes and keeps all author quotes, dissent and changed reports', () => {
  const report = '建议删去第二段。';
  const view: any = deduplicateReviewDiscussion([
    { sequence: 1, role: 'assistant', content: report }, { sequence: 2, role: 'user', content: report },
    { sequence: 3, role: 'user', content: '我不同意上述建议' }, { sequence: 4, role: 'assistant', content: report + '不删结尾' },
  ], [{ id: 'review', content: report }]);
  assert.deepEqual(view[0], { sequence: 1, role: 'assistant', contentFromArtifactId: 'review' });
  assert.equal(view[1].content, report);
  assert.equal(view[2].content, '我不同意上述建议');
  assert.equal(view[3].content, report + '不删结尾');
});

test('supported-but-partial or red findings still reach the director and rework owner', () => {
  const claims = [{ claimId: 'partial', status: 'SUPPORTED', supportScope: 'partial', risk: 'yellow', recommendedAction: '保留适用人群限定' },
    { claimId: 'red', status: 'SUPPORTED', supportScope: 'full', risk: 'red', recommendedAction: '处理高风险冲突' }];
  const input = { ...status, assessment: { ...status.assessment, blockers: ['partial', 'red'], payload: { ...status.assessment.payload, claims } } };
  assert.deepEqual(factStatusContext(input, true).assessment?.claims, claims);
});

test('inline read dedup preserves failures, old versions, report details and source reads absent from the new request', () => {
  const tool = (result: unknown, ok = true, name = 'read_artifact_version'): any => ({ role: 'tool', name, toolCallId: 'call', content: JSON.stringify({ ok, result }) });
  const artifacts = [{ id: 'body', kind: 'body', content: longBody }];
  const message = tool({ versionId: 'body', content: longBody });
  assert.equal(JSON.parse(projectInlineRead(message, artifacts, [])).result.content, undefined);
  assert.match(JSON.parse(projectInlineRead(message, artifacts, [])).result.contentFrom, /body/);
  assert.match(message.content, /尾部事实限定/);
  for (const message of [tool({ versionId: 'old', content: longBody }), tool({ versionId: 'body', content: longBody }, false),
    tool({ materialId: 'source', content: longBody }, true, 'read_material')]) {
    assert.equal(projectInlineRead(message, artifacts, []), message.content);
  }
  assert.equal(projectInlineRead(message, [{ ...artifacts[0]!, kind: 'report' }], []), message.content);
});
