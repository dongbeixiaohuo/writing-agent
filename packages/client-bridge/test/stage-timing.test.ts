import assert from 'node:assert/strict'
import test from 'node:test'
import { stageActiveDurations } from '../src/stage-timing.js'

test('stage timing keeps completed research separate and accumulates outline retries across user waits', () => {
  const event = (type: string, operationId: string, seconds: number, payload: Record<string, unknown> = {}) => ({
    type, operationId, runId: 'run', occurredAt: new Date(seconds * 1000).toISOString(), payload,
  })
  const durations = stageActiveDurations([
    event('request.dispatch_attempted', 'research', 0, { actor: 'research' }),
    event('request.completed', 'research', 268),
    event('request.dispatch_attempted', 'outline', 320, { actor: 'outline' }),
    event('request.outcome_unknown', 'outline', 340),
    event('run.waiting_user', 'pause', 340),
    event('run.resumed', 'resume', 1000),
    event('request.dispatch_attempted', 'retry', 1002, { actor: 'outline' }),
    event('request.completed', 'retry', 1042),
    event('tool.requested', 'save', 1042, { actor: 'outline', toolName: 'submit_writing_stage', arguments: { stage: 'outline' } }),
    event('tool.completed', 'save', 1043),
  ], 'run')
  assert.equal(durations.get('research'), 268000)
  assert.equal(durations.get('outline'), 61000)
  assert.equal(durations.has('draft'), false)
})

test('overlapping requests and tools count once and unterminated legacy requests never count resume gaps', () => {
  const event = (type: string, operationId: string, seconds: number) => ({ type, operationId, runId: 'r',
    occurredAt: new Date(seconds * 1000).toISOString(), payload: { actor: 'fact_check' } })
  const durations = stageActiveDurations([
    event('request.dispatch_attempted', 'model', 0), event('tool.requested', 'tool', 5),
    event('tool.completed', 'tool', 15), event('request.completed', 'model', 20),
    event('request.dispatch_attempted', 'legacy', 21), event('run.resumed', 'resume', 200),
    event('request.completed', 'legacy', 210),
  ], 'r')
  assert.equal(durations.get('fact_check'), 20000)
})

test('title planning has its own persisted activity duration', () => {
  const event = (type: string, seconds: number) => ({ type, operationId: 'title-model', runId: 'r',
    occurredAt: new Date(seconds * 1000).toISOString(), payload: { actor: 'title' } })
  assert.equal(stageActiveDurations([event('request.dispatch_attempted', 5), event('request.completed', 30)], 'r').get('title'), 25000)
})
