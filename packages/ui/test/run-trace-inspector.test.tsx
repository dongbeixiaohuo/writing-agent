import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunRecordView } from '../../client-bridge/src/protocol.ts'
import {
  INITIAL_DETAIL_LOAD_STATE,
  RunTrace,
  isNearTraceTail,
  reduceDetailLoadState,
} from '../src/shell/RunTrace.tsx'

function recordWithSteps(count: number): RunRecordView {
  return {
    id: 'run-ledger', status: 'completed', displayInstruction: '检查真实调用轨迹',
    startedAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:02:00.000Z', stopReason: null,
    modelRequests: count, maxModelRequests: 100, toolCalls: 0, maxToolCalls: 100, totalTokens: null,
    stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: {
      segments: [{ id: 'segment-1', label: '执行段 1', startedAt: '2026-10-03T00:00:00.000Z', modelRequests: [], toolGroups: [], decisions: [] }],
      trace: Array.from({ length: count }, (_, index) => ({
        id: `step-${String(index)}`, segmentId: 'segment-1', occurredAt: new Date(Date.parse('2026-10-03T00:00:00.000Z') + index * 1000).toISOString(),
        completedAt: new Date(Date.parse('2026-10-03T00:00:00.500Z') + index * 1000).toISOString(),
        kind: 'model' as const, status: 'completed' as const, label: index === 0 ? 'EARLY_ZERO' : `模型调用 ${String(index)}`,
        actorLabel: '写作导演', durationMs: 500, inputPreview: `输入摘要 ${String(index)}`, outputPreview: `输出摘要 ${String(index)}`,
        errorCode: null,
      })),
    },
  }
}

test('run trace starts as a bounded searchable ledger with an explicit inspector', () => {
  const html = renderToStaticMarkup(<RunTrace records={[recordWithSteps(62)]} />)

  assert.match(html, /在输入与结果摘要中搜索/u)
  assert.match(html, /显示最近 60 条，共 62 条/u)
  assert.match(html, /加载更早 2 条/u)
  assert.ok(html.indexOf('加载更早 2 条') < html.indexOf('输入摘要 2'))
  assert.doesNotMatch(html, /EARLY_ZERO/u)
  assert.doesNotMatch(html, /输入摘要 1<\/span>/u)
  assert.match(html, /输入摘要 61/u)
  assert.match(html, /输出摘要 61/u)
  assert.match(html, /选择左侧步骤查看真实请求与结果/u)
  assert.match(html, /role="tablist"/u)
  assert.match(html, /概览.*输入.*输出.*Schema.*时序/u)
})

test('tail following only stays active while the reader is near the latest step', () => {
  assert.equal(isNearTraceTail({ scrollHeight: 1000, scrollTop: 600, clientHeight: 360 }), true)
  assert.equal(isNearTraceTail({ scrollHeight: 1000, scrollTop: 400, clientHeight: 360 }), false)
})

test('detail state ignores a response that belongs to a stale selection', () => {
  const selectedA = reduceDetailLoadState(INITIAL_DETAIL_LOAD_STATE, { type: 'start', key: 'run-a:step-a', request: 1 })
  const selectedB = reduceDetailLoadState(selectedA, { type: 'start', key: 'run-b:step-b', request: 2 })
  const stale = reduceDetailLoadState(selectedB, { type: 'resolve', key: 'run-a:step-a', request: 1, detail: {
    runId: 'run-a', stepId: 'step-a', requestId: 'request-a', callId: null, provider: 'provider-a', model: 'model-a',
    sections: [{ id: 'output', label: '模型响应', format: 'text', text: '旧响应', totalCharacters: 3, truncated: false }], notes: [],
  } })

  assert.deepEqual(stale, selectedB)
  assert.equal(stale.key, 'run-b:step-b')
  assert.equal(stale.status, 'loading')
})

test('detail state distinguishes failed loads, retries, and missing persisted history', () => {
  const loading = reduceDetailLoadState(INITIAL_DETAIL_LOAD_STATE, { type: 'start', key: 'run-a:step-a', request: 1 })
  const failed = reduceDetailLoadState(loading, { type: 'reject', key: 'run-a:step-a', request: 1, message: '读取失败' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.message, '读取失败')

  const retrying = reduceDetailLoadState(failed, { type: 'start', key: 'run-a:step-a', request: 2 })
  const missing = reduceDetailLoadState(retrying, { type: 'resolve', key: 'run-a:step-a', request: 2, detail: {
    runId: 'run-a', stepId: 'step-a', requestId: null, callId: null, provider: null, model: null, sections: [],
    notes: ['早期运行没有保存原始载荷。'],
  } })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.detail?.notes[0], '早期运行没有保存原始载荷。')
})
