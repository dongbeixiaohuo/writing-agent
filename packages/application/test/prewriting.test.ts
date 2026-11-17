import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parsePrewriting, prewritingContent, PREWRITING_JSON_SCHEMA, draftWritingPlan, outlineWithoutTrialProse, validateReadingRoute, READING_SELECTION_JSON_SCHEMA, READING_DRAFT_INSTRUCTIONS, type PrewritingAssessment } from '../src/prewriting.js';
import { createWritingWorkflowTools, stageArtifact, stageMarker, isReadingFirstRun, workflowStagesForRun } from '../src/workflow-tools.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { editorialPlanFixture } from './collaboration-fixture.js';
import { stageArtifactContext } from '../src/agent-context.js';

const ledger = { claims: [{ evidence_id: 'E001', claim_type: 'other', claim_text: '报道提出家庭住所安排。',
  source_title: '公开报道', source_publisher: '报刊', source_quote: '希望安排家人居住在附近。', accessed_at: '本次运行',
  reliability: 'medium', use_boundary: '只说明住所设想，不证明事业布局。', verification_status: 'user_provided' }],
  notes: '研究备注：动机未明。', editorialPlan: editorialPlanFixture(['E001']) };
const outline = '# 家庭安排\n\n## 居住安排\n讨论报道中的住所设想。';

it('selects source bookmarks without requiring an essay, chapter obligations or a conclusion', () => {
  const selection = { decision: 'ready', promise: '看具体安排。', readerPayoff: '理解人的选择。', reason: '有可展开的行动。', queries: [], questions: [],
    readingRoute: { question: '同样安排住所，为何选择不同？', moments: [{ sourceUrl: 'https://example.org/source', quote: '希望安排家人居住在附近。', interest: '看各人如何回应。' }] } };
  assert.ok(new Ajv().compile(READING_SELECTION_JSON_SCHEMA)(selection));
  const plan = parsePrewriting(selection, JSON.stringify(ledger), '选材完成。', true);
  validateReadingRoute(plan, [{ url: 'https://example.org/source', text: ledger.claims[0]!.source_quote }]);
  validateReadingRoute(plan, [{ url: 'https://example.org/source', text: '希望安排家人\n 居住在附近。' }]);
  assert.deepEqual(draftWritingPlan(plan), { promise: selection.promise, readingRoute: { question: selection.readingRoute.question,
    moments: [{ sourceUrl: 'https://example.org/source', quote: '希望安排家人居住在附近。' }] } });
  assert.doesNotMatch(JSON.stringify(draftWritingPlan(plan)), /看各人如何回应/u, 'editorial interest notes stay out of the writer input');
  assert.throws(() => validateReadingRoute(plan, [{ url: 'https://example.org/source', text: '另一段原文' }]), /exact passage/);
  const personal = { ...plan, readingRoute: { ...plan.readingRoute!, moments: [] } };
  validateReadingRoute(personal, []); // A personal essay may have author words but no external source.
  assert.throws(() => validateReadingRoute(personal, [{ url: 'https://example.org/source', text: '原文' }]), /actual moment/);
});

it('assigns source assessment to research and fact checking instead of the article', () => {
  assert.match(READING_DRAFT_INSTRUCTIONS, /正文不写来源可靠性、核实难度、材料缺口、推断边界/u);
  assert.match(READING_DRAFT_INSTRUCTIONS, /即使书签或风格资料提到也不转述/u);
  assert.doesNotMatch(READING_DRAFT_INSTRUCTIONS, /材料限制并入相关叙述/u);
});

