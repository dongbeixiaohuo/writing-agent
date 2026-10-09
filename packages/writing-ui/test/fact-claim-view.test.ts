import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { factClaimStatusLabel } from '../src/fact-claim-view.js'

describe('fact claim presentation', () => {
  it('distinguishes source-material agreement from actual external verification', () => {
    const claim = { status: 'SUPPORTED', supportScope: 'full', risk: 'green' } as const;
    assert.equal(factClaimStatusLabel({ ...claim, verificationMethod: 'material_comparison' }), '材料对照一致，不代表独立查证');
    assert.equal(factClaimStatusLabel({ ...claim, verificationMethod: 'model_review' }), '仅模型复核，未联网验证');
    assert.equal(factClaimStatusLabel({ ...claim, verificationMethod: 'external_source', verificationRecordIds: ['source1'] }), '外部来源核对，模型判断一致');
    assert.notEqual(factClaimStatusLabel({ ...claim, verificationMethod: 'external_source' }), '外部来源核对，模型判断一致');
  })
  it('never labels a partial supported claim as fully supported', () => {
    assert.equal(
      factClaimStatusLabel({ status: 'SUPPORTED', supportScope: 'partial', risk: 'yellow' }),
      '仅部分支持（中低风险，不阻断）',
    )
    assert.equal(
      factClaimStatusLabel({ status: 'SUPPORTED', supportScope: 'full', risk: 'green' }),
      '已有材料完整支持',
    )
  })

  it('keeps red risk visible even when the declared support scope is full', () => {
    assert.equal(
      factClaimStatusLabel({ status: 'SUPPORTED', supportScope: 'full', risk: 'red' }),
      '高风险主张，仍会阻断',
    )
  })
})
