import type { FactClaimView } from '../../client-bridge/src/protocol.js'

export function factClaimStatusLabel(
  claim: Pick<FactClaimView, 'status' | 'supportScope' | 'risk' | 'verificationMethod' | 'verificationRecordIds'>,
): string {
  if (claim.status === 'SUPPORTED') {
    if (claim.supportScope === 'partial') return '仅部分支持，仍会阻断'
    if (claim.supportScope === 'none') return '未获得有效支持'
    if (claim.risk === 'red') return '高风险主张，仍会阻断'
    if (claim.verificationMethod === 'model_review') return '仅模型复核，未联网验证'
    if (claim.verificationMethod === 'external_source' && claim.verificationRecordIds?.length) return '外部来源核对，模型判断一致'
    if (claim.verificationMethod === 'material_comparison') return '材料对照一致，不代表独立查证'
    return '已有材料完整支持'
  }
  return {
    UNSUPPORTED: '缺少支持材料',
    CONTRADICTED: '与现有材料冲突',
    BROKEN_LINK: '来源链接不可用',
    NEEDS_USER_SOURCE: '需要你补充来源',
  }[claim.status]
}
