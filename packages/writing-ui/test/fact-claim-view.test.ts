import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { factClaimStatusLabel } from '../src/fact-claim-view.js'

describe('fact claim presentation', () => {
  it('never labels a partial supported claim as fully supported', () => {
    assert.equal(
      factClaimStatusLabel({ status: 'SUPPORTED', supportScope: 'partial', risk: 'yellow' }),
      '仅部分支持，仍会阻断',
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
