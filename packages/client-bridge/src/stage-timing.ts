import type { WritingWorkflowStageId } from './protocol.js'

interface TimingEvent {
  runId?: string
  operationId: string
  type: string
  occurredAt: string
  payload: Readonly<Record<string, unknown>>
}

type TimedStage = WritingWorkflowStageId | 'title'

/** Union recorded activity intervals, never counting checkpoint waits or resume gaps. */
export function stageActiveDurations(events: readonly TimingEvent[], runId: string): Map<TimedStage, number> {
  const stages = new Set<TimedStage>(['research', 'outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review', 'fact_check', 'title'])
  const pending = new Map<string, { stage: TimedStage; start: number }>()
  const intervals = new Map<TimedStage, Array<[number, number]>>()
  const close = (id: string, end: number) => {
    const item = pending.get(id)
    if (item && Number.isFinite(end) && end >= item.start) {
      const list = intervals.get(item.stage) ?? []
      list.push([item.start, end])
      intervals.set(item.stage, list)
    }
    pending.delete(id)
  }
  for (const event of events) {
    if (event.runId !== runId) continue
    const time = Date.parse(event.occurredAt)
    if (event.type === 'request.dispatch_attempted' || event.type === 'tool.requested') {
      const args = event.payload.arguments as Record<string, unknown> | undefined
      const actor = event.payload.actor
      const stage = typeof actor === 'string' && stages.has(actor as TimedStage) ? actor as TimedStage
        : event.payload.toolName === 'submit_fact_check' ? 'fact_check'
        : event.payload.toolName === 'submit_writing_stage' && stages.has(args?.stage as WritingWorkflowStageId) ? args!.stage as WritingWorkflowStageId : null
      if (stage && Number.isFinite(time)) pending.set(event.operationId, { stage, start: time })
    } else if (/^(request|tool)\.(completed|failed|outcome_unknown)$/u.test(event.type)) {
      close(event.operationId, time)
    } else if (/^run\.(paused|waiting_user|failed|interrupted|cancelled|completed|budget_exhausted)$/u.test(event.type)) {
      for (const id of pending.keys()) close(id, time)
    } else if (event.type === 'run.resumed') {
      // Legacy unterminated operations have no reliable end; never include the wait.
      pending.clear()
    }
  }
  const result = new Map<TimedStage, number>()
  for (const [stage, list] of intervals) {
    list.sort((a, b) => a[0] - b[0])
    let total = 0
    let end = -Infinity
    for (const [start, finish] of list) {
      total += Math.max(0, finish - Math.max(start, end))
      end = Math.max(end, finish)
    }
    result.set(stage, total)
  }
  return result
}
