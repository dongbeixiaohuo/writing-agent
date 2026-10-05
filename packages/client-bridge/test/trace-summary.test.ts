import assert from 'node:assert/strict'
import test from 'node:test'
import type { WritingProjectProjection } from '../../application/src/index.js'
import type { RunRecord } from '../../runtime/session/src/index.js'
import { runDiagnostics } from '../src/run-diagnostics.js'
import { explainRunFailure } from '../src/run-failure-explanation.js'

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

test('source HTTP failures retain structured status through the trace and UI explanation, including public HTTP hosts', () => {
  for (const httpStatus of [403, 404, 429, 503]) {
    const step = runDiagnostics(projection([
      { type: 'run.started', operationId: 'start', payload: {} },
      { type: 'tool.requested', operationId: 'read', payload: { toolName: 'read_fact_source', arguments: { url: 'http://example.com/article' } } },
      { type: 'tool.failed', operationId: 'read', payload: { result: { ok: false, toolName: 'read_fact_source', error: { code: 'WEB_HTTP_STATUS_REJECTED', details: { httpStatus } } } } },
    ]), run).trace!.find(s => s.kind === 'tool')!;
    assert.equal(step.httpStatus, httpStatus);
    assert.match(step.inputPreview!, /example.com/);
    assert.match(step.outputPreview!, new RegExp(`HTTP ${httpStatus}`));
    assert.doesNotMatch(step.outputPreview!, /未保存.*状态|未记录具体/);
    assert.match(explainRunFailure(step).title, new RegExp(`HTTP ${httpStatus}`));
    assert.match(explainRunFailure(step).detail, /不是禁止 http/);
  }
});

test('search trace exposes the current provider before completion and fallback attempts afterwards', () => {
  const events = [
    { type: 'run.started', operationId: 'start', payload: {} },
    { type: 'tool.requested', operationId: 'search', payload: { toolName: 'search_fact_sources', arguments: { query: '公开事实' } } },
    { type: 'search.progress', operationId: 'search', payload: { message: 'Tavily 已发出第 1 个 HTTP 请求；本轮检索 1/6。' } },
  ];
  const pending = runDiagnostics(projection(events), run).trace!.find(s => s.kind === 'tool')!;
  assert.equal(pending.status, 'pending');
  assert.match(pending.outputPreview!, /Tavily 已发出/);
  const done = runDiagnostics(projection([...events, { type: 'tool.completed', operationId: 'search', payload: { result: { ok: true, result: {
    mode: 'external', provider: 'tavily', evidenceText: '公开来源 https://example.com', attempts: [
      { provider: 'parallel', status: 'failed', elapsedMs: 8000, httpRequests: 1, errorCode: 'SEARCH_REQUEST_TIMEOUT' },
      { provider: 'tavily', status: 'completed', elapsedMs: 2000, httpRequests: 1 },
    ],
  } } } }]), run).trace!.find(s => s.kind === 'tool')!;
  assert.match(done.outputPreview!, /Parallel.*SEARCH_REQUEST_TIMEOUT/);
  assert.match(done.outputPreview!, /Tavily/);
});

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

test('model trace keeps reasoning activity separate from effective content and preserves missing legacy timing', () => {
  const current = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: {} },
    { type: 'request.dispatch_attempted', operationId: 'current', payload: { requestId: 'request-current' } },
    { type: 'request.completed', operationId: 'current', payload: { stream: {
      headersMs: 25, firstReasoningMs: 1000, lastReasoningMs: 340000, reasoningEvents: 42,
      firstContentMs: 344500, lastContentMs: 344900, contentEvents: 3,
    } } },
  ]), run).trace?.find(step => step.kind === 'model')
  assert.deepEqual(current?.stream, {
    headersMs: 25, firstReasoningMs: 1000, lastReasoningMs: 340000, reasoningEvents: 42,
    firstContentMs: 344500, lastContentMs: 344900, contentEvents: 3,
  })

  const legacy = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: {} },
    { type: 'request.dispatch_attempted', operationId: 'legacy', payload: { requestId: 'request-legacy' } },
    { type: 'request.completed', operationId: 'legacy', payload: { stream: {
      headersMs: 20, firstContentMs: 500, lastContentMs: 900, contentEvents: 2,
    } } },
  ]), run).trace?.find(step => step.kind === 'model')
  assert.equal(Object.hasOwn(legacy?.stream ?? {}, 'reasoningEvents'), false)
  assert.equal(Object.hasOwn(legacy?.stream ?? {}, 'firstReasoningMs'), false)
  assert.equal(Object.hasOwn(legacy?.stream ?? {}, 'lastReasoningMs'), false)
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

