import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseEvidenceLedgerView } from '../src/evidence-ledger-view.js'

describe('evidence ledger view', () => {
  it('turns the strict research JSON into readable claim fields', () => {
    const result = parseEvidenceLedgerView(JSON.stringify({
      claims: [{
        evidence_id: 'E001',
        claim_type: 'policy',
        claim_text: '离开座位时锁屏',
        source_title: '远程办公要求',
        source_publisher: '用户提供',
        source_quote: '离开座位时锁屏',
        accessed_at: '本次运行',
        reliability: 'high',
        use_boundary: '仅支持锁屏要求',
        verification_status: 'user_provided',
      }],
      notes: '不得扩写为自动锁屏时长。',
    }))

    assert.deepEqual(result, {
      claims: [{
        evidenceId: 'E001',
        claimType: 'policy',
        claimText: '离开座位时锁屏',
        sourceTitle: '远程办公要求',
        sourcePublisher: '用户提供',
        sourceQuote: '离开座位时锁屏',
        reliability: 'high',
        useBoundary: '仅支持锁屏要求',
        verificationStatus: 'user_provided',
      }],
      notes: '不得扩写为自动锁屏时长。',
    })
  })

  it('falls back when old or malformed research content is not strict JSON', () => {
    assert.equal(parseEvidenceLedgerView('# 研究记录'), null)
    assert.equal(parseEvidenceLedgerView('{"claims":[{}],"notes":"缺字段"}'), null)
  })
})
