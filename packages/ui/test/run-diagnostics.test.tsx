import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunDiagnosticsView } from '../../client-bridge/src/protocol.ts'
import { RunDiagnostics } from '../src/shell/RunDiagnostics.tsx'

test('execution details expose grouped reads and each model attempt, with explicit unknown usage and real error codes', () => {
  const diagnostics: RunDiagnosticsView = { segments: [{
    id: 'segment-1', label: '执行段 1 · 恢复后', startedAt: '2026-09-22T00:00:00.000Z',
    modelRequests: [
      { id: 'request-1', status: 'failed', durationMs: 1200, errorCode: 'MODEL_OUTPUT_TRUNCATED', usage: null },
      { id: 'request-2', status: 'completed', durationMs: 2200, errorCode: null, usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    ],
    toolGroups: [{ toolName: 'read_material', label: '读取参考材料', count: 3, completed: 2, failed: 1, pending: 0,
      outcomeUnknown: 0, errorCodes: ['MATERIAL_NOT_FOUND'], targets: [
        { id: 'm-1', label: '行业案例', versionId: 'v-1', count: 3, completed: 2, failed: 1, pending: 0, outcomeUnknown: 0, errorCodes: ['MATERIAL_NOT_FOUND'] },
      ] }],
    decisions: [{ id: 'decision-1', actor: 'planner', stage: 'outline', status: 'dispatched', reason: '请策划形成提纲' }],
  }] }
  const html = renderToStaticMarkup(<RunDiagnostics diagnostics={diagnostics} />)
  assert.match(html, /执行段 1 · 恢复后/u)
  assert.match(html, /模型请求 1/u)
  assert.match(html, /模型请求 2/u)
  assert.match(html, /MODEL_OUTPUT_TRUNCATED/u)
  assert.match(html, /用量未报告/u)
  assert.match(html, /输入 12.*输出 8.*总计 20/u)
  assert.match(html, /行业案例.*m-1/u)
  assert.match(html, /MATERIAL_NOT_FOUND/u)
  assert.match(html, /请策划形成提纲/u)
  assert.match(html, /<details class="run-diagnostics-block run-diagnostics-models"><summary>/u)
  assert.match(html, /<details class="run-diagnostics-reason"><summary>/u)
  assert.match(html, /选题策划/u)
  assert.match(html, /已分派/u)
  assert.match(html, /<details class="run-diagnostics-identifiers"><summary>/u)
  assert.match(html.replace(/<[^>]+>/gu, ''), /执行段 1 · 恢复后\s*｜\s*2 次模型请求/u)
  assert.match(html, /工具名称：.*read_material/u)
  assert.match(html, /未记录调用者/u)
})
