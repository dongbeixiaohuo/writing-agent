import type { FactCheckWorkspace } from '../../../client-bridge/src/protocol.ts'

/** Describe persisted claim evidence, never infer an old report's coverage from today's settings. */
export function factVerificationNotice(workspace: FactCheckWorkspace): string {
  const claims = workspace.assessment?.claims ?? []
  const modelOnly = claims.some(claim => claim.sourceReference?.includes('model-knowledge:unverified') || /模型知识复核|仅模型复核|未联网验证/u.test(claim.evidenceSummary))
  const hasReferences = claims.some(claim => /^https?:\/\//u.test(claim.sourceReference ?? ''))
  if (modelOnly) return `${hasReferences ? '部分主张' : ''}仅模型复核，未联网验证；重要事实请自行核实。`
  if (hasReferences) return '核查报告包含来源引用，不代表事实绝对正确；重要事实请结合原始来源核对。'
  return '本报告未记录外部事实查证依据；基于已有材料与模型复核，重要事实请自行核实。'
}

export interface PublicationGateNoticeItem {
  readonly id: string
  readonly summary: string
  readonly action: string
}

export interface PublicationGateNotice {
  readonly tone: 'danger' | 'warning'
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly items: readonly PublicationGateNoticeItem[]
}

export function publicationGateNotice(
  workspace: FactCheckWorkspace,
  handling: 'idle' | 'agent_handling' | 'author_question' = 'idle',
): PublicationGateNotice | null {
  // The active agent progress or its focused question is the primary message.
  // Technical findings remain visible in manuscript details and still gate export.
  if (handling !== 'idle' && (workspace.status === 'blocked' || workspace.status === 'stale')) return null
  if (workspace.status === 'blocked') {
    const blockerIds = new Set(workspace.assessment?.blockers ?? [])
    const blockerClaims = (workspace.assessment?.claims ?? [])
      .filter(claim => blockerIds.has(claim.claimId) && claim.risk === 'red')
    if (blockerClaims.length === 0 && blockerIds.size > 0) return {
      tone: 'warning', eyebrow: '旧核查报告', title: '请按轻量规则重新核查',
      description: '这份旧报告按此前的严格规则阻断了交付。中低风险提示无需逐条处理；点击“查看当前稿件”，选择“重新核查当前稿件”生成新报告。', items: [],
    }
    const count = blockerClaims.length
    return {
      tone: 'warning',
      eyebrow: '稿件已保存',
      title: `还有 ${count} 项核查问题待处理`,
      description: '你可以在主对话中继续，写作助手会先核对并处理这些问题；确实需要你的信息或决定时再向你提问。核查通过前不会正式导出。',
      items: blockerClaims.slice(0, 3).map(claim => ({
        id: claim.claimId,
        summary: claim.claimText,
        action: claim.recommendedAction,
      })),
    }
  }
  if (workspace.status === 'stale') {
    return {
      tone: 'warning',
      eyebrow: '需要重新确认',
      title: '当前稿件的核查结果已失效',
      description: '正文、标题或证据在核查后发生了变化。旧报告仍可追溯，但正式交付前必须重新核查当前版本。',
      items: [],
    }
  }
  if (workspace.status === 'error') {
    return {
      tone: 'danger',
      eyebrow: '核查未完成',
      title: '事实核查没有形成可用结果',
      description: '正式交付已暂停。请查看详细原因并重试，已经保存的稿件不会丢失。',
      items: [],
    }
  }
  return null
}
