import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceStorage } from '../../../packages/storage/src/index.js'
import { startDesktopApplicationHost } from '../src/startup.js'
import { fileURLToPath } from 'node:url'
import { inspectPendingWorkspaceRestore, recoverPendingWorkspaceRestore, replaceWorkspaceDatabaseFromBackup } from '../src/workspace-restore.js'

const worker = fileURLToPath(new URL('./workspace-restore-crash.fixture.ts', import.meta.url))
function killAt(root: string, operation: string, phase: string): void {
  const child = spawnSync(process.execPath, ['--import', 'tsx', worker, root, operation, phase], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(child.error, undefined, child.error?.message)
  assert.notEqual(child.status, 0, `child must die at ${operation}/${phase}`)
  assert.equal(child.stderr, '', `child must terminate at the cut, not fail before it: ${child.stderr}`)
}
async function fixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'wa-restore-regression-'))
  for (const side of ['active', 'source']) {
    const storage = openWorkspaceStorage({ workspacePath: join(root, side) })
    try {
      assert.equal(storage.createProject({ operationId: 'create', projectId: side === 'active' ? 'old-project' : 'new-project',
        name: side, mode: 'quick', actor: { kind: 'user', id: 'test' } }).ok, true)
      if (side === 'source') await storage.createBackup(join(root, 'selected.sqlite3'))
    } finally { storage.close() }
  }
  return root
}
async function assertGated(root: string): Promise<void> {
  await assert.rejects(startDesktopApplicationHost({ workspacePath: join(root, 'active'), providerProfilePath: join(root, 'provider.json') }),
    { code: 'RESTORE_RECOVERY_REQUIRED' })
  assert.throws(() => openWorkspaceStorage({ workspacePath: join(root, 'active') }), { code: 'RESTORE_RECOVERY_REQUIRED' })
}
function assertProjects(root: string, expected: 'old-project' | 'new-project', wal = false): void {
  const storage = openWorkspaceStorage({ workspacePath: join(root, 'active') })
  try {
    assert.ok(storage.inspectProject(expected))
    assert.equal(storage.inspectProject(expected === 'old-project' ? 'new-project' : 'old-project'), null)
    if (wal) assert.ok(storage.inspectProject('wal-project'), 'committed WAL data survives rollback')
  } finally { storage.close() }
}
const cuts = ['prepared', 'install-copied', 'wal-removed', 'shm-removed', 'target-removed', 'target-installed', 'target-verified'] as const
for (const action of ['rollback', 'retry'] as const) {
  for (const cut of cuts) {
    test(`SIGKILL during restore at ${cut}: startup gates and ${action} preserves exact chosen content`, async () => {
      const root = await fixture()
      try {
        killAt(root, 'wal-write', '')
        assert.ok(existsSync(join(root, 'active', '.writing-agent', 'workspace.sqlite3-wal')))
        killAt(root, 'restore', cut)
        await assertGated(root)
        await recoverPendingWorkspaceRestore({ workspacePath: join(root, 'active'), action })
        assert.equal(inspectPendingWorkspaceRestore(join(root, 'active')), null)
        assertProjects(root, action === 'rollback' ? 'old-project' : 'new-project', action === 'rollback')
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
  for (const cut of cuts.filter(point => point !== 'prepared')) {
    test(`SIGKILL during ${action} at ${cut}: another restart and same action succeeds`, async () => {
      const root = await fixture()
      try {
        killAt(root, 'restore', 'target-removed')
        killAt(root, action, cut)
        await assertGated(root)
        await recoverPendingWorkspaceRestore({ workspacePath: join(root, 'active'), action })
        assertProjects(root, action === 'rollback' ? 'old-project' : 'new-project')
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
}

test('kill after journal removal opens the verified restored database', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'journal-removed')
    assert.equal(inspectPendingWorkspaceRestore(join(root, 'active')), null)
    assertProjects(root, 'new-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy rollback captures the old committed WAL left under the live basename', async () => {
  const root = await fixture()
  try {
    killAt(root, 'wal-write', '')
    const target = join(root, 'active', '.writing-agent', 'workspace.sqlite3')
    renameSync(target, `${target}.restore-previous-legacy`)
    await assertGated(root)
    killAt(root, 'rollback', 'legacy-archived')
    await assertGated(root)
    await recoverPendingWorkspaceRestore({ workspacePath: join(root, 'active'), action: 'rollback' })
    assert.equal(inspectPendingWorkspaceRestore(join(root, 'active')), null)
    assertProjects(root, 'old-project', true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('corrupt journal and path escape stop before touching files or creating a database', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'target-removed')
    const path = join(root, 'active', '.writing-agent', 'restore-journal.json')
    const valid = readFileSync(path, 'utf8')
    for (const contents of ['{', JSON.stringify({ ...JSON.parse(valid), id: '../../outside' })]) {
      writeFileSync(path, contents)
      await assert.rejects(startDesktopApplicationHost({ workspacePath: join(root, 'active'), providerProfilePath: join(root, 'provider.json') }),
        { code: 'RESTORE_RECOVERY_REQUIRED' })
      assert.throws(() => inspectPendingWorkspaceRestore(join(root, 'active')), { code: 'RESTORE_RECOVERY_INVALID' })
      assert.equal(existsSync(join(root, 'active', '.writing-agent', 'workspace.sqlite3')), false)
    }
    writeFileSync(path, valid)
    await recoverPendingWorkspaceRestore({ workspacePath: join(root, 'active'), action: 'rollback' })
    assertProjects(root, 'old-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verified snapshot replacement is detected even when replacement is a valid workspace DB', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'target-removed')
    const workspace = join(root, 'active')
    const journal = JSON.parse(readFileSync(join(workspace, '.writing-agent', 'restore-journal.json'), 'utf8'))
    const old = join(workspace, '.writing-agent', `restore-recovery-${journal.id}`, 'old.sqlite3')
    writeFileSync(old, readFileSync(join(root, 'selected.sqlite3')))
    assert.deepEqual(inspectPendingWorkspaceRestore(workspace), { kind: 'journal', canRollback: false, canRetry: true, hasInvalidAnchor: true })
    await assert.rejects(recoverPendingWorkspaceRestore({ workspacePath: workspace, action: 'rollback' }), { code: 'RESTORE_RECOVERY_INVALID' })
    assert.equal(existsSync(join(workspace, '.writing-agent', 'workspace.sqlite3')), false)
    await recoverPendingWorkspaceRestore({ workspacePath: workspace, action: 'retry' })
    assertProjects(root, 'new-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const action of ['rollback', 'retry'] as const) {
  test(`legacy old and current DB both exist: ${action} preserves later committed articles`, async () => {
    const root = await fixture()
    try {
      const workspace = join(root, 'active')
      const target = join(workspace, '.writing-agent', 'workspace.sqlite3')
      const parked = `${target}.restore-previous-legacy`
      const original = readFileSync(target)
      rmSync(target)
      const current = openWorkspaceStorage({ workspacePath: workspace })
      current.close()
      killAt(root, 'wal-write', '')
      writeFileSync(parked, original)
      assert.equal(inspectPendingWorkspaceRestore(workspace)?.canRetry, true)
      await recoverPendingWorkspaceRestore({ workspacePath: workspace, action })
      const transaction = readdirSync(join(workspace, '.writing-agent')).find(name => name.startsWith('restore-recovery-'))!
      const preserved = join(workspace, '.writing-agent', transaction, action === 'rollback' ? 'new.sqlite3' : 'old.sqlite3')
      assert.ok(existsSync(preserved), 'the displaced database remains an independent verified backup')
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(preserved, { readOnly: true })
      try {
        const id = action === 'rollback' ? 'wal-project' : 'old-project'
        assert.ok(db.prepare('SELECT id FROM projects WHERE id = ?').get(id))
      } finally { db.close() }
      const live = openWorkspaceStorage({ workspacePath: workspace })
      try { assert.ok(live.inspectProject(action === 'rollback' ? 'old-project' : 'wal-project')) }
      finally { live.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('successful restore removes its installed staging image and keeps the displaced safety copy', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'active')
    await replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath: join(root, 'selected.sqlite3'), idFactory: () => 'cleanup' })
    const transaction = join(workspacePath, '.writing-agent', 'restore-recovery-cleanup')
    assert.deepEqual(readdirSync(transaction), ['completed.json', 'old.sqlite3'])
    assertProjects(root, 'new-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('restore supports the desktop isolated environment path depth on Windows', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'writing-agent-desktop-test-batch1-0123456789abcdef0123456789abcdef', 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const storage = openWorkspaceStorage({ workspacePath })
    storage.close()
    await replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath: join(root, 'selected.sqlite3') })
    const reopened = openWorkspaceStorage({ workspacePath })
    try { assert.ok(reopened.inspectProject('new-project')) } finally { reopened.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('preparation failure leaves old workspace intact without a destructive phase', async () => {
  const root = await fixture()
  try {
    await assert.rejects(replaceWorkspaceDatabaseFromBackup({ workspacePath: join(root, 'active'), backupPath: join(root, 'selected.sqlite3'), idFactory: () => '../escape' }),
      { code: 'RESTORE_RECOVERY_INVALID' })
    assertProjects(root, 'old-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed preparation cleans only its own unpublished files and keeps the old database', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'active')
    const backupPath = join(root, 'selected.sqlite3')
    await assert.rejects(replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath,
      idFactory: () => { writeFileSync(backupPath, 'invalid replacement'); return 'preparation-failure' } }))
    assert.equal(existsSync(join(workspacePath, '.writing-agent', 'restore-recovery-preparation-failure')), false)
    assert.equal(inspectPendingWorkspaceRestore(workspacePath), null)
    assertProjects(root, 'old-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cleanup failure has an explicit error while verified installed data and displaced backup survive', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'active')
    const transaction = join(workspacePath, '.writing-agent', 'restore-recovery-cleanup-failure')
    await assert.rejects(replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath: join(root, 'selected.sqlite3'),
      idFactory: () => 'cleanup-failure', onPhase: phase => {
        if (phase === 'journal-removed') {
          renameSync(join(transaction, 'new.sqlite3'), join(transaction, 'preserved-new.sqlite3'))
          mkdirSync(join(transaction, 'new.sqlite3'))
        }
      } }), { code: 'RESTORE_CLEANUP_FAILED' })
    assertProjects(root, 'new-project')
    assert.ok(existsSync(join(transaction, 'old.sqlite3')))
    assert.ok(existsSync(join(transaction, 'preserved-new.sqlite3')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('damaged new anchor never disables a verified old rollback', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'target-removed')
    const workspacePath = join(root, 'active')
    const journal = JSON.parse(readFileSync(join(workspacePath, '.writing-agent', 'restore-journal.json'), 'utf8'))
    writeFileSync(join(workspacePath, '.writing-agent', `restore-recovery-${journal.id}`, 'new.sqlite3'), 'corrupt')
    assert.deepEqual(inspectPendingWorkspaceRestore(workspacePath), { kind: 'journal', canRollback: true, canRetry: false, hasInvalidAnchor: true })
    await recoverPendingWorkspaceRestore({ workspacePath, action: 'rollback' })
    assertProjects(root, 'old-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const cut of ['transaction-created', 'old-snapshotted'] as const) {
  test(`SIGKILL during preparation at ${cut} is detected and can continue the unchanged original`, async () => {
    const root = await fixture()
    try {
      killAt(root, 'wal-write', '')
      killAt(root, 'restore', cut)
      const workspacePath = join(root, 'active')
      await assertGated(root)
      assert.deepEqual(inspectPendingWorkspaceRestore(workspacePath), { kind: 'preparing', canRollback: true, canRetry: false, hasInvalidAnchor: false })
      await recoverPendingWorkspaceRestore({ workspacePath, action: 'rollback' })
      assert.equal(inspectPendingWorkspaceRestore(workspacePath), null)
      assertProjects(root, 'old-project', true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('SIGKILL after complete new snapshot and journal permits retry without reselecting the source', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'new-snapshotted')
    const workspacePath = join(root, 'active')
    await assertGated(root)
    assert.equal(inspectPendingWorkspaceRestore(workspacePath)?.canRetry, true)
    rmSync(join(root, 'selected.sqlite3'))
    await recoverPendingWorkspaceRestore({ workspacePath, action: 'retry' })
    assertProjects(root, 'new-project')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const corrupt of ['old', 'current'] as const) {
  test(`legacy ${corrupt} database corruption preserves raw evidence and permits the other verified side`, async () => {
    const root = await fixture()
    try {
      const workspacePath = join(root, 'active')
      const target = join(workspacePath, '.writing-agent', 'workspace.sqlite3')
      const parked = `${target}.restore-previous-legacy`
      if (corrupt === 'old') writeFileSync(parked, 'damaged legacy evidence')
      else { renameSync(target, parked); writeFileSync(target, 'damaged current evidence') }
      const result = await recoverPendingWorkspaceRestore({ workspacePath, action: corrupt === 'old' ? 'retry' : 'rollback' })
      assert.equal(result.warningCode, 'RESTORE_LEGACY_ANCHOR_UNVERIFIED')
      assertProjects(root, 'old-project')
      const transaction = readdirSync(join(workspacePath, '.writing-agent')).find(name => name.startsWith('restore-recovery-'))!
      const evidence = join(workspacePath, '.writing-agent', transaction, corrupt === 'old' ? 'legacy-original' : 'legacy-current.sqlite3')
      assert.equal(readFileSync(evidence, 'utf8'), corrupt === 'old' ? 'damaged legacy evidence' : 'damaged current evidence')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('partial completion receipt cannot let a direct storage opener bypass interrupted preparation', async () => {
  const root = await fixture()
  try {
    killAt(root, 'restore', 'transaction-created')
    const workspacePath = join(root, 'active')
    const transaction = readdirSync(join(workspacePath, '.writing-agent')).find(name => name.startsWith('restore-recovery-'))!
    writeFileSync(join(workspacePath, '.writing-agent', transaction, 'completed.json'), '{')
    assert.throws(() => openWorkspaceStorage({ workspacePath }), { code: 'RESTORE_RECOVERY_REQUIRED' })
    assert.throws(() => inspectPendingWorkspaceRestore(workspacePath), { code: 'RESTORE_RECOVERY_INVALID' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('damaged completion receipt never deletes the completed restore safety snapshot', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'active')
    await replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath: join(root, 'selected.sqlite3'), idFactory: () => 'damaged-receipt' })
    const transaction = join(workspacePath, '.writing-agent', 'restore-recovery-damaged-receipt')
    const safety = readFileSync(join(transaction, 'old.sqlite3'))
    const installed = readFileSync(join(workspacePath, '.writing-agent', 'workspace.sqlite3'))
    writeFileSync(join(transaction, 'completed.json'), '{')
    await assert.rejects(recoverPendingWorkspaceRestore({ workspacePath, action: 'rollback' }), { code: 'RESTORE_RECOVERY_INVALID' })
    assert.deepEqual(readFileSync(join(transaction, 'old.sqlite3')), safety)
    assert.deepEqual(readFileSync(join(workspacePath, '.writing-agent', 'workspace.sqlite3')), installed)
    assert.equal(readFileSync(join(transaction, 'completed.json'), 'utf8'), '{')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy recovery archives an interrupted preparation directory intact and does not block the next launch', async () => {
  const root = await fixture()
  try {
    const workspacePath = join(root, 'active')
    const storageRoot = join(workspacePath, '.writing-agent')
    const target = join(storageRoot, 'workspace.sqlite3')
    renameSync(target, `${target}.restore-previous-legacy`)
    const interrupted = join(storageRoot, 'restore-recovery-interrupted-legacy')
    mkdirSync(interrupted)
    writeFileSync(join(interrupted, 'legacy-source.sqlite3'), 'incomplete private copy')
    writeFileSync(join(interrupted, 'older-version-evidence.bin'), 'unknown recovery evidence')
    await recoverPendingWorkspaceRestore({ workspacePath, action: 'rollback' })
    assert.equal(inspectPendingWorkspaceRestore(workspacePath), null)
    assertProjects(root, 'old-project')
    const archived = readdirSync(storageRoot).find(name => name.startsWith('restore-evidence-'))!
    assert.ok(archived)
    assert.equal(existsSync(interrupted), false)
    assert.equal(readFileSync(join(storageRoot, archived, 'legacy-source.sqlite3'), 'utf8'), 'incomplete private copy')
    assert.equal(readFileSync(join(storageRoot, archived, 'older-version-evidence.bin'), 'utf8'), 'unknown recovery evidence')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
