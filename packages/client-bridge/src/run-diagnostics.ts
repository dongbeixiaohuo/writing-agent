import type { WritingProjectProjection } from '../../application/src/index.js'
import type { RunRecord } from '../../runtime/session/src/index.js'
import type { DiagnosticOperationStatus, RecoverableRunSummary, RunDiagnosticDecision, RunDiagnosticModelRequest, RunDiagnosticToolGroup, RunDiagnosticToolTarget, RunDiagnosticTraceStep, RunDiagnosticsView } from './protocol.js'
import { recordedActorLabel, toolPresentation } from './tool-presentation.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u
const SECRET_OR_PATH = /(?:api[_-]?key|authorization|bearer\s|(?:sk|tvly)-[A-Za-z0-9]|[A-Za-z]:\\|\\\\|\/(?:Users|home|etc|private|tmp|var)\/|[?&](?:key|token|secret)=)/iu
const PRIVATE_PLACEHOLDER = /\b(?:private|secret)\b/iu
const TRACE_PREVIEW_CHARS = 180

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ID.test(value) && !SECRET_OR_PATH.test(value) ? value : null
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null
}

function safeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/gu, ' ').trim()
  return text && text.length <= 240 && !SECRET_OR_PATH.test(text) && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null
}

function safePreview(value: unknown, stripReasoning = false): string | null {
  if (typeof value !== 'string') return null
  let text = value
  if (stripReasoning) {
    text = text.replace(/<(?:think|thinking|analysis|reasoning)>[\s\S]*?<\/(?:think|thinking|analysis|reasoning)>/giu, ' ')
      .replace(/<(?:think|thinking|analysis|reasoning)>[\s\S]*$/giu, ' ')
  }
  text = text.replace(/\s+/gu, ' ').trim()
  if (!text) return null
  const characters = Array.from(text)
  const preview = characters.length > TRACE_PREVIEW_CHARS
    ? `${characters.slice(0, TRACE_PREVIEW_CHARS).join('').trimEnd()}…`
    : text
  return SECRET_OR_PATH.test(preview) || PRIVATE_PLACEHOLDER.test(preview) || /[\u0000-\u001f\u007f]/u.test(preview) ? null : preview
}

function safeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/gu, '\n').trim()
  if (!text) return null
  if (SECRET_OR_PATH.test(text)) return '任务说明含敏感信息，已隐藏'
  const cleaned = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, ' ')
  return cleaned.length > 2000 ? `${cleaned.slice(0, 2000)}…（说明已截断）` : cleaned
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function transportTiming(value: unknown): RunDiagnosticModelRequest['transport'] {
  const v = object(value)
  if (!v || !['first_response', 'stream_idle'].includes(String(v.phase)) || count(v.timeoutMs) === null || count(v.elapsedMs) === null) return undefined
  return { phase: v.phase as 'first_response' | 'stream_idle', timeoutMs: v.timeoutMs as number, elapsedMs: v.elapsedMs as number,
    firstResponseMs: count(v.firstResponseMs), lastActivityMs: count(v.lastActivityMs) }
}

function errorCode(payload: Readonly<Record<string, unknown>>): string | null {
  return safeCode(object(payload.error)?.code) ?? safeCode(object(object(payload.result)?.error)?.code) ?? safeCode(payload.code)
}

function duration(start: string, end: string): number | null {
  const elapsed = Date.parse(end) - Date.parse(start)
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null
}

function safeHttpsHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.hostname : null
  } catch { return null }
}

