import type { FactClaimView } from '../../client-bridge/src/protocol.js'

export function factClaimStatusLabel(
  claim: Pick<FactClaimView, 'status' | 'supportScope' | 'risk'>,
): string {
  if (claim.status === 'SUPPORTED') {
    if (claim.supportScope === 'partial') return '仅部分支持，仍会阻断'
    if (claim.supportScope === 'none') return '未获得有效支持'
    if (claim.risk === 'red') return '高风险主张，仍会阻断'
    return '已有材料完整支持'
  }
  return {
    UNSUPPORTED: '缺少支持材料',
    CONTRADICTED: '与现有材料冲突',
    BROKEN_LINK: '来源链接不可用',
    NEEDS_USER_SOURCE: '需要你补充来源',
  }[claim.status]
}
