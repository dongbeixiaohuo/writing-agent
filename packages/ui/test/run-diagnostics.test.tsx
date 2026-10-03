import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunDiagnosticsView } from '../../client-bridge/src/protocol.ts'
import { RunDiagnostics } from '../src/shell/RunDiagnostics.tsx'
import { RunTrace } from '../src/shell/RunTrace.tsx'

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

test('run trace presents chronological live work instead of repeated run summary cards', () => {
  const records = [{
    id: 'run-1', status: 'running' as const, displayInstruction: '开始', startedAt: '2026-10-02T07:13:53.000Z', completedAt: null,
    stopReason: null, modelRequests: 2, maxModelRequests: 24, toolCalls: 1, maxToolCalls: 32, totalTokens: null,
    stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: { segments: [], trace: [
      { id: 'request-1', segmentId: 'segment-1', occurredAt: '2026-10-02T07:13:53.000Z', completedAt: '2026-10-02T07:17:08.000Z',
        kind: 'model' as const, status: 'completed' as const, label: '模型响应', requestId: 'request-director', actorLabel: '写作导演',
        durationMs: 195000, inputPreview: '第 1 次模型请求', outputPreview: '返回 1 个工具调用', errorCode: null,
        stream: { headersMs: 12, firstReasoningMs: 120, lastReasoningMs: 190000, reasoningEvents: 37,
          firstContentMs: 194000, lastContentMs: 194900, contentEvents: 8 } },
      { id: 'tool-1', segmentId: 'segment-1', occurredAt: '2026-10-02T07:17:08.000Z', completedAt: '2026-10-02T07:17:08.040Z',
        kind: 'tool' as const, status: 'completed' as const, label: '读取参考材料', technicalName: 'read_material', actorLabel: '写作导演',
        durationMs: 40, inputPreview: '材料：需求说明', outputPreview: '已读取指定材料版本', errorCode: null },
      { id: 'request-2', segmentId: 'segment-1', occurredAt: '2026-10-02T07:17:09.000Z', completedAt: null,
        kind: 'model' as const, status: 'pending' as const, label: '等待模型响应', requestId: 'request-fact',
        durationMs: null, inputPreview: '第 2 次模型请求', errorCode: null },
    ] } satisfies RunDiagnosticsView,
  }]
  const html = renderToStaticMarkup(<RunTrace records={records} activeRunId="run-1" liveActivity={{
    runId: 'run-1', requestId: 'request-fact', actor: 'fact_check', phase: 'waiting', startedAt: Date.parse('2026-10-02T07:17:09.000Z'), lastActivityAt: null,
  }} now={Date.parse('2026-10-02T07:17:39.000Z')} />)
  assert.match(html, /写作导演.*模型响应/u)
  assert.match(html, /3 分 15 秒/u)
  assert.match(html, /事实核查.*等待模型响应/u)
  assert.match(html, /已等待 30 秒/u)
  assert.match(html, /aria-current="step"/u)
  assert.match(html, /当前活动/u)
  assert.match(html, /读取参考材料/u)
  assert.match(html, /40 毫秒/u)
  assert.match(html, /连接.*12 毫秒/u)
  assert.match(html, /推理活动.*120 毫秒.*3 分 10 秒.*37 次/u)
  assert.match(html, /首个有效内容.*3 分 14 秒/u)
  assert.match(html, /总耗时.*3 分 15 秒/u)
  assert.doesNotMatch(html, /查看旧版分段统计|run-trace-legacy/u)
  assert.doesNotMatch(html, /模型请求 2\s*\/\s*24|工具调用 1\s*\/\s*32/u)
})

test('live trace distinguishes private model activity from visible content and hands off to the active tool', () => {
  const startedAt = Date.parse('2026-10-02T07:17:09.000Z')
  const records = [{
    id: 'run-live', status: 'running' as const, displayInstruction: '核查事实', startedAt: new Date(startedAt).toISOString(), completedAt: null,
    stopReason: null, modelRequests: 1, maxModelRequests: 24, toolCalls: 1, maxToolCalls: 32, totalTokens: null,
    stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: { segments: [], trace: [{ id: 'request-live', segmentId: 'segment-live', occurredAt: new Date(startedAt).toISOString(),
      completedAt: null, kind: 'model' as const, status: 'pending' as const, label: '等待模型响应', requestId: 'request-live',
      durationMs: null, inputPreview: '第 1 次模型请求', errorCode: null }] } satisfies RunDiagnosticsView,
  }]
  const reasoning = renderToStaticMarkup(<RunTrace records={records} activeRunId="run-live" liveActivity={{
    runId: 'run-live', requestId: 'request-live', actor: 'fact_check', phase: 'receiving', startedAt, lastActivityAt: startedAt + 2000,
    lastEventKind: 'reasoning', receivedEvents: 3,
  }} now={startedAt + 4000} />)
  assert.match(reasoning, /模型内部处理中/u)
  assert.match(reasoning, /不展示私有推理/u)
  assert.doesNotMatch(reasoning, /正在返回可展示内容/u)

  const tool = renderToStaticMarkup(<RunTrace records={records} activeRunId="run-live" liveActivity={{
    runId: 'run-live', requestId: 'request-live', actor: 'fact_check', phase: 'receiving', startedAt, lastActivityAt: startedAt + 2000,
    lastEventKind: 'tool_arguments', receivedEvents: 5, activeTool: { name: 'search_fact_sources', startedAt: startedAt + 3000 },
  }} now={startedAt + 8000} />)
  assert.match(tool, /事实核查.*模型响应/u)
  assert.match(tool, /搜索事实来源.*进行中.*已进行 5 秒/u)
  assert.match(tool, /当前活动/u)
  assert.doesNotMatch(tool, /等待模型响应/u)
})