it('runs one cold read into scoped revision and preserves the route across continuation', () => {
  const path = mkdtempSync(join(tmpdir(), 'reading-route-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  try {
    storage.createProject({ projectId: 'p', operationId: 'create', name: '阅读主线', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'test' });
    const url = 'https://example.org/source', quote = ledger.claims[0]!.source_quote;
    assert.ok(storage.importMaterial({ projectId: 'p', operationId: 'source', expectedProjectRevision: 0, materialId: 'm', displayName: '原文', sourceKind: 'web_snapshot', sourceReference: url, role: 'source_verified', trustLabel: 'external_untrusted', permissionScope: 'project_only', content: quote, actor: { kind: 'user', id: 'test' } }).ok);
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', purpose: 'test', planVersion: 'test', operationId: 'start' });
    const workflow = createWritingWorkflowTools({ storage, projectId: 'p', mode: 'quick', requireEditorialPlan: true });
    let counter = 0;
    const submit = (stage: string, content: string, extra = {}) => {
      const context: any = { projectId: 'p', sessionId: 's', runId: 'r', operationId: `op-${++counter}`, expectedBodyVersionId: storage.inspectProject('p')!.latestBodyVersionId };
      workflow.approveReadiness(context, '读取输入。');
      return (workflow.definitions.find(t => t.name === 'submit_writing_stage') as any).execute({ stage, content, ...extra }, context);
    };
    submit('research', JSON.stringify({ ...ledger, claims: [{ ...ledger.claims[0], source_url: url }] }));
    submit('outline', '选材完成。', { prewriting: { decision: 'ready', promise: '写住所安排。', readerPayoff: '理解选择。', reason: '有具体内容。', queries: [], questions: [], readingRoute: { question: '家人如何回应？', moments: [{ sourceUrl: url, quote, interest: '安排与回应之间的差别。' }] } } });
    assert.ok(isReadingFirstRun(storage, 'p', 'r'));
    assert.ok(!workflowStagesForRun(storage, 'p', 'r', 'quick').includes('review_publish'));
    assert.throws(() => submit('draft', '# 原标题\n\n这是一则后人记述，细节未必都能核实，尤其不能据此猜测当事人的想法。'),
      (error: any) => error.code === 'BODY_STAGE_CONTAINS_EDITORIAL_CAVEATS');
    const body = '# 原标题\n\n值得保留的动作。\n\n重复的一句。';
    submit('draft', body);
    submit('review_editor', '保住动作，删掉重复。', { findings: [{ quote: '重复的一句。', kind: 'reader_value', severity: 'required', issue: '没有推进。', repairTarget: '删掉重复，让动作更突出。', evidenceIds: [] }], reading: { verdict: 'revise', takeaway: '看到了具体动作。', quote: '重复的一句。', reason: '结尾重复。', repairTarget: '删掉重复。', queries: [], questions: [] } });
    assert.equal(workflow.progress('r').nextStage, 'central_revision');
    const base = stageArtifact(storage, 'p', 'r', 'draft')!;
    submit('central_revision', body, { paragraphEdits: { baseBodyVersionId: base.id, edits: [{ paragraphId: 'p3', replacement: '' }] } });
    assert.equal(stageArtifact(storage, 'p', 'r', 'central_revision')!.content, '# 原标题\n\n值得保留的动作。\n\n');
    assert.equal(workflow.progress('r').nextStage, 'language_review');
    storage.finishRun({ projectId: 'p', runId: 'r', operationId: 'interrupt', status: 'cancelled', stopReason: 'test', payload: {} });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r2', purpose: 'test', planVersion: 'test', operationId: 'continue' });
    assert.equal(workflow.progress('r2').nextStage, 'language_review');
    assert.ok(isReadingFirstRun(storage, 'p', 'r2'));
  } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
});

it('renders trial plans from the selected development and sections without a second model transcription', () => {
  const plan = ready();
  plan.readerValue!.approaches = ['另一种发现，不应交给主笔。', '选中的发现。'];
  const parsed = parsePrewriting(plan, JSON.stringify(ledger), '试稿完成。', true);
  assert.equal(prewritingContent(parsed, '试稿完成。'), `${plan.readerValue!.development}\n\n## 居住安排\n\n介绍具体安排。`);
  assert.equal(prewritingContent(ready(), outline), outline, 'legacy plans keep their exact public text');
  assert.throws(() => parsePrewriting({ ...plan, sections: [] }, JSON.stringify(ledger), '完成。', true));
  assert.throws(() => parsePrewriting({ ...plan, premises: [{ ...plan.premises[0], basis: 'missing' }] }, JSON.stringify(ledger), '完成。', true));
});
const ready = (): PrewritingAssessment => ({ decision: 'ready', promise: '说明报道中的住所设想。', readerPayoff: '理解居住安排。',
  readerValue: { status: 'substantive', question: '怎样安排家人居住？', discovery: '相邻住所兼顾相聚与各自生活。',
    development: '住在附近并不等于住在同一个屋檐下。相邻住所让家庭成员更容易见面，也保留各自生活的空间。', evidenceIds: ['E001'] },
  premises: [{ claim: '报道提出相邻住所设想。', basis: 'source', evidenceIds: ['E001'], explanation: '引文直接说安排家人住在附近。' }],
  sections: [{ heading: '居住安排', readerGain: '介绍具体安排。', evidenceIds: ['E001'] }], reason: '承诺限于材料所述。', queries: [], questions: [] });
const blocked = (): PrewritingAssessment => ({ ...ready(), decision: 'research',
  promise: '私生活如何被用于商业布局。', premises: [{ claim: '家庭安排承担商业功能。', basis: 'missing', evidenceIds: ['E001'], explanation: '住所安排不证明商业功能。' }],
  sections: [], reason: '原题的商业功能缺少支持。', queries: ['家庭安排 商业功能 原始材料'], questions: ['补查后仍无依据的话，是否改为讨论家庭安排本身？'] });

it('removes prewritten answers and trial prose without changing the saved plan or legacy outline', () => {
  const plan = ready();
  plan.readerValue!.development += '\n第二段预写正文。';
  plan.readerValue!.approaches = ['未选择的另一段预写正文。', '另一个试写方向。'];
  const before = JSON.stringify(plan);
  const rendered = prewritingContent(plan, '');
  const projected = draftWritingPlan(plan);
  assert.deepEqual(projected.readerValue, { question: plan.readerValue!.question,
    evidenceIds: plan.readerValue!.evidenceIds });
  assert.equal(projected.promise, plan.promise);
  assert.equal('readerPayoff' in projected, false, 'the payoff must not leak a duplicate conclusion');
  assert.equal('sections' in projected, false, 'section instructions are not sent to the writer');
  assert.equal(outlineWithoutTrialProse(rendered, plan), '## 居住安排\n\n介绍具体安排。');
  assert.equal(outlineWithoutTrialProse(rendered.replaceAll('\n', '\r\n'), plan), '## 居住安排\r\n\r\n介绍具体安排。');
  assert.equal(outlineWithoutTrialProse(outline, plan), outline);
  assert.equal(JSON.stringify(plan), before, 'projection never edits the stored preview');
  plan.sections[0]!.readerGain = plan.readerValue!.approaches[0]!;
  assert.equal(outlineWithoutTrialProse(prewritingContent(plan, ''), plan),
    `## 居住安排\n\n${plan.sections[0]!.readerGain}`, 'do not remove a phrase repeated in an unchanged section');
});

it('blocks missing premises even when the model also says ready; allows reasoned commentary', () => {
  const { readerValue: _readerValue, ...legacy } = ready();
  assert.ok(new Ajv().validate(PREWRITING_JSON_SCHEMA, legacy), 'pending RC100 responses remain schema-compatible');
  assert.equal(parsePrewriting(legacy, JSON.stringify(ledger), outline).decision, 'ready');
  assert.throws(() => parsePrewriting({ ...ready(), readerValue: undefined }, JSON.stringify(ledger), outline, true), /reading value/);
  assert.throws(() => parsePrewriting({ ...ready(), readerValue: { ...ready().readerValue!, status: 'thin' } }, JSON.stringify(ledger), outline, true), /thin reading payoff/);
  assert.throws(() => parsePrewriting({ ...ready(), readerValue: { ...ready().readerValue!, evidenceIds: ['E999'] } }, JSON.stringify(ledger), outline, true), /references/);
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
    assert.equal(current.readerValueRequired('r'), false);
    const outlineContext = { ...context, operationId: 'continued-outline' };
    current.approveReadiness(outlineContext, '沿用已有研究。');
    const continueSubmit: any = current.definitions.find(t => t.name === 'submit_writing_stage');
    continueSubmit.execute({ stage: 'outline', content: outline }, outlineContext);
    assert.equal(current.progress('r').nextStage, 'draft');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
