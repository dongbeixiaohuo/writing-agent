import assert from 'node:assert/strict';
import test from 'node:test';
import { authorContext, compactReworkReport, deduplicateReviewDiscussion, factStatusContext, projectInlineRead, stageArtifactContext } from '../src/agent-context.js';

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

const source = { source_title: '用户粘贴的报道', source_url: 'https://example.com', source_publisher: '报道来源', accessed_at: '2026-10-05' };
const ledger = { notes: '未独立验证；不要将相关性改为因果。', claims: Array.from({ length: 41 }, (_, i) => ({ ...source,
  evidence_id: `E${i + 1}`, claim_type: 'number', claim_text: `主张${i}只针对原研究人群`, source_quote: `连续引文${i}，包括前后条件。`.repeat(8),
  reliability: 'low', use_boundary: '不可推广儿童；不能推断因果；引语不能删限定。', verification_status: '未核实',
})) };
const evidence = { id: 'evidence-v1', kind: 'evidence', content: JSON.stringify(ledger) };
const fullBody = { id: 'body-v1', kind: 'body', content: '# 当前文章\n\n' + longBody };

test('stage projections preserve all writing/fact evidence values while avoiding repeated field names', () => {
  for (const actor of ['outline', 'draft', 'central_revision']) {
    const view = stageArtifactContext(actor, [evidence, fullBody]);
    const table: any = view.artifacts[0]!.content;
    assert.equal(table.projection, 'evidence_table');
    const expanded = table.claimRows.map((row: any[]) => {
      const { source_id, ...claim } = Object.fromEntries(table.claimFields.map((key: string, i: number) => [key, row[i]]));
      const { source_id: _id, ...provenance } = table.sources.find((s: any) => s.source_id === source_id);
      return { ...provenance, ...claim };
    });
    assert.deepEqual(expanded, ledger.claims, actor);
    assert.equal(table.notes, ledger.notes);
    assert.equal(view.artifacts[1]!.content, fullBody.content);
    assert.equal(view.completeArtifacts.length, 2);
    assert.ok(JSON.stringify(table).length < evidence.content.length * 0.8);
  }
});

test('fact checker receives the whole article and evidence index, not unrelated source quotes', () => {
  const view = stageArtifactContext('fact_check', [evidence, fullBody]);
  const catalog: any = view.artifacts[0]!.content;
  assert.equal(catalog.projection, 'fact_evidence_catalog');
  assert.equal(catalog.claimRows.length, 41);
  assert.deepEqual(catalog.claimRows.map((c: any) => c[catalog.claimFields.indexOf('use_boundary')]), ledger.claims.map(c => c.use_boundary));
  assert.equal(catalog.claimFields.includes('source_quote'), false);
  assert.equal(view.artifacts[1]!.content, fullBody.content);
  assert.deepEqual(view.completeArtifacts, [fullBody]);
});

test('review and language scopes keep EVERY claim and boundary but expose exact quotes on demand', () => {
  for (const actor of ['review_editor', 'review_publish', 'review_reader', 'language_review', 'title']) {
    const view = stageArtifactContext(actor, [evidence, fullBody]);
    const table: any = view.artifacts[0]!.content;
    assert.equal(table.claimRows.length, 41);
    assert.ok(!table.claimFields.includes('source_quote'));
    for (const key of ['claim_text', 'use_boundary', 'verification_status', 'reliability', 'evidence_id']) {
      assert.deepEqual(table.claimRows.map((r: any[]) => r[table.claimFields.indexOf(key)]), ledger.claims.map(c => (c as any)[key]));
    }
    assert.deepEqual(table.omittedFields, ['source_quote']);
    assert.equal(table.contentAvailableVia, 'read_artifact_version');
    assert.deepEqual(view.completeArtifacts, [fullBody]);
    const read: any = { role: 'tool', name: 'read_artifact_version', content: JSON.stringify({ ok: true, result: { versionId: evidence.id, content: evidence.content } }) };
    assert.equal(projectInlineRead(read, view.completeArtifacts, []), read.content, 'requested full quote must not be replaced by a pointer to omitted content');
    const delivered = JSON.parse(projectInlineRead(read, view.completeArtifacts, [], [evidence, fullBody])).result;
    assert.equal(delivered.contentFrom, undefined);
    assert.equal(delivered.requestProjection, 'lossless_evidence_table');
    assert.deepEqual(delivered.content.claimRows.map((r: any[]) => r[delivered.content.claimFields.indexOf('source_quote')]), ledger.claims.map(c => c.source_quote));
  }
});

test('director catalog retains IDs, notes and rework findings without crediting omitted article as delivered', () => {
  const view = stageArtifactContext('director', [evidence, fullBody]);
  assert.equal(view.completeArtifacts.length, 0);
  assert.equal(view.needsArtifactAccess, true);
  const catalog: any = view.artifacts[0]!.content;
  assert.equal(catalog.claimCount, 41);
  assert.equal(catalog.notes, ledger.notes);
  assert.deepEqual(catalog.evidenceIds, ledger.claims.map(c => c.evidence_id));
  assert.ok(JSON.stringify(view.artifacts).length < JSON.stringify([evidence, fullBody]).length * 0.15);
  const legacy: any = stageArtifactContext('fact_check', [{ ...evidence, content: 'legacy unknown ledger' }]).artifacts[0]!.content;
  assert.equal(legacy.legacyLedger, true);
  assert.equal(legacy.contentAvailableVia, 'read_fact_evidence');
});

test('discussion references only exact fully supplied material versions and preserves all author decisions and recent assistant context', () => {
  const article = '第三方参考文章。'.repeat(1000);
  const materials = [{ materialId: 'intake-user-source', contentVersionId: 'v1', content: article,
    offset: 0, nextOffset: article.length, totalChars: article.length, truncated: false }];
  const discussion = [
    { sequence: 1, role: 'user', content: article },
    { sequence: 2, role: 'assistant', content: '旧建议。'.repeat(1000) },
    { sequence: 3, role: 'user', content: '不同意第二项，不要删原文结尾。' },
    { sequence: 4, role: 'assistant', content: '已保留结尾' },
    { sequence: 5, role: 'assistant', content: '这版可以吗？' },
    { sequence: 6, role: 'user', content: '只改标点，其他认可' },
  ];
  const view: any = deduplicateReviewDiscussion(discussion, [], materials, true);
  assert.deepEqual(view[0], { sequence: 1, role: 'user', contentFromMaterial: { materialId: 'intake-user-source', contentVersionId: 'v1' } });
  assert.equal(view[1].contentAvailableVia, 'read_review_discussion');
  assert.deepEqual(view.slice(2), discussion.slice(2));
  assert.equal((deduplicateReviewDiscussion(discussion, [], [{ ...materials[0]!, truncated: true }], true) as any)[0].content, article);
  assert.equal((deduplicateReviewDiscussion(discussion, [], [{ ...materials[0]!, content: article + '变更' }], true) as any)[0].content, article);
});
