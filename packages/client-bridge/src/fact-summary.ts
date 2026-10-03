type UnknownRecord = Readonly<Record<string, unknown>>;

const MODEL_ONLY_SOURCE = 'model-knowledge:unverified';
const MAX_DISPLAYED_CLAIMS = 8;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function bounded(value: string, max = 280): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function sourceLabel(claim: UnknownRecord): string {
  const sourceReference = text(claim.sourceReference);
  const evidenceId = text(claim.matchedEvidenceId);
  if (sourceReference === MODEL_ONLY_SOURCE) return '没有外部来源';
  if (
    sourceReference !== null &&
    !/^(?:material|artifact|version|project|writing-intake|conversation-user-operation):/iu.test(sourceReference) &&
    !/^(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|private)\/)/u.test(sourceReference)
  ) {
    return bounded(sourceReference);
  }
  if (evidenceId !== null || sourceReference !== null) return '已提供材料';
  return '没有保存可展示的来源说明';
}

function statusLabel(claim: UnknownRecord): string {
  const status = text(claim.status);
  const supportScope = text(claim.supportScope);
  const modelOnly = text(claim.sourceReference) === MODEL_ONLY_SOURCE ||
    /模型知识复核.*未联网验证/u.test(text(claim.evidenceSummary) ?? '');
  if (status === 'SUPPORTED' && modelOnly) return '仅模型复核，未联网验证';
  if (status === 'SUPPORTED' && supportScope === 'full') return '与来源一致';
  if (status === 'SUPPORTED') return '部分内容有依据';
  if (status === 'UNSUPPORTED') return '缺少支持';
  if (status === 'CONTRADICTED') return '与证据矛盾';
  if (status === 'BROKEN_LINK') return '来源链接失效';
  if (status === 'NEEDS_USER_SOURCE') return '需要作者补充来源';
  return '状态未记录';
}

/**
 * Builds author-facing copy exclusively from the persisted fact assessment.
 * The function is deliberately deterministic: refreshes reconstruct the same
 * completion message without another model call or a second source search.
 */
export function factCheckCompletionSummary(assessment: unknown): string {
  const assessmentRecord = record(assessment);
  const payload = record(assessmentRecord?.payload);
  const claims = Array.isArray(payload?.claims)
    ? payload.claims.map(record).filter((claim): claim is UnknownRecord => claim !== null)
    : null;

  if (assessmentRecord === null || payload === null || claims === null) {
    return [
      '这版文章此前已完成事实核查，可以导出。',
      '',
      '旧记录没有保存可展示的逐条核查说明，因此这里不能还原核查了哪些信息或使用了哪些来源。需要确认细节时，请对这版文章重新核查。',
      '',
      '限制：当时的核查结果通过不代表事实绝对正确。',
    ].join('\n');
  }

  const coverage = record(payload.coverage);
  const coverageLabels = [
    coverage?.body === true ? '文章正文' : null,
    coverage?.title === true ? '标题' : null,
    coverage?.distributionCopy === true ? '发布配文' : null,
  ].filter((label): label is string => label !== null);
  const lines = [
    '这版文章已完成事实核查，可以导出。',
    `核查范围：${coverageLabels.length === 3 ? `${coverageLabels[0]}、${coverageLabels[1]}和${coverageLabels[2]}` : coverageLabels.length > 0 ? coverageLabels.join('、') : '旧记录没有保存具体范围'}`,
  ];

  if (claims.length === 0) {
    const reason = text(payload.noFactualClaimsReason);
    lines.push(
      '核查结果：未识别出需要逐条查证的客观信息。',
      `判断依据：${reason === null ? '旧记录没有保存具体原因。' : bounded(reason, 500)}`,
      '方式与限制：这是对这版文章没有识别出待查证信息的判断，不代表已对未列出的信息做外部验证，也不代表事实绝对正确。',
    );
    return lines.join('\n\n');
  }

  lines.push(`核查结果：共核对 ${claims.length} 条可核实信息。`);
  for (const [index, claim] of claims.slice(0, MAX_DISPLAYED_CLAIMS).entries()) {
    const claimText = text(claim.claimText) ?? '未保存主张原文';
    const location = text(claim.location);
    const evidenceSummary = text(claim.evidenceSummary) ?? '未保存证据摘要。';
    lines.push([
      `**${index + 1}. ${bounded(claimText, 360)}${location === null ? '' : `（${bounded(location, 120)}）`}**`,
      '',
      `- 结论：${statusLabel(claim)}`,
      `- 依据：${bounded(evidenceSummary, 500)}`,
      `- 来源：${sourceLabel(claim)}`,
    ].join('\n'));
  }
  if (claims.length > MAX_DISPLAYED_CLAIMS) {
    lines.push(`其余 ${claims.length - MAX_DISPLAYED_CLAIMS} 条请在“事实核查”详情中查看。`);
  }

  const modelOnlyCount = claims.filter((claim) =>
    text(claim.sourceReference) === MODEL_ONLY_SOURCE ||
    /模型知识复核.*未联网验证/u.test(text(claim.evidenceSummary) ?? '')
  ).length;
  if (modelOnlyCount === claims.length) {
    lines.push('方式与限制：本次仅模型复核，未联网验证；模型知识不是外部证据。这次核查通过不代表事实绝对正确。');
  } else if (modelOnlyCount > 0) {
    lines.push(`方式与限制：其中 ${modelOnlyCount} 条仅由模型知识复核、未联网验证，不构成外部证据；其余内容依据上列来源。这次核查通过不代表事实绝对正确。`);
  } else {
    lines.push('方式与限制：以上结论依据已保存的材料或来源；这次核查通过不代表事实绝对正确，时效性信息仍应在发布前复验。');
  }
  return lines.join('\n\n');
}
