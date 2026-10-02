import type { WritingProjectProjection } from '../../application/src/index.js'
import type { RunRecord } from '../../runtime/session/src/index.js'
import type { DiagnosticOperationStatus, RecoverableRunSummary, RunDiagnosticDecision, RunDiagnosticModelRequest, RunDiagnosticToolGroup, RunDiagnosticToolTarget, RunDiagnosticsView } from './protocol.js'
import { recordedActorLabel, toolPresentation } from './tool-presentation.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u
const SECRET_OR_PATH = /(?:api[_-]?key|authorization|bearer\s|sk-[A-Za-z0-9]|[A-Za-z]:\\|\\\\|\/(?:Users|home|etc|private|tmp|var)\/|[?&](?:key|token|secret)=)/iu

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

interface MutableRequest extends RunDiagnosticModelRequest { startedAt: string }
interface MutableTool { toolName: string; caller: string; outcome: string | null; status: DiagnosticOperationStatus; errorCode: string | null; targetId: string | null; versionId: string | null }
interface MutableSegment {
  id: string
  label: string
  startedAt: string
  modelRequests: MutableRequest[]
  tools: MutableTool[]
  decisions: RunDiagnosticDecision[]
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
  const toolOperations = new Map<string, MutableTool>()
  const purpose = projection.events.find(event => event.runId === run.id && event.type === 'run.started')?.payload.purpose
  let current: MutableSegment | undefined
  for (const event of projection.events) {
    if (event.runId !== run.id) continue
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
      const request: MutableRequest = { id: event.id, startedAt: event.occurredAt, status: 'pending', durationMs: null, errorCode: null, usage: null }
      current.modelRequests.push(request)
      modelOperations.set(event.operationId, request)
      continue
    }
    if (event.type === 'tool.requested') {
      const args = object(event.payload.arguments)
      const toolName = safeId(event.payload.toolName) ?? 'unknown'
      const tool: MutableTool = { toolName, status: 'pending', errorCode: null, outcome: null,
        caller: recordedActorLabel(event.payload.actor) ?? (event.payload.actor === undefined && purpose === 'writing-pack:intake' ? '需求澄清助手（按运行类型）' : '未记录调用者'),
        targetId: toolName === 'read_artifact_version' ? safeId(args?.versionId) : safeId(args?.materialId),
        versionId: toolName === 'read_material' ? safeId(args?.contentVersionId) : null }
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
      request.errorCode = status === 'completed' ? null : errorCode(event.payload)
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
      tool.errorCode = status === 'completed' ? null : errorCode(event.payload)
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
  return { segments: segments.map(segment => ({ id: segment.id, label: segment.label, startedAt: segment.startedAt,
    modelRequests: segment.modelRequests.map(({ startedAt: _startedAt, ...request }) => request),
    toolGroups: toolGroups(segment.tools, projection), decisions: segment.decisions })) }
}
