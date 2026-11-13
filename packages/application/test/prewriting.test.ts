import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePrewriting, type PrewritingAssessment } from '../src/prewriting.js';
import { createWritingWorkflowTools, stageMarker } from '../src/workflow-tools.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { editorialPlanFixture } from './collaboration-fixture.js';
import { stageArtifactContext } from '../src/agent-context.js';

const ledger = { claims: [{ evidence_id: 'E001', claim_type: 'other', claim_text: '报道提出家庭住所安排。',
  source_title: '公开报道', source_publisher: '报刊', source_quote: '希望安排家人居住在附近。', accessed_at: '本次运行',
  reliability: 'medium', use_boundary: '只说明住所设想，不证明事业布局。', verification_status: 'user_provided' }],
  notes: '研究备注：动机未明。', editorialPlan: editorialPlanFixture(['E001']) };
const outline = '# 家庭安排\n\n## 居住安排\n讨论报道中的住所设想。';
const ready = (): PrewritingAssessment => ({ decision: 'ready', promise: '说明报道中的住所设想。', readerPayoff: '理解居住安排。',
  premises: [{ claim: '报道提出相邻住所设想。', basis: 'source', evidenceIds: ['E001'], explanation: '引文直接说安排家人住在附近。' }],
  sections: [{ heading: '居住安排', readerGain: '介绍具体安排。', evidenceIds: ['E001'] }], reason: '承诺限于材料所述。', queries: [], questions: [] });
const blocked = (): PrewritingAssessment => ({ ...ready(), decision: 'research',
  promise: '私生活如何被用于商业布局。', premises: [{ claim: '家庭安排承担商业功能。', basis: 'missing', evidenceIds: ['E001'], explanation: '住所安排不证明商业功能。' }],
  sections: [], reason: '原题的商业功能缺少支持。', queries: ['家庭安排 商业功能 原始材料'], questions: ['补查后仍无依据的话，是否改为讨论家庭安排本身？'] });

it('blocks missing premises even when the model also says ready; allows reasoned commentary', () => {
  assert.throws(() => parsePrewriting({ ...blocked(), decision: 'ready' }, JSON.stringify(ledger), outline), /unresolved/);
  assert.throws(() => parsePrewriting({ ...ready(), premises: [{ ...ready().premises[0]!, evidenceIds: ['E999'] }] }, JSON.stringify(ledger), outline), /references/);
  assert.throws(() => parsePrewriting({ ...ready(), sections: [{ ...ready().sections[0]!, heading: '不存在的章节' }] }, JSON.stringify(ledger), outline), /actual submitted outline/);
  const imagined = { ...ledger, claims: [{ ...ledger.claims[0]!, verification_status: 'illustrative' }] };
  assert.throws(() => parsePrewriting(ready(), JSON.stringify(imagined), outline), /actual source quotes/);
  const personal = { ...ready(), premises: [{ claim: '我的价值选择。', basis: 'author' as const, evidenceIds: [], explanation: '作者真实表达的选择，不是外部事实。' }] };
  assert.equal(parsePrewriting(personal, JSON.stringify(ledger), outline).decision, 'ready');
  assert.deepEqual(parsePrewriting({ ...ready(), stage_note: '只用于内部的备注。' }, JSON.stringify(ledger), outline), ready());
});