function safeSourceHosts(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const hosts = new Set<string>()
  for (const match of value.replace(/\\\//gu, '/').matchAll(/https:\/\/[^\s"<>\\]+/gu)) {
    const host = safeHttpsHost(match[0])
    if (host) hosts.add(host)
    if (hosts.size === 3) break
  }
  return [...hosts]
}

interface MutableRequest extends RunDiagnosticModelRequest {
  order: number
  startedAt: string
  completedAt: string | null
  segmentId: string
  requestId: string | null
  actorLabel: string | null
  terminalToolCallIds: string[]
  toolNames: string[]
  inputPreview: string
  outputPreview: string | null
}
interface MutableTool {
  order: number
  id: string
  segmentId: string
  toolName: string
  caller: string
  outcome: string | null
  status: DiagnosticOperationStatus
  errorCode: string | null
  targetId: string | null
  versionId: string | null
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  inputPreview: string | null
  outputPreview: string | null
}
interface MutableSegment {
  id: string
  label: string
  startedAt: string
  modelRequests: MutableRequest[]
  tools: MutableTool[]
  decisions: RunDiagnosticDecision[]
}

function safeInputDetail(args: Readonly<Record<string, unknown>>): string | null {
  for (const [key, label] of [['summary', '摘要'], ['instruction', '指令'], ['reason', '任务'], ['target', '目标'], ['reply', '回复']] as const) {
    const value = safePreview(args[key])
    if (value) return `${label}：${value}`
  }
  return null
}

function safeFailureMessage(payload: Readonly<Record<string, unknown>>): string | null {
  const envelope = object(payload.result)
  return safePreview(object(payload.error)?.message) ?? safePreview(object(envelope?.error)?.message)
}

function safeToolInput(toolName: string, args: Readonly<Record<string, unknown>> | null, projection: WritingProjectProjection): string | null {
  if (args === null) return null
  const stage = safeId(args.stage)
  if (toolName === 'search_fact_sources') {
    const query = safePreview(args.query)
    return query ? `查询：${query}` : '搜索公开事实（具体查询已隐藏）'
  }
  if (toolName === 'read_fact_source') {
    const host = safeHttpsHost(args.url)
    return host ? `来源域名：${host}` : '读取本轮已授权的事实来源'
  }
  if (toolName === 'read_material') {
    const id = safeId(args.materialId)
    const label = id ? safeDescription(projection.materials.find(item => item.id === id)?.displayName) ?? id : null
    const version = safeId(args.contentVersionId)
    return label ? `材料：${label}${version ? ` · 版本 ${version.slice(0, 8)}` : ''}` : '读取指定材料'
  }
  if (toolName === 'read_artifact_version') {
    const version = safeId(args.versionId)
    return version ? `稿件版本：${version.slice(0, 12)}` : '读取指定稿件版本'
  }
  const detail = safeInputDetail(args)
  if (toolName === 'submit_writing_stage') return [stage ? `保存阶段：${stage}` : '保存当前写作阶段', detail].filter(Boolean).join(' · ')
  if (toolName === 'submit_fact_check') return '提交绑定当前稿件的事实核查结果'
  if (toolName === 'director_decide') {
    const action = safeId(args.action)
    return [action ? `动作：${action}` : null, stage ? `阶段：${stage}` : null, detail].filter(Boolean).join(' · ') || '安排下一步写作任务'
  }
  if (toolName === 'submit_publication_candidates' || toolName === 'propose_publication_choices') return '保存标题与发布候选（正文内容不在运行记录中展开）'
  if (toolName.startsWith('respond_')) return detail ?? '保存本轮交流结果（正文内容不在运行记录中展开）'
  return [stage ? `阶段：${stage}` : null, detail].filter(Boolean).join(' · ') || null
}

function safeToolOutput(toolName: string, payload: Readonly<Record<string, unknown>>, status: DiagnosticOperationStatus): string | null {
  if (status === 'failed') {
    const code = errorCode(payload)
    const message = safeFailureMessage(payload)
    return `执行失败${code ? `：${code}` : ''}${message ? ` · ${message}` : ''}`
  }
  if (status === 'outcome_unknown') return '已发出请求，但无法确认外部结果'
  if (status !== 'completed') return null
  const envelope = object(payload.result)
  const result = envelope?.ok === true ? object(envelope.result) : null
  if (toolName === 'search_fact_sources') {
    const provider = result?.provider === 'parallel' ? 'Parallel' : result?.provider === 'tavily' ? 'Tavily' : null
    const mode = result?.mode === 'external' ? `${provider ?? '外部'} 搜索已返回` : result?.mode === 'unavailable' ? '搜索不可用' : '仅模型复核，未联网搜索'
    const hosts = safeSourceHosts(result?.evidenceText)
    const failure = safeCode(result?.failureCode)
    const evidence = safePreview(result?.evidenceText)
    const notice = safePreview(result?.notice)
    return `${mode}${hosts.length ? ` · 来源域名（未核实）：${hosts.join('、')}` : ''}${failure ? ` · ${failure}` : ''}${evidence ? ` · 证据：${evidence}` : ''}${notice ? ` · 说明：${notice}` : ''}`
  }
  if (toolName === 'read_material') return '已读取指定材料版本'
  if (toolName === 'read_artifact_version') return '已读取指定稿件版本'
  if (toolName === 'read_fact_source') {
    const host = safeHttpsHost(result?.finalUrl)
    const contentType = typeof result?.contentType === 'string' && /^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/iu.test(result.contentType) ? result.contentType.split(';')[0] : null
    const redirects = count(result?.redirectCount)
    return `已读取授权来源原文${host ? ` · ${host}` : ''}${contentType ? ` · ${contentType}` : ''}${redirects ? ` · 重定向 ${redirects} 次` : ''}`
  }
  if (toolName === 'director_decide') {
    const collaboration = object(result?.collaboration)
    const role = recordedActorLabel(collaboration?.actor) ?? safeId(collaboration?.actor)
    const action = safeId(collaboration?.status)
    const stage = safeId(collaboration?.stage)
    return [role ? `交给${role}` : null, action, stage ? `阶段 ${stage}` : null].filter(Boolean).join(' · ') || '已保存导演调度决定'
  }
  const reply = safePreview(result?.reply)
  if (reply) return `回复：${reply}`
  const artifactVersionId = safeId(result?.artifactVersionId)
  if (toolName.startsWith('submit_') || toolName.startsWith('respond_') || toolName.startsWith('propose_')) {
    return artifactVersionId ? `已保存 · 版本 ${artifactVersionId.slice(0, 12)}` : '已保存'
  }
  for (const [key, label] of [['summary', '摘要'], ['message', '结果'], ['notice', '说明'], ['reason', '原因'], ['evidenceText', '证据'], ['status', '状态']] as const) {
    const value = safePreview(result?.[key])
    if (value) return `${label}：${value}`
  }
  if (!['read_material', 'read_artifact_version'].includes(toolName)) {
    const content = safePreview(result?.content)
    if (content) return `结果：${content}`
  }
  return '工具执行完成'
}

function modelLabel(status: DiagnosticOperationStatus): string {
  if (status === 'pending') return '等待模型响应'
  if (status === 'completed') return '模型响应'
  if (status === 'failed') return '模型请求失败'
  return '模型结果未知'
}

function toolCallOutput(toolNames: readonly string[]): string {
  return `调用工具：${safePreview(toolNames.join('、')) ?? `已记录 ${toolNames.length} 个工具`}`
}

function modelOutput(payload: Readonly<Record<string, unknown>>, status: DiagnosticOperationStatus, toolNames: readonly string[] = []): string | null {
  if (status === 'failed') return errorCode(payload) ? `请求失败：${errorCode(payload)}` : '请求失败'
  if (status === 'outcome_unknown') return '客户端已停止等待，结果尚无法确认'
  if (status !== 'completed') return null
  const response = safePreview(payload.responseText, true)
  if (response) return response
  const calls = Array.isArray(payload.toolCallIds) ? payload.toolCallIds.length : 0
  if (calls > 0 && toolNames.length > 0) return toolCallOutput(toolNames)
  if (calls > 0) return `返回 ${calls} 个工具调用`
  return payload.finishReason === 'stop' ? '模型已完成文本响应' : '模型响应已完成'
}

function toolStatus(event: { type: string }): DiagnosticOperationStatus | null {
  if (!event.type.startsWith('request.') && !event.type.startsWith('tool.')) return null
  if (event.type.endsWith('.completed')) return 'completed'
  if (event.type.endsWith('.failed')) return 'failed'
  if (event.type.endsWith('.outcome_unknown')) return 'outcome_unknown'
  return null
}

function toolGroups(tools: readonly MutableTool[], projection: WritingProjectProjection): RunDiagnosticToolGroup[] {
  const groups = new Map<string, MutableTool[]>()
  for (const tool of tools) groups.set(tool.toolName, [...(groups.get(tool.toolName) ?? []), tool])
  return [...groups].map(([toolName, attempts]) => {
    const statuses = (items: readonly MutableTool[]) => ({
      count: items.length,
      completed: items.filter(item => item.status === 'completed').length,
      failed: items.filter(item => item.status === 'failed').length,
      pending: items.filter(item => item.status === 'pending').length,
      outcomeUnknown: items.filter(item => item.status === 'outcome_unknown').length,
    })
    let targets: RunDiagnosticToolTarget[] | undefined
    if (toolName === 'read_material' || toolName === 'read_artifact_version') {
      const byTarget = new Map<string, MutableTool[]>()
      for (const attempt of attempts) {
        const key = JSON.stringify([attempt.targetId, attempt.versionId])
        byTarget.set(key, [...(byTarget.get(key) ?? []), attempt])
      }
      targets = [...byTarget.values()].map(reads => {
        const id = reads[0]?.targetId ?? '未记录 ID'
        const material = projection.materials.find(item => item.id === id)
        const displayName = safeDescription(material?.displayName)
        return { id, label: displayName ?? id, versionId: reads[0]?.versionId ?? null, ...statuses(reads),
          errorCodes: [...new Set(reads.map(item => item.errorCode).filter((value): value is string => value !== null))] }
      })
    }
    const counts = (values: readonly string[]) => [...new Set(values)].map(label => ({ label, count: values.filter(value => value === label).length }))
    return { toolName, ...toolPresentation(toolName), ...statuses(attempts),
      callers: counts(attempts.map(item => item.caller)),
      outcomes: counts(attempts.flatMap(item => item.outcome ? [item.outcome] : [])),
      errorCodes: [...new Set(attempts.map(item => item.errorCode).filter((value): value is string => value !== null))],
      ...(targets === undefined ? {} : { targets }) }
  })
}

/** Only unresolved operations from this execution segment describe the current pause. */
export function recoveryInterruption(projection: WritingProjectProjection, run: RunRecord): RecoverableRunSummary['interruption'] {
  if (run.stopReason !== 'UNKNOWN_EXTERNAL_OUTCOME') return undefined
  const unknown = new Map<string, NonNullable<RecoverableRunSummary['interruption']>>()
  let replyAccepted = false
  for (const event of projection.events) {
    if (event.runId !== run.id) continue
    if (event.type === 'run.resumed') {
      unknown.clear()
      replyAccepted = typeof event.payload.displayInstruction === 'string' && event.payload.displayInstruction.trim().length > 0
    } else if (event.type === 'request.outcome_unknown' || event.type === 'tool.outcome_unknown') {
      const transport = event.type === 'request.outcome_unknown' ? transportTiming(event.payload.transport) : undefined
      unknown.set(event.operationId, { source: event.type.startsWith('request.') ? 'model' : 'tool',
        cause: errorCode(event.payload) === 'TIMEOUT' ? 'timeout' : 'unknown', replyAccepted,
        ...(transport ? { timeoutPhase: transport.phase, timeoutMs: transport.timeoutMs } : {}) })
    } else if (toolStatus(event) === 'completed' || toolStatus(event) === 'failed') {
      unknown.delete(event.operationId)
    }
  }
  const pending = [...unknown.values()]
  // A possible external write must not inherit the less alarming model-only copy.
  return pending.find(item => item.source === 'tool') ?? pending.at(-1)
}

export function runDiagnostics(projection: WritingProjectProjection, run: RunRecord): RunDiagnosticsView {
  const segments: MutableSegment[] = []
  const modelOperations = new Map<string, MutableRequest>()
  const modelsByRequestId = new Map<string, MutableRequest[]>()
  const toolOperations = new Map<string, MutableTool>()
  const purpose = projection.events.find(event => event.runId === run.id && event.type === 'run.started')?.payload.purpose
  let current: MutableSegment | undefined
  let eventOrder = 0
  for (const event of projection.events) {
    if (event.runId !== run.id) continue
    const order = eventOrder++
    if (event.type === 'run.started' || event.type === 'run.resumed' || current === undefined) {
      if (event.type === 'run.started' || event.type === 'run.resumed') {
        current = { id: event.id, label: `执行段 ${segments.length + 1}${event.type === 'run.resumed' ? ' · 恢复后' : ''}`,
          startedAt: event.occurredAt, modelRequests: [], tools: [], decisions: [] }
        segments.push(current)
        continue
      }
      current = { id: `${run.id}:legacy`, label: '执行段 1', startedAt: run.startedAt,
        modelRequests: [], tools: [], decisions: [] }
      segments.push(current)
    }
    if (event.type === 'request.dispatch_attempted') {
      const requestId = safeId(event.payload.requestId)
      const attempt = count(event.payload.attemptIndex)
      const recoveryAttempt = count(event.payload.outputRecoveryAttempt)
      const retries = attempt === null && recoveryAttempt === null ? null : (attempt ?? 0) + (recoveryAttempt ?? 0)
      const segmentOrdinal = current.modelRequests.length + 1
      const request: MutableRequest = { id: event.id, order, startedAt: event.occurredAt, completedAt: null, segmentId: current.id,
        requestId, actorLabel: recordedActorLabel(event.payload.actor),
        terminalToolCallIds: [], toolNames: [],
        inputPreview: `本执行段第 ${segmentOrdinal} 次模型请求${retries === null ? '' : retries === 0 ? ' · 首次尝试' : ` · 第 ${retries + 1} 次尝试（已重试 ${retries} 次）`}`,
        outputPreview: null, status: 'pending', durationMs: null, errorCode: null, usage: null }
      current.modelRequests.push(request)
      modelOperations.set(event.operationId, request)
      if (requestId) modelsByRequestId.set(requestId, [...(modelsByRequestId.get(requestId) ?? []), request])
      continue
    }
    if (event.type === 'tool.requested') {
      const args = object(event.payload.arguments)
      const toolName = safeId(event.payload.toolName) ?? 'unknown'
      const recordedCaller = recordedActorLabel(event.payload.actor)
      const caller = recordedCaller ?? (event.payload.actor === undefined && purpose === 'writing-pack:intake' ? '需求澄清助手（按运行类型）' : '未记录调用者')
      const requestId = safeId(event.payload.requestId)
      const callId = typeof event.payload.callId === 'string' ? event.payload.callId : null
      const requests = requestId ? modelsByRequestId.get(requestId) ?? [] : []
      const matchedRequest = (callId ? requests.findLast(request => request.terminalToolCallIds.includes(callId)) : undefined)
        ?? requests.findLast(request => request.status === 'completed')
      if (matchedRequest) {
        const request = matchedRequest
        request.actorLabel ??= recordedCaller
        if (!request.toolNames.includes(toolName)) request.toolNames.push(toolName)
        if (/^(?:返回 \d+ 个工具调用|调用工具：)/u.test(request.outputPreview ?? '')) request.outputPreview = toolCallOutput(request.toolNames)
      }
      const tool: MutableTool = { id: event.id, order, segmentId: current.id, toolName, status: 'pending', errorCode: null, outcome: null, caller,
        targetId: toolName === 'read_artifact_version' ? safeId(args?.versionId) : safeId(args?.materialId),
        versionId: toolName === 'read_material' ? safeId(args?.contentVersionId) : null,
        startedAt: event.occurredAt, completedAt: null, durationMs: null,
        inputPreview: safeToolInput(toolName, args, projection), outputPreview: null }
      current.tools.push(tool)
      toolOperations.set(event.operationId, tool)
      continue
    }
    const status = toolStatus(event)
    if (status === null) continue
    if (event.type.startsWith('request.')) {
      const request = modelOperations.get(event.operationId)
      if (!request) continue
      request.status = status
      request.durationMs = duration(request.startedAt, event.occurredAt)
      request.completedAt = event.occurredAt
      request.errorCode = status === 'completed' ? null : errorCode(event.payload)
      request.terminalToolCallIds = status === 'completed' && Array.isArray(event.payload.toolCallIds)
        ? event.payload.toolCallIds.filter((value): value is string => typeof value === 'string') : []
      request.outputPreview = modelOutput(event.payload, status, request.toolNames)
      const transport = transportTiming(event.payload.transport)
      if (transport) request.transport = transport
      const stream = object(event.payload.stream)
      if (stream) request.stream = { headersMs: count(stream.headersMs), firstContentMs: count(stream.firstContentMs), lastContentMs: count(stream.lastContentMs), contentEvents: count(stream.contentEvents) ?? 0 }
      const httpStatus = count(event.payload.providerHttpStatus)
      if (httpStatus !== null && httpStatus >= 100 && httpStatus <= 599) request.providerHttpStatus = httpStatus
      const usage = object(event.payload.usage)
      request.usage = usage === null ? null : { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), totalTokens: count(usage.totalTokens) }
      continue
    }
    const tool = toolOperations.get(event.operationId)
    if (tool) {
      tool.status = status
      tool.completedAt = event.occurredAt
      tool.durationMs = duration(tool.startedAt, event.occurredAt)
      tool.errorCode = status === 'completed' ? null : errorCode(event.payload)
      tool.outputPreview = safeToolOutput(tool.toolName, event.payload, status)
      tool.outcome = null
      const envelope = object(event.payload.result)
      const result = status === 'completed' && envelope?.ok === true ? object(envelope.result) : null
      if (result && ['respond_writing_intake', 'submit_writing_proposal'].includes(tool.toolName)) {
        tool.outcome = result.phase === 'collecting' ? '交流已保存，仍在讨论需求'
          : result.phase === 'proposal' ? '已保存待确认方案，尚未确认'
          : result.phase === 'confirmed' ? '已保存需求确认结果' : null
      }
      if (tool.toolName === 'director_decide' && status === 'completed') {
        const envelope = object(event.payload.result)
        const result = envelope?.ok === true ? object(envelope.result) : null
        const decision = object(result?.collaboration)
        if (decision) current.decisions.push({ id: event.id, actor: safeId(decision.actor), stage: safeId(decision.stage),
          status: safeId(decision.status), reason: safeReason(decision.reason) })
      }
    }
  }
  const orderedTrace: Array<RunDiagnosticTraceStep & { order: number }> = segments.flatMap(segment => [
    ...segment.modelRequests.map(request => ({ id: request.id, order: request.order, segmentId: request.segmentId, occurredAt: request.startedAt,
      completedAt: request.completedAt, kind: 'model' as const, status: request.status, label: modelLabel(request.status),
      ...(request.requestId ? { requestId: request.requestId } : {}), ...(request.actorLabel ? { actorLabel: request.actorLabel } : {}),
      durationMs: request.durationMs, inputPreview: request.inputPreview, ...(request.outputPreview ? { outputPreview: request.outputPreview } : {}),
      errorCode: request.errorCode, ...(request.stream ? { stream: request.stream } : {}),
      ...(request.transport ? { transport: request.transport } : {}), ...(request.providerHttpStatus ? { providerHttpStatus: request.providerHttpStatus } : {}) })),
    ...segment.tools.map(tool => ({ id: tool.id, order: tool.order, segmentId: tool.segmentId, occurredAt: tool.startedAt, completedAt: tool.completedAt,
      kind: tool.toolName === 'director_decide' || tool.toolName === 'delegate_author_expert' ? 'agent' as const : 'tool' as const,
      status: tool.status, label: toolPresentation(tool.toolName).label, technicalName: tool.toolName,
      ...(tool.caller !== '未记录调用者' ? { actorLabel: tool.caller } : {}), durationMs: tool.durationMs,
      ...(tool.inputPreview ? { inputPreview: tool.inputPreview } : {}), ...(tool.outputPreview ? { outputPreview: tool.outputPreview } : {}), errorCode: tool.errorCode })),
  ]).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.order - right.order)
  const trace = orderedTrace.map(({ order: _order, ...step }) => step)
  return { segments: segments.map(segment => ({ id: segment.id, label: segment.label, startedAt: segment.startedAt,
    modelRequests: segment.modelRequests.map(({ order: _order, startedAt: _startedAt, completedAt: _completedAt, segmentId: _segmentId,
      requestId: _requestId, actorLabel: _actorLabel, terminalToolCallIds: _terminalToolCallIds, toolNames: _toolNames,
      inputPreview: _inputPreview, outputPreview: _outputPreview, ...request }) => request),
    toolGroups: toolGroups(segment.tools, projection), decisions: segment.decisions })), trace }
}
