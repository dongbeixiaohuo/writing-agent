export interface WritingAgentBrand {
  readonly productName: string
  readonly shortName: string
  readonly assistantName: string
  readonly aboutTitle: string
}

export const WRITING_AGENT_BRAND: WritingAgentBrand = Object.freeze({
  productName: 'Writing Agent',
  shortName: 'WA',
  assistantName: 'Writing Agent',
  aboutTitle: '关于 Writing Agent',
})

export function createBrandConfig(
  overrides: Partial<WritingAgentBrand> = {},
): WritingAgentBrand {
  const next = { ...WRITING_AGENT_BRAND, ...overrides }
  if (next.productName.trim().length === 0) throw new Error('BRAND_PRODUCT_NAME_REQUIRED')
  if (next.shortName.trim().length === 0) throw new Error('BRAND_SHORT_NAME_REQUIRED')
  if (next.assistantName.trim().length === 0) throw new Error('BRAND_ASSISTANT_NAME_REQUIRED')
  if (next.aboutTitle.trim().length === 0) throw new Error('BRAND_ABOUT_TITLE_REQUIRED')
  return Object.freeze(next)
}