it('holds the real workflow before an outline, persists across restart, and invalidates approval when research changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prewriting-'));
  let storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    storage.createProject({ projectId: 'p', operationId: 'project', name: '人物比较', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'test' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', purpose: 'test', planVersion: 'test', operationId: 'start' });
    const makeWorkflow = () => createWritingWorkflowTools({ storage, projectId: 'p', mode: 'quick', requireEditorialPlan: true });
    let workflow = makeWorkflow();
    let counter = 0;
    const submit = (stage: string, content: unknown, prewriting?: unknown) => {
      const context: any = { projectId: 'p', sessionId: 's', runId: 'r', operationId: `op-${++counter}`, expectedBodyVersionId: null };
      workflow.approveReadiness(context, '已读取当前输入。');
      const tool: any = workflow.definitions.find(t => t.name === 'submit_writing_stage');
      return tool.execute({ stage, content, ...(prewriting ? { prewriting } : {}) }, context);
    };
    submit('research', JSON.stringify(ledger));
    assert.equal(workflow.prewritingRequired('r'), true);
    const stopped = submit('outline', '需要补查。', blocked());
    assert.equal(stopped.handoff.kind, 'prewriting_required');
    assert.equal(stageMarker(storage, 'p', 'r', 'outline'), null);
    assert.equal(storage.listArtifactVersions('p', 'outline', 'main').length, 0);
    assert.equal(storage.listArtifactVersions('p', 'body', 'main').length, 0);
    storage.close(); storage = openWorkspaceStorage({ workspacePath: directory }); workflow = makeWorkflow();
    assert.ok(workflow.pendingPrewritingReturn('r'));
    assert.equal(workflow.progress('r').nextStage, 'outline');
    assert.throws(() => submit('draft', '# 不该写出的文章\n正文'), /Expected outline/);
    storage.pauseRun({ projectId: 'p', runId: 'r', operationId: 'pause-gap', reason: 'WRITING_INPUT_REQUIRED', payload: {} });
    storage.resumeRun({ projectId: 'p', runId: 'r', operationId: 'author-reply', decision: 'resume', displayInstruction: '认可继续' });
    assert.equal(workflow.pendingPrewritingReturn('r'), null, 'a reply permits assessment, not approval');
    assert.equal(workflow.prewritingApproval('r'), null);
    submit('outline', '仍需要补查。', blocked());
    assert.ok(workflow.pendingPrewritingReturn('r'), 'an identical negative reassessment must remain pending after the reply');
    workflow.invalidate({ projectId: 'p', runId: 'r', operationId: 'retry-research' } as any, 'research');
    assert.equal(workflow.progress('r').nextStage, 'research');
    assert.equal(workflow.continuationContext('r').artifacts.length, 1, 'research receives the actual missing-premise report');
    submit('research', JSON.stringify({ ...ledger, notes: '补查后与作者约定只谈住所设想。' }));
    assert.equal(workflow.pendingPrewritingReturn('r'), null);
    submit('outline', outline, ready());
    assert.equal(workflow.prewritingApproval('r')?.decision, 'ready');
    workflow.invalidate({ projectId: 'p', runId: 'r', operationId: 'changed-research' } as any, 'research');
    submit('research', JSON.stringify({ ...ledger, notes: '新的输入版本。' }));
    assert.equal(workflow.prewritingApproval('r'), null);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('gives the writer approved evidence without planning disclaimers, retaining source limits', () => {
  const projected: any = stageArtifactContext('draft', [{ id: 'e', kind: 'evidence', content: JSON.stringify(ledger) }], { writingEvidenceIds: ['E001'] }).artifacts[0]!.content;
  assert.equal(projected.editorialPlan, undefined);
  assert.equal(projected.notes, undefined);
  assert.ok(projected.claimRows[0].includes('只说明住所设想，不证明事业布局。'));
});

it('does not retroactively impose prewriting on an already saved legacy research stage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-prewriting-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    storage.createProject({ projectId: 'p', operationId: 'project', name: '旧任务', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'test' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', purpose: 'test', planVersion: 'test', operationId: 'start' });
    const context: any = { projectId: 'p', sessionId: 's', runId: 'r', operationId: 'old-research', expectedBodyVersionId: null };
    const old = createWritingWorkflowTools({ storage, projectId: 'p', mode: 'quick' });
    old.approveReadiness(context, '已读取旧任务输入。');
    const submit: any = old.definitions.find(t => t.name === 'submit_writing_stage');
    submit.execute({ stage: 'research', content: JSON.stringify(ledger) }, context);
    const current = createWritingWorkflowTools({ storage, projectId: 'p', mode: 'quick', requireEditorialPlan: true });
    assert.equal(current.prewritingRequired('r'), false);
    const outlineContext = { ...context, operationId: 'continued-outline' };
    current.approveReadiness(outlineContext, '沿用已有研究。');
    const continueSubmit: any = current.definitions.find(t => t.name === 'submit_writing_stage');
    continueSubmit.execute({ stage: 'outline', content: outline }, outlineContext);
    assert.equal(current.progress('r').nextStage, 'draft');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
