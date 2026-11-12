import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Ajv } from 'ajv';
import { parseEvidenceLedger } from '../../writing-core/src/index.js';
import { EDITORIAL_PLAN_JSON_SCHEMA, parseEditorialPlan, type EditorialPlan } from '../src/editorial-plan.js';
import { expandResearchEvidence } from '../src/research-evidence.js';

const evidenceIds = new Set(['E002', 'E005']);

function plan(): EditorialPlan {
  return {
    angles: [
      { id: 'A1', readerProblem: '上周上线的自动化为何没人用？', readerGain: '区分完成部署与接入实际审批流程。', angle: '部署成功后，责任还卡在人工交接。', supportingEvidenceIds: ['E002'] },
      { id: 'A2', readerProblem: '上线后如何衡量变化？', readerGain: '知道何时需要对照人工耗时。', angle: '把节省时间的测量放回具体环节。', supportingEvidenceIds: ['E005'] },
    ],
    selectedAngleId: 'A1',
    selectionReason: '现有记录能指出交接环节，耗时没有同口径基线。',
    materialDecisions: [
      { evidenceId: 'E002', decision: 'use', reason: '提供现有审批路径。' },
      { evidenceId: 'E005', decision: 'omit', reason: '耗时记录缺少基线，当前切口不讨论效率。' },
    ],
    gaps: [],
  };
}

it('validates the bounded plan against the evidence IDs actually present after research expansion', () => {
  const ledger = expandResearchEvidence({
    sources: [{ source_id: 'S1', source_title: '审批记录', source_publisher: '作者材料', accessed_at: '本次运行' }],
    claims: [
      { source_id: 'S1', evidence_id: 'E005', claim_type: 'other', claim_text: '已记录一次耗时', source_quote: '用时 20 分钟', reliability: 'medium', use_boundary: '只有单次记录', verification_status: 'user_provided' },
      { source_id: 'S1', evidence_id: 'E002', claim_type: 'other', claim_text: '审批存在人工交接', source_quote: '由主管手动核对后转交', reliability: 'high', use_boundary: '限本次流程', verification_status: 'user_provided' },
    ],
    notes: '',
  });
  const parsedLedger = parseEvidenceLedger(JSON.stringify(ledger));
  assert.deepEqual(parsedLedger.evidenceIds, evidenceIds);
  assert.deepEqual(parseEditorialPlan(plan(), parsedLedger.evidenceIds), plan());
  const validateTransport = new Ajv().compile(EDITORIAL_PLAN_JSON_SCHEMA);
  assert.ok(validateTransport(plan()), JSON.stringify(validateTransport.errors));
  assert.equal(validateTransport({ ...plan(), extra: true }), false);
  assert.equal(validateTransport({ ...plan(), gaps: ['字'.repeat(241)] }), false);
});

it('requires a unique, genuinely selectable list of angle records', () => {
  assert.throws(() => parseEditorialPlan({ ...plan(), selectedAngleId: 'A3' }, evidenceIds), /selectedAngleId/);
  const sameId = plan();
  sameId.angles[1]!.id = 'A1';
  assert.throws(() => parseEditorialPlan(sameId, evidenceIds), /IDs must be unique/);
  const sameAngle = plan();
  sameAngle.angles[1]!.angle = '部署成功后，责任 还卡在人工交接！';
  assert.throws(() => parseEditorialPlan(sameAngle, evidenceIds), /duplicate angle text/);
});

it('only allows one angle with the caller’s author-fixed permission', () => {
  const input = plan();
  input.angles.pop();
  assert.throws(() => parseEditorialPlan(input, evidenceIds), /unless the author fixed the angle/);
  assert.deepEqual(parseEditorialPlan(input, evidenceIds, { allowSingleAngle: true }), input);
  assert.throws(() => parseEditorialPlan({ ...input, allowSingleAngle: true }, evidenceIds), /Unrecognized key/);
});

it('requires a single decision per ledger claim and valid references across candidates', () => {
  const missing = plan();
  missing.materialDecisions.pop();
  assert.throws(() => parseEditorialPlan(missing, evidenceIds), /missing decision for E005/);
  const duplicate = plan();
  duplicate.materialDecisions[1]!.evidenceId = 'E002';
  assert.throws(() => parseEditorialPlan(duplicate, evidenceIds), /duplicate evidence ID E002/);
  const unknown = plan();
  unknown.materialDecisions[1]!.evidenceId = 'E999';
  assert.throws(() => parseEditorialPlan(unknown, evidenceIds), /unknown or duplicate evidence ID E999/);
  const unregistered = plan();
  unregistered.angles[1]!.supportingEvidenceIds.push('E999');
  assert.throws(() => parseEditorialPlan(unregistered, evidenceIds), /unknown evidence ID E999 in A2/);
  const repeated = plan();
  repeated.angles[0]!.supportingEvidenceIds.push('E002');
  assert.throws(() => parseEditorialPlan(repeated, evidenceIds), /repeated evidence ID in A1/);
  assert.throws(() => parseEditorialPlan({ ...plan(), selectedAngleId: 'A2' }, evidenceIds), /selected angle references omitted evidence E005/);
});

it('accepts a personal essay without evidence when the plan explains its scope', () => {
  const input = plan();
  input.angles = input.angles.map(angle => ({ ...angle, supportingEvidenceIds: [] }));
  input.materialDecisions = [];
  assert.throws(() => parseEditorialPlan(input, new Set()), /selected angle cites no evidence/);
  input.gaps = ['只谈作者本人感受，不把观察推广到其他人的工作经历。'];
  assert.deepEqual(parseEditorialPlan(input, new Set()), input);
});
