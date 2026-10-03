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
  assert.doesNotMatch(html, /查看旧版分段统计/u)
})

test('failed steps show a human cause, technical code and actionable remediation in the ledger', () => {
  const record = recordWithSteps(1)
  record.diagnostics = { ...record.diagnostics!, trace: [
    { id: 'model', segmentId: 'segment-1', occurredAt: '2026-10-03T00:00:01.000Z', completedAt: '2026-10-03T00:00:31.000Z',
      kind: 'model', status: 'failed', label: '模型请求失败', durationMs: 30_000, errorCode: 'TIMEOUT',
      transport: { phase: 'first_response', timeoutMs: 30_000, elapsedMs: 30_001, firstResponseMs: null, lastActivityMs: null } },
    { id: 'search', segmentId: 'segment-1', occurredAt: '2026-10-03T00:00:32.000Z', completedAt: '2026-10-03T00:00:33.000Z',
      kind: 'tool', status: 'failed', label: '搜索公开事实', technicalName: 'search_fact_sources', durationMs: 1_000, errorCode: 'SEARCH_HTTP_429' },
    { id: 'source', segmentId: 'segment-1', occurredAt: '2026-10-03T00:00:34.000Z', completedAt: '2026-10-03T00:00:34.010Z',
      kind: 'tool', status: 'failed', label: '读取事实来源', technicalName: 'read_fact_source', durationMs: 10, errorCode: 'FACT_SOURCE_NOT_IN_LEDGER' },
    { id: 'gate', segmentId: 'segment-1', occurredAt: '2026-10-03T00:00:35.000Z', completedAt: '2026-10-03T00:00:35.010Z',
      kind: 'tool', status: 'failed', label: '提交事实核查', technicalName: 'submit_fact_check', durationMs: 10, errorCode: 'FACT_CHECK_EVIDENCE_REFERENCE_INVALID' },
  ] }

  const html = renderToStaticMarkup(<RunTrace records={[record]} />)
  assert.match(html, /模型未在等待时限内返回首个有效内容/u)
  assert.match(html, /公开搜索服务请求失败/u)
  assert.match(html, /来源读取被授权记录门禁拒绝/u)
  assert.match(html, /事实核查提交被业务门禁拒绝/u)
  assert.match(html, /处理建议/u)
  assert.match(html, /技术代码.*TIMEOUT.*SEARCH_HTTP_429.*FACT_SOURCE_NOT_IN_LEDGER.*FACT_CHECK_EVIDENCE_REFERENCE_INVALID/us)
  assert.doesNotMatch(html, /查看旧版分段统计|模型编造|网站宕机/u)
})

test('tail following only stays active while the reader is near the latest step', () => {
  assert.equal(isNearTraceTail({ scrollHeight: 1000, scrollTop: 600, clientHeight: 360 }), true)
  assert.equal(isNearTraceTail({ scrollHeight: 1000, scrollTop: 400, clientHeight: 360 }), false)
})

test('cross-day trace shows full dates and the old-to-new direction', () => {
  const source = recordWithSteps(1)
  const at = (id: string, date: string): RunRecordView => ({ ...source, id, diagnostics: { ...source.diagnostics!,
    trace: [{ ...source.diagnostics!.trace![0]!, occurredAt: date }] } })
  const older = at('older', '2026-10-01T12:00:00Z')
  const newer = at('newer', '2026-10-03T12:00:00Z')
  const html = renderToStaticMarkup(<RunTrace records={[newer, older]} />)
  assert.match(html, /<time[^>]*>2026-10-01/)
  assert.match(html, /<time[^>]*>2026-10-03/)
  assert.match(html, /较早.*↓.*最新/)
  assert.ok(html.indexOf('2026-10-01') < html.indexOf('2026-10-03'))
  assert.match(html, /最新记录/)
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