test('run trace globally interleaves resumed work with later runs and keeps lightweight context on every step', () => {
  const base = { stopReason: null, modelRequests: 1, maxModelRequests: 24, toolCalls: 1, maxToolCalls: 32, totalTokens: null,
    stages: [], completedStages: 0, totalStages: 1, publicationReady: false }
  const records = [{ ...base, id: 'run-a', status: 'completed' as const, displayInstruction: '长写作任务',
    startedAt: '2026-10-02T07:00:00.000Z', completedAt: '2026-10-02T07:30:01.000Z', diagnostics: { segments: [
      { id: 'segment-a1', label: '执行段 1', startedAt: '2026-10-02T07:00:00.000Z', modelRequests: [], toolGroups: [], decisions: [] },
      { id: 'segment-a2', label: '执行段 2 · 恢复后', startedAt: '2026-10-02T07:30:00.000Z', modelRequests: [], toolGroups: [], decisions: [] },
    ], trace: [
      { id: 'a-early', segmentId: 'segment-a1', occurredAt: '2026-10-02T07:00:01.000Z', completedAt: '2026-10-02T07:00:02.000Z', kind: 'model' as const, status: 'completed' as const,
        label: '模型响应', durationMs: 1000, outputPreview: 'A 早期步骤', errorCode: null },
      { id: 'a-resumed', segmentId: 'segment-a2', occurredAt: '2026-10-02T07:30:00.000Z', completedAt: '2026-10-02T07:30:01.000Z', kind: 'agent' as const, status: 'completed' as const,
        label: '导演调度', durationMs: 1000, outputPreview: 'A 恢复步骤', errorCode: null },
    ] } satisfies RunDiagnosticsView },
  { ...base, id: 'run-b', status: 'completed' as const, displayInstruction: '中间确认任务',
    startedAt: '2026-10-02T07:15:00.000Z', completedAt: '2026-10-02T07:15:02.000Z', diagnostics: { segments: [
      { id: 'segment-b1', label: '执行段 1', startedAt: '2026-10-02T07:15:00.000Z', modelRequests: [], toolGroups: [], decisions: [] },
    ], trace: [{ id: 'b-middle', segmentId: 'segment-b1', occurredAt: '2026-10-02T07:15:01.000Z', completedAt: '2026-10-02T07:15:02.000Z',
      kind: 'tool' as const, status: 'completed' as const, label: '保存作者交流', durationMs: 1000, outputPreview: 'B 中间步骤', errorCode: null }] } satisfies RunDiagnosticsView }]
  const html = renderToStaticMarkup(<RunTrace records={records} />)
  assert.ok(html.indexOf('A 早期步骤') < html.indexOf('B 中间步骤'))
  assert.ok(html.indexOf('B 中间步骤') < html.indexOf('A 恢复步骤'))
  assert.match(html, /长写作任务.*执行段 2 · 恢复后/u)
  assert.match(html, /中间确认任务.*执行段 1/u)
})

test('a dangling tool after a stopped run is not presented as model waiting or still running', () => {
  const records = [{ id: 'run-stopped', status: 'failed' as const, displayInstruction: '事实核查', startedAt: '2026-10-02T07:00:00.000Z',
    completedAt: '2026-10-02T07:00:10.000Z', stopReason: 'STOPPED', modelRequests: 1, maxModelRequests: 24, toolCalls: 1, maxToolCalls: 32,
    totalTokens: null, stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: { segments: [{ id: 'segment-stop', label: '执行段 1', startedAt: '2026-10-02T07:00:00.000Z', modelRequests: [], toolGroups: [], decisions: [] }],
      trace: [{ id: 'tool-stop', segmentId: 'segment-stop', occurredAt: '2026-10-02T07:00:05.000Z', completedAt: null, kind: 'tool' as const,
        status: 'pending' as const, label: '提交事实核查', technicalName: 'submit_fact_check', durationMs: null, errorCode: null }] } satisfies RunDiagnosticsView }]
  const html = renderToStaticMarkup(<RunTrace records={records} />)
  assert.match(html, /提交事实核查.*已停止等待/u)
  assert.match(html, /运行已结束，未记录工具完成结果/u)
  assert.doesNotMatch(html, /等待模型响应|进行中/u)
  assert.doesNotMatch(html, /aria-current="step"|当前活动/u)
})
