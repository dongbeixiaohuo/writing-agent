import assert from 'node:assert/strict'
import test from 'node:test'
import type { WritingProjectProjection } from '../../application/src/index.js'
import type { RunRecord } from '../../runtime/session/src/index.js'
import { runDiagnostics } from '../src/run-diagnostics.js'

const run = {
  id: 'run', sessionId: 'session', projectId: 'project', status: 'completed', planVersion: 'test',
  budget: {}, usage: {}, lastCommittedEventSeq: 3, stopReason: null,
  createdAt: '2026-10-03T00:00:00.000Z', startedAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:00:03.000Z',
} as unknown as RunRecord

function projection(events: Array<{ type: string; operationId: string; payload: Record<string, unknown> }>): WritingProjectProjection {
  return {
    materials: [],
    events: events.map((event, index) => ({
      id: `event-${index}`, runId: 'run', occurredAt: `2026-10-03T00:00:0${index}.000Z`, ...event,
    })),
  } as unknown as WritingProjectProjection
}

test('model trace shows a bounded assistant reply without private reasoning', () => {
  const visible = `已根据材料归纳三个核心观点：${'论点、证据与结论形成完整闭环。'.repeat(20)}`
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'request.dispatch_attempted', operationId: 'model', payload: { requestId: 'request-1' } },
    { type: 'request.completed', operationId: 'model', payload: {
      finishReason: 'stop', responseText: `<think>private chain of thought api_key=do-not-show</think>${visible}`,
    } },
  ]), run)

  const summary = result.trace?.find(step => step.kind === 'model')?.outputPreview ?? ''
  assert.match(summary, /^已根据材料归纳三个核心观点/u)
  assert.ok(summary.length <= 181, `summary length was ${summary.length}`)
  assert.doesNotMatch(summary, /private|api_key|do-not-show|chain of thought|<think>/iu)
})

test('model trace hides standalone search credentials in response summaries', () => {
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'request.dispatch_attempted', operationId: 'model', payload: { requestId: 'request-secret' } },
    { type: 'request.completed', operationId: 'model', payload: {
      requestId: 'request-secret', finishReason: 'stop', responseText: '搜索返回了凭据 tvly-SYNTHETIC12345DO_NOT_EXPOSE，请继续。',
    } },
  ]), run)

  assert.doesNotMatch(JSON.stringify(result.trace), /tvly-|SYNTHETIC12345DO_NOT_EXPOSE/u)
})

test('model trace resolves tool call ids to persisted tool names by request id', () => {
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'request.dispatch_attempted', operationId: 'model', payload: { requestId: 'request-1' } },
    { type: 'request.completed', operationId: 'model', payload: {
      requestId: 'request-1', finishReason: 'tool_calls', toolCallIds: ['call-1', 'call-2'], responseText: '',
    } },
    { type: 'tool.requested', operationId: 'search', payload: {
      requestId: 'request-1', toolName: 'search_fact_sources', arguments: { query: '企业 AI 落地案例' },
    } },
    { type: 'tool.requested', operationId: 'read', payload: {
      requestId: 'request-1', toolName: 'read_fact_source', arguments: { url: 'https://example.com/report' },
    } },
  ]), run)

  const summary = result.trace?.find(step => step.kind === 'model')?.outputPreview ?? ''
  assert.match(summary, /调用工具：search_fact_sources、read_fact_source/u)
  assert.doesNotMatch(summary, /call-1|call-2/u)
})

test('model tool-name summary stays bounded when one response requests many tools', () => {
  const names = Array.from({ length: 20 }, (_, index) => `tool_${index}_${'x'.repeat(20)}`)
  const events: Array<{ type: string; operationId: string; payload: Record<string, unknown> }> = [
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'request.dispatch_attempted', operationId: 'model', payload: { requestId: 'request-many' } },
    { type: 'request.completed', operationId: 'model', payload: {
      requestId: 'request-many', finishReason: 'tool_calls', toolCallIds: names.map((_, index) => `call-${index}`), responseText: '',
    } },
    ...names.map((toolName, index) => ({
      type: 'tool.requested', operationId: `tool-${index}`, payload: { requestId: 'request-many', toolName, arguments: {} },
    })),
  ]
  const summary = runDiagnostics(projection(events), run).trace?.find(step => step.kind === 'model')?.outputPreview ?? ''
  assert.match(summary, /^调用工具：tool_0_/u)
  assert.ok(summary.length <= 190, `summary length was ${summary.length}`)
})

