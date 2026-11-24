import { z } from 'zod';

const angleId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,23}$/u);
const evidenceId = z.string().regex(/^E[0-9]{3,}$/u);
const shortText = (limit: number) => z.string().trim().min(1).max(limit);

const EditorialPlanSchema = z.strictObject({
  angles: z.array(z.strictObject({
    id: angleId,
    readerProblem: shortText(180),
    readerGain: shortText(180),
    angle: shortText(240),
    supportingEvidenceIds: z.array(evidenceId).max(12),
  })).min(1).max(3),
  selectedAngleId: angleId,
  selectionReason: shortText(300),
  materialDecisions: z.array(z.strictObject({
    evidenceId,
    decision: z.enum(['use', 'omit']),
    reason: shortText(160),
  })).max(120),
  gaps: z.array(shortText(240)).max(3),
});

export type EditorialPlan = z.infer<typeof EditorialPlanSchema>;

const { $schema: _schemaVersion, ...EDITORIAL_PLAN_JSON_SCHEMA } = z.toJSONSchema(EditorialPlanSchema, { target: 'draft-07' });
export { EDITORIAL_PLAN_JSON_SCHEMA };

export const EDITORIAL_PLAN_INSTRUCTIONS = [
  '随研究台账提交editorialPlan。作者未选方向时，在原问题内比较2–3条材料线索。方向已确认时只提这一个方向，选能把它写实、写具体的材料。readerProblem写读者会想追问什么，readerGain写细节、人物理解、感受或认识上的收获，angle写可展开的内容，不预先替全文定论。',
  'selectedAngleId选择最有内容可写的一条，selectionReason指向具体片段为何有意思。选材表和候选方向要引用的编号，先在claims中明确填写evidence_id（例如E042）；materialDecisions用evidenceId填同一个值，再填decision（use/omit）和reason。保留能让人物与事情具体起来、推进阅读的内容，舍弃泛泛背景与凑权威的数字。supportingEvidenceIds引用存在且use的材料。保留引文、出处与必要上下文，供主笔回到原文。',
  'gaps只记录让文章无法往下写的内容缺口，围绕它补查。未找到时按已确认的方向和能用的材料推进；方向未定才与作者讨论。个人随笔可使用作者亲历和感受；材料不足不能靠编造补齐。研究判断与选材说明只用于内部，不进入正文。',
].join('\n');

/** Validate references against the actual IDs in the already-expanded research ledger. */
export function parseEditorialPlan(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
  options: { readonly allowSingleAngle?: boolean } = {},
): EditorialPlan {
  const parsed = EditorialPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = ['editorialPlan', ...issue.path.map(String)].join('.');
    throw new Error(`${path}: ${issue.message}`);
  }
  const plan = parsed.data;
  if (plan.angles.length === 1 && !options.allowSingleAngle) {
    throw new Error('editorialPlan.angles: give two or three distinct angles unless the author fixed the angle');
  }
  if (new Set(plan.angles.map(angle => angle.id)).size !== plan.angles.length) {
    throw new Error('editorialPlan.angles: angle IDs must be unique');
  }
  const normalizedAngles = plan.angles.map(({ angle }) => angle.normalize('NFKC').toLowerCase().replace(/\s+/gu, '').replace(/[.!?。！？]+$/u, ''));
  if (new Set(normalizedAngles).size !== plan.angles.length) {
    throw new Error('editorialPlan.angles: duplicate angle text');
  }
  const selected = plan.angles.find(angle => angle.id === plan.selectedAngleId);
  if (!selected) {
    throw new Error('editorialPlan.selectedAngleId: choose one of the submitted angles');
  }

  const decisions = new Map<string, 'use' | 'omit'>();
  for (const { evidenceId, decision } of plan.materialDecisions) {
    if (!evidenceIds.has(evidenceId) || decisions.has(evidenceId)) {
      throw new Error(`editorialPlan.materialDecisions: unknown or duplicate evidence ID ${evidenceId}`);
    }
    decisions.set(evidenceId, decision);
  }
  for (const evidenceId of evidenceIds) {
    if (!decisions.has(evidenceId)) {
      throw new Error(`editorialPlan.materialDecisions: missing decision for ${evidenceId}`);
    }
  }

  for (const angle of plan.angles) {
    const references = new Set(angle.supportingEvidenceIds);
    if (references.size !== angle.supportingEvidenceIds.length) {
      throw new Error(`editorialPlan.angles: repeated evidence ID in ${angle.id}`);
    }
    for (const evidenceId of references) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`editorialPlan.angles: unknown evidence ID ${evidenceId} in ${angle.id}`);
      }
      if (angle === selected && decisions.get(evidenceId) !== 'use') {
        throw new Error(`editorialPlan.selectedAngleId: selected angle references omitted evidence ${evidenceId}`);
      }
    }
  }
  if (!selected.supportingEvidenceIds.length && !plan.gaps.length) {
    throw new Error('editorialPlan.gaps: explain the writing scope when the selected angle cites no evidence');
  }
  return plan;
}

/** Repair references and field spelling. Never turn an omitted source into a used source. */
export function repairEditorialPlan(value: unknown, evidenceIds: ReadonlySet<string>, allowSingleAngle: boolean): EditorialPlan {
  const object = (input: unknown) => input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const plan = object(value);
  const decisions = new Map<string, EditorialPlan['materialDecisions'][number]>();
  const conflicts = new Set<string>();
  for (const item of Array.isArray(plan.materialDecisions) ? plan.materialDecisions : []) {
    const { evidence_id, evidenceId, ...rest } = object(item);
    if (evidenceId !== undefined && evidence_id !== undefined && evidenceId !== evidence_id) continue;
    const parsed = EditorialPlanSchema.shape.materialDecisions.element.safeParse({ evidenceId: evidenceId ?? evidence_id, ...rest });
    if (!parsed.success || !evidenceIds.has(parsed.data.evidenceId)) continue;
    const decision = parsed.data;
    const previous = decisions.get(decision.evidenceId);
    if (previous && previous.decision !== decision.decision) conflicts.add(decision.evidenceId);
    else decisions.set(decision.evidenceId, decision);
  }
  const materialDecisions = [...evidenceIds].map(evidenceId => {
    const decision = conflicts.has(evidenceId) ? undefined : decisions.get(evidenceId);
    return decision ?? { evidenceId, decision: 'omit', reason: '本轮研究没有给出明确的使用决定。' };
  });
  const angles = Array.isArray(plan.angles) ? plan.angles.map(item => {
    const angle = object(item);
    const supportingEvidenceIds = (Array.isArray(angle.supportingEvidenceIds) ? angle.supportingEvidenceIds : []).filter(id =>
      typeof id === 'string' && evidenceIds.has(id) && (angle.id !== plan.selectedAngleId ||
        (!conflicts.has(id) && decisions.get(id)?.decision === 'use')));
    return { ...angle, id: angle.id, supportingEvidenceIds: [...new Set(supportingEvidenceIds)] };
  }) : [];
  const selected = angles.find(angle => angle.id === plan.selectedAngleId);
  const gaps = (!Array.isArray(plan.gaps) || plan.gaps.length === 0) && selected?.supportingEvidenceIds.length === 0
    ? ['按当前写作方向使用已有材料，无法定位出处的具体事实留待核实。'] : plan.gaps;
  return parseEditorialPlan({ ...plan, angles, materialDecisions, gaps }, evidenceIds, { allowSingleAngle });
}