test('failure summaries identify the recorded failing layer without guessing an external cause', () => {
  const result = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:fact_check' } },
    { type: 'request.dispatch_attempted', operationId: 'model', payload: { requestId: 'request-timeout' } },
    { type: 'request.failed', operationId: 'model', payload: {
      error: { code: 'TIMEOUT' }, transport: { phase: 'first_response', timeoutMs: 30_000, elapsedMs: 30_001 },
    } },
    { type: 'tool.requested', operationId: 'search', payload: { toolName: 'search_fact_sources', arguments: { query: '公开事实' } } },
    { type: 'tool.failed', operationId: 'search', payload: { error: { code: 'SEARCH_HTTP_429' } } },
    { type: 'tool.requested', operationId: 'source', payload: { toolName: 'read_fact_source', arguments: { url: 'https://example.com/report' } } },
    { type: 'tool.failed', operationId: 'source', payload: { error: { code: 'FACT_SOURCE_NOT_IN_LEDGER' } } },
    { type: 'tool.requested', operationId: 'gate', payload: { toolName: 'submit_fact_check', arguments: {} } },
    { type: 'tool.failed', operationId: 'gate', payload: { error: { code: 'FACT_CHECK_EVIDENCE_REFERENCE_INVALID' } } },
  ]), run).trace ?? []

  const model = result.find(step => step.kind === 'model')!
  assert.match(model.outputPreview ?? '', /模型.*首个有效内容/u)
  assert.doesNotMatch(model.outputPreview ?? '', /搜索服务/u)
  assert.match(result.find(step => step.technicalName === 'search_fact_sources')?.outputPreview ?? '', /公开搜索服务.*失败/u)
  const source = result.find(step => step.technicalName === 'read_fact_source')?.outputPreview ?? ''
  assert.match(source, /未匹配.*来源记录/u)
  assert.match(source, /未发出网络读取/u)
  assert.doesNotMatch(source, /模型编造|网站宕机|搜索服务失败/u)
  assert.match(result.find(step => step.technicalName === 'submit_fact_check')?.outputPreview ?? '', /事实核查提交.*门禁/u)
})

test('model output format failure is distinguished from transport silence', () => {
  const invalid = explainRunFailure({ kind: 'model', status: 'failed', errorCode: 'MODEL_RESPONSE_INVALID' });
  assert.match(invalid.title, /格式/);
  assert.doesNotMatch(invalid.title + invalid.detail, /未.*响应|等待时限|超时/u);
  const timeout = explainRunFailure({ kind: 'model', status: 'failed', errorCode: 'TIMEOUT', transportPhase: 'first_response' });
  assert.match(timeout.title, /未.*返回.*有效内容/u);
  const gate = explainRunFailure({ kind: 'tool', status: 'failed', technicalName: 'submit_writing_stage', errorCode: 'STAGE_OUTPUT_INVALID' });
  assert.match(gate.title + gate.detail, /校验|前置条件/u);
  assert.doesNotMatch(gate.title + gate.detail, /模型未响应/u);
});

