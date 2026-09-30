import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeterministicMockBridge } from '../src/mock-bridge.ts'
import { UI_BRIDGE_PROTOCOL_VERSION } from '../src/protocol.ts'

test('mock handshake is explicit and cannot claim project persistence', async () => {
  const bridge = createDeterministicMockBridge({ latencyMs: 5 })
  const handshake = await bridge.handshake()
  assert.equal(handshake.protocolVersion, UI_BRIDGE_PROTOCOL_VERSION)
  assert.equal(handshake.mock, true)
  assert.equal(handshake.persistsUserProjects, false)
  assert.equal(handshake.runtimeBuild, 'deterministic-mock')
  bridge.dispose()
})

test('session selection rejects cross-project ownership', async () => {
  const bridge = createDeterministicMockBridge()
  await assert.rejects(
    bridge.selectSession('project-case', 'session-launch-draft'),
    /MOCK_SESSION_SCOPE_MISMATCH/,
  )
  bridge.dispose()
})

test('mock project switch clears revision panel state instead of leaking another project', async () => {
  const bridge = createDeterministicMockBridge()
  assert.equal(bridge.getSnapshot().revisionWorkspace.blocks.length, 3)
  assert.equal(bridge.getSnapshot().factCheckWorkspace.status, 'blocked')
  assert.equal(bridge.getSnapshot().factCheckWorkspace.provenance.length, 3)
  assert.equal(bridge.getSnapshot().deliveryWorkspace.gateStatus, 'blocked')
  assert.equal(bridge.getSnapshot().deliveryWorkspace.exports.length, 0)
  await bridge.selectSession('project-case', 'session-case-interview')
  assert.equal(bridge.getSnapshot().revisionWorkspace.bodyVersionId, null)
  assert.deepEqual(bridge.getSnapshot().revisionWorkspace.blocks, [])
  assert.equal(bridge.getSnapshot().factCheckWorkspace.status, 'not_checked')
  assert.deepEqual(bridge.getSnapshot().factCheckWorkspace.provenance, [])
  assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, null)
  assert.deepEqual(bridge.getSnapshot().deliveryWorkspace.exports, [])
  await bridge.selectSession('project-launch', 'session-launch-draft')
  assert.equal(bridge.getSnapshot().revisionWorkspace.blocks.length, 3)
  assert.equal(bridge.getSnapshot().factCheckWorkspace.status, 'blocked')
  bridge.dispose()
})

test('mock delivery commands are visibly read-only', async () => {
  const bridge = createDeterministicMockBridge()
  await assert.rejects(bridge.saveWorkingCopy(), /MOCK_EXPORT_READ_ONLY/)
  await assert.rejects(bridge.exportPublication('txt'), /MOCK_EXPORT_READ_ONLY/)
  bridge.dispose()
})

test('mock co-creation checkpoint carries user feedback into the next visible stage', async () => {
  const bridge = createDeterministicMockBridge({ latencyMs: 5 })
  const recovery = bridge.getSnapshot().recoverableRuns[0]
  assert.equal(recovery?.checkpointStage, 'outline')
  await bridge.resumeRun(recovery!.runId, 'resume', {
    feedback: '保留业务主线，开头更直接。',
  })
  assert.equal(bridge.getSnapshot().activeRunId, recovery?.runId)
  await new Promise(resolve => setTimeout(resolve, 20))
  const snapshot = bridge.getSnapshot()
  assert.equal(snapshot.activeRunId, null)
  assert.equal(snapshot.recoverableRuns[0]?.checkpointStage, 'draft')
  assert.equal(snapshot.runRecords[0]?.completedStages, 3)
  assert.equal(
    (snapshot.timelineBySession[snapshot.selectedSessionId] ?? []).some(item =>
      item.kind === 'message' && item.role === 'user' && item.body === '保留业务主线，开头更直接。'
    ),
    true,
  )
  bridge.dispose()
})

test('mock run emits pending then deterministic completion', async () => {
  const bridge = createDeterministicMockBridge({ latencyMs: 5 })
  const revisions: number[] = []
  const unsubscribe = bridge.subscribe(() => revisions.push(bridge.getSnapshot().revision))
  const { runId } = await bridge.sendMessage('生成一段测试文案')
  assert.equal(bridge.getSnapshot().activeRunId, runId)
  assert.equal(bridge.getSnapshot().connection, 'running')
  await new Promise(resolve => setTimeout(resolve, 20))
  const completed = bridge.getSnapshot()
  assert.equal(completed.activeRunId, null)
  assert.equal(completed.connection, 'ready')
  assert.match(
    completed.timelineBySession[completed.selectedSessionId]?.at(-1)?.kind === 'message'
      ? completed.timelineBySession[completed.selectedSessionId]?.at(-1)?.body ?? ''
      : '',
    /确定性响应/,
  )
  assert.ok(revisions.length >= 3)
  unsubscribe()
  bridge.dispose()
})

test('cancelled mock run cannot append a late assistant result', async () => {
  const bridge = createDeterministicMockBridge({ latencyMs: 30 })
  const { runId } = await bridge.sendMessage('取消测试')
  await bridge.cancelRun(runId)
  await new Promise(resolve => setTimeout(resolve, 45))
  const snapshot = bridge.getSnapshot()
  const items = snapshot.timelineBySession[snapshot.selectedSessionId] ?? []
  assert.equal(snapshot.activeRunId, null)
  assert.equal(items.some(item => item.id === `${runId}-assistant`), false)
  assert.equal(items.find(item => item.id === `${runId}-tool`)?.kind === 'tool'
    ? items.find(item => item.id === `${runId}-tool`)?.state
    : undefined, 'cancelled')
  bridge.dispose()
})
