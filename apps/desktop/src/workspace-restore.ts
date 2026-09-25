import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  inspectWorkspaceBackupFile,
  restoreWorkspaceBackup,
  type BackupManifest,
} from '../../../packages/storage/src/index.js'

function databasePath(workspacePath: string): string {
  return resolve(join(workspacePath, '.writing-agent', 'workspace.sqlite3'))
}

function removeDatabaseSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const sidecar = `${path}${suffix}`
    if (existsSync(sidecar)) rmSync(sidecar, { force: true })
  }
}

export async function replaceWorkspaceDatabaseFromBackup(input: {
  readonly workspacePath: string
  readonly backupPath: string
  readonly idFactory?: () => string
}): Promise<BackupManifest> {
  const target = databasePath(input.workspacePath)
  const source = resolve(input.backupPath)
  if (!existsSync(target)) throw Object.assign(new Error('RESTORE_TARGET_MISSING'), { code: 'RESTORE_TARGET_MISSING' })
  if (source === target) throw Object.assign(new Error('RESTORE_SOURCE_IS_TARGET'), { code: 'RESTORE_SOURCE_IS_TARGET' })
  const inspection = inspectWorkspaceBackupFile(source)
  if (!inspection.ok) throw Object.assign(new Error(inspection.message), { code: inspection.code })
  if (!inspection.supported) throw Object.assign(new Error('SCHEMA_UNSUPPORTED'), { code: 'SCHEMA_UNSUPPORTED' })

  const parked = `${target}.restore-previous-${(input.idFactory ?? randomUUID)()}`
  renameSync(target, parked)
  removeDatabaseSidecars(target)
  try {
    const restored = await restoreWorkspaceBackup({
      backupPath: source,
      targetWorkspacePath: resolve(input.workspacePath),
    })
    try {
      rmSync(parked, { force: true })
    } catch {
      // The verified safety backup created by the caller remains the recovery path.
    }
    return restored
  } catch (error) {
    if (existsSync(target)) rmSync(target, { force: true })
    removeDatabaseSidecars(target)
    if (existsSync(parked)) renameSync(parked, target)
    throw error
  }
}
