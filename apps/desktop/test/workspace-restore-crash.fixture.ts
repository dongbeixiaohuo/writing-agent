// Invoked only by workspace-restore-recovery.test.ts with its fresh OS-temp fixture.
import { resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkspaceStorage } from '../../../packages/storage/src/index.js'
import { recoverPendingWorkspaceRestore, replaceWorkspaceDatabaseFromBackup } from '../src/workspace-restore.js'

const [root, mode, phase] = process.argv.slice(2)
if (!root || !resolve(root).startsWith(`${resolve(tmpdir())}\\`) && !resolve(root).startsWith(`${resolve(tmpdir())}/`)
  || !basename(root).startsWith('wa-restore-regression-')) throw new Error('Test worker requires its own temporary fixture')
const workspacePath = join(root, 'active')
const onPhase = (point: string) => { if (point === phase) process.kill(process.pid, 'SIGKILL') }
if (mode === 'wal-write') {
  const storage = openWorkspaceStorage({ workspacePath })
  const result = storage.createProject({ operationId: 'wal-create', projectId: 'wal-project', name: 'committed in WAL',
    mode: 'quick', actor: { kind: 'user', id: 'test' } })
  if (!result.ok) throw new Error('Fixture creation failed')
  process.kill(process.pid, 'SIGKILL')
} else if (mode === 'restore') {
  await replaceWorkspaceDatabaseFromBackup({ workspacePath, backupPath: join(root, 'selected.sqlite3'), onPhase })
} else if (mode === 'rollback' || mode === 'retry') {
  await recoverPendingWorkspaceRestore({ workspacePath, action: mode, onPhase })
} else throw new Error('Unknown test operation')
