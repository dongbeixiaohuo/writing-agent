export interface EvidenceClaimView {
  readonly evidenceId: string
  readonly claimType: string
  readonly claimText: string
  readonly sourceTitle: string
  readonly sourcePublisher: string
  readonly sourceQuote: string
  readonly reliability: string
  readonly useBoundary: string
  readonly verificationStatus: string
}

export interface EvidenceLedgerView {
  readonly claims: readonly EvidenceClaimView[]
  readonly notes: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function parseEvidenceLedgerView(content: string): EvidenceLedgerView | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Readonly<Record<string, unknown>>
  if (!Array.isArray(record.claims)) return null
  const claims: EvidenceClaimView[] = []
  for (const value of record.claims) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const claim = value as Readonly<Record<string, unknown>>
    const evidenceId = nonEmptyString(claim.evidence_id)
    const claimType = nonEmptyString(claim.claim_type)
    const claimText = nonEmptyString(claim.claim_text)
    const sourceTitle = nonEmptyString(claim.source_title)
    const sourcePublisher = nonEmptyString(claim.source_publisher)
    const sourceQuote = nonEmptyString(claim.source_quote)
    const reliability = nonEmptyString(claim.reliability)
    const useBoundary = nonEmptyString(claim.use_boundary)
    const verificationStatus = nonEmptyString(claim.verification_status)
    if (
      evidenceId === null || claimType === null || claimText === null ||
      sourceTitle === null || sourcePublisher === null || sourceQuote === null ||
      reliability === null || useBoundary === null || verificationStatus === null
    ) return null
    claims.push({
      evidenceId,
      claimType,
      claimText,
      sourceTitle,
      sourcePublisher,
      sourceQuote,
      reliability,
      useBoundary,
      verificationStatus,
    })
  }
  const notes = nonEmptyString(record.notes)
  if (notes === null) return null
  return { claims, notes }
}