test('retried requests sharing a request id do not attach later tools to the failed attempt', () => {
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'request.dispatch_attempted', operationId: 'first', payload: { requestId: 'request-reused' } },
    { type: 'request.failed', operationId: 'first', payload: { error: { code: 'MODEL_OUTPUT_TRUNCATED' } } },
    { type: 'request.dispatch_attempted', operationId: 'second', payload: { requestId: 'request-reused' } },
    { type: 'request.completed', operationId: 'second', payload: {
      requestId: 'request-reused', finishReason: 'tool_calls', toolCallIds: ['call-success'], responseText: '',
    } },
    { type: 'tool.requested', operationId: 'search', payload: {
      requestId: 'request-reused', callId: 'call-success', actor: 'director',
      toolName: 'search_fact_sources', arguments: { query: '重试成功后的查询' },
    } },
  ]), run)

  const models = (result.trace ?? []).filter(step => step.kind === 'model')
  const failed = models.find(step => step.status === 'failed')
  const completed = models.find(step => step.status === 'completed')
  assert.doesNotMatch(failed?.outputPreview ?? '', /search_fact_sources/u)
  assert.equal(failed?.actorLabel, undefined)
  assert.match(completed?.outputPreview ?? '', /调用工具：search_fact_sources/u)
  assert.equal(completed?.actorLabel, '写作导演')
})

test('tool trace summarizes persisted inputs, replies, evidence, sources, and failures safely', () => {
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:draft' } },
    { type: 'tool.requested', operationId: 'search', payload: {
      toolName: 'search_fact_sources', arguments: { query: '中小企业 AI 落地成功率' },
    } },
    { type: 'tool.completed', operationId: 'search', payload: { result: {
      ok: true, toolName: 'search_fact_sources', result: {
        mode: 'external', provider: 'parallel',
        evidenceText: '[{"url":"https://research.example/report","excerpt":"样本调查显示，先改造流程再接入模型的项目成功率更高。"}]',
      },
    } } },
    { type: 'tool.requested', operationId: 'reply', payload: {
      toolName: 'respond_author', arguments: { summary: '已完成资料核对，建议先确认文章角度。' },
    } },
    { type: 'tool.completed', operationId: 'reply', payload: { result: {
      ok: true, toolName: 'respond_author', result: { reply: '我已完成资料核对，接下来可以一起确认提纲。', artifactVersionId: 'reply-1' },
    } } },
    { type: 'tool.requested', operationId: 'failed', payload: {
      toolName: 'read_fact_source', arguments: { url: 'https://blocked.example/report' },
    } },
    { type: 'tool.failed', operationId: 'failed', payload: {
      error: { code: 'SOURCE_BLOCKED', message: '来源站点拒绝了本次读取' },
    } },
    { type: 'tool.requested', operationId: 'content', payload: {
      toolName: 'summarize_source', arguments: { instruction: '只提取可验证的结论' },
    } },
    { type: 'tool.completed', operationId: 'content', payload: { result: {
      ok: true, toolName: 'summarize_source', result: { content: '可验证结论：该报告的样本量为 120 家企业。' },
    } } },
    { type: 'tool.requested', operationId: 'secret', payload: {
      toolName: 'respond_author', arguments: { instruction: 'api_key=do-not-show C:\\Users\\Dante\\secret.txt' },
    } },
  ]), run)

  const trace = result.trace ?? []
  const search = trace.find(step => step.technicalName === 'search_fact_sources')
  assert.match(search?.inputPreview ?? '', /中小企业 AI 落地成功率/u)
  assert.match(search?.outputPreview ?? '', /research\.example.*先改造流程再接入模型/u)
  const reply = trace.find(step => step.technicalName === 'respond_author' && step.status === 'completed')
  assert.match(reply?.inputPreview ?? '', /已完成资料核对/u)
  assert.match(reply?.outputPreview ?? '', /接下来可以一起确认提纲/u)
  const failed = trace.find(step => step.status === 'failed')
  assert.match(failed?.outputPreview ?? '', /SOURCE_BLOCKED.*来源站点拒绝了本次读取/u)
  const content = trace.find(step => step.technicalName === 'summarize_source')
  assert.match(content?.inputPreview ?? '', /只提取可验证的结论/u)
  assert.match(content?.outputPreview ?? '', /样本量为 120 家企业/u)
  assert.doesNotMatch(JSON.stringify(trace), /do-not-show|Dante|secret\.txt/u)
})