test('checkpoint rework gate explains the decision conflict and a usable recovery action', () => {
  const trace = runDiagnostics(projection([
    { type:'run.started', operationId:'start', payload:{} },
    { type:'tool.requested', operationId:'gate', payload:{toolName:'director_decide',arguments:{action:'dispatch',stage:'language_review'}} },
    { type:'tool.failed', operationId:'gate', payload:{error:{code:'CHECKPOINT_REWORK_REQUIRED'}} },
  ]), run).trace ?? [];
  const failed = trace.find(step => step.status === 'failed');
  assert.match(failed?.outputPreview ?? '', /当前决策记录要求先修改/u);
  assert.match(failed?.outputPreview ?? '', /不是模型无响应.*不是搜索故障/u);
});

test('known source policy and search precondition codes keep their precise recorded boundary', () => {
  const failure = (operationId: string, toolName: string, code: string) => [
    { type: 'tool.requested', operationId, payload: { toolName, arguments: {} } },
    { type: 'tool.failed', operationId, payload: { error: { code } } },
  ]
  const trace = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: { purpose: 'writing-pack:fact_check' } },
    ...failure('private', 'read_fact_source', 'NETWORK_PRIVATE_TARGET_DENIED'),
    ...failure('credentials', 'read_fact_source', 'NETWORK_CREDENTIALS_DENIED'),
    ...failure('dns', 'read_fact_source', 'NETWORK_TARGET_UNRESOLVED'),
    ...failure('http', 'read_fact_source', 'WEB_HTTP_STATUS_REJECTED'),
    ...failure('limit', 'search_fact_sources', 'SEARCH_LIMIT_REACHED'),
    ...failure('disabled', 'search_fact_sources', 'FACT_SEARCH_DISABLED'),
  ]), run).trace ?? []
  const output = (id: string) => trace.find(step => step.id === `event-${id}`)?.outputPreview ?? ''
  const requestedIndexes = { private: 1, credentials: 3, dns: 5, http: 7, limit: 9, disabled: 11 }

  assert.match(output(String(requestedIndexes.private)), /本机安全规则.*未发出网络读取/u)
  assert.match(output(String(requestedIndexes.credentials)), /本机安全规则.*未发出网络读取/u)
  assert.match(output(String(requestedIndexes.dns)), /来源域名解析失败/u)
  assert.match(output(String(requestedIndexes.http)), /旧记录.*缺少状态码.*未保存具体 HTTP 状态/u)
  assert.match(output(String(requestedIndexes.limit)), /搜索次数.*上限/u)
  assert.doesNotMatch(output(String(requestedIndexes.limit)), /搜索服务请求失败/u)
  assert.match(output(String(requestedIndexes.disabled)), /外部事实搜索已关闭/u)
  assert.doesNotMatch(output(String(requestedIndexes.disabled)), /搜索服务请求失败/u)
})

test('article trace distinguishes a WeChat verification page from model or search failures', () => {
  const trace = runDiagnostics(projection([
    { type: 'run.started', operationId: 'start', payload: {} },
    { type: 'tool.requested', operationId: 'web', payload: { toolName: 'read_author_web', arguments: { url: 'https://mp.weixin.qq.com/s/example' } } },
    { type: 'tool.failed', operationId: 'web', payload: { error: { code: 'WEB_ARTICLE_ACCESS_RESTRICTED' } } },
    { type: 'tool.requested', operationId: 'read', payload: { toolName: 'read_author_web', arguments: { url: 'https://mp.weixin.qq.com/s/normal' } } },
    { type: 'tool.completed', operationId: 'read', payload: { result: { ok: true, toolName: 'read_author_web', result: {
      title: '测试公众号文章', sourceUrl: 'https://mp.weixin.qq.com/s/normal', totalChars: 3200,
    } } } },
  ]), run).trace ?? [];
  assert.match(trace.find(step => step.status === 'failed')?.inputPreview ?? '', /mp.weixin.qq.com/u);
  const failure = trace.find(step => step.status === 'failed')?.outputPreview ?? '';
  assert.match(failure, /微信.*验证|验证.*微信/u);
  assert.doesNotMatch(failure, /搜索服务请求失败|模型请求未成功/u);
  assert.match(trace.find(step => step.status === 'completed')?.outputPreview ?? '', /测试公众号文章.*3200/u);
});

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
