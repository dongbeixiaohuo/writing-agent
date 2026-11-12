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
  '随研究台账提交 editorialPlan。在作者立场内比较2–3个具体切口：readerProblem是读者面临的实际困惑或取舍，readerGain是比题目能猜到的常识多知道什么，angle只承诺本文能讲透的一件事。分类、赞成反对各说一遍不自动构成新收获；作者的价值立场不等于有关效果、趋势或机制已经得到证明。',
  '先用实际引文重建claim_text与use_boundary。材料附带的解读、历史台账的适用范围也可能推错，不能照抄当证据。同期比例不能说明前后变化，相关不能确定原因，研究没有测的机制不能补成结论；作者评论和假设只提供思考，不能作事实证明。',
  'selectedAngleId只选择材料真正撑得住的切口。selectionReason说明它比泛谈题目多了什么，以及哪个具体材料使这个判断成立。为每条证据显式填写evidence_id，在materialDecisions逐条use/omit；reason写这条材料实际支持的最小判断，缺哪一步也说明。数字仅与话题相关、却不能推进所选判断时舍弃，不为开头垫数据或凑权威。supportingEvidenceIds只引用存在且use的证据。',
  '关键支持缺失就直接缩小angle与readerGain，或转为能自洽的概念辨析，不先许下大结论再用免责声明兜底。gaps记录缩小后的边界；无事实材料的个人随笔允许空证据并说明范围。计划仅作内部选题和选材，正文不复制这些字段、边界检查或真假标签。',
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
