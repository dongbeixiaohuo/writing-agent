import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { openWorkspaceStorage } from '../../../packages/storage/src/index.js'
import { replaceWorkspaceDatabaseFromBackup } from '../src/workspace-restore.js'

const actor = { kind: 'user', id: 'restore-test' } as const

function addProject(workspacePath: string, projectId: string, name: string) {
  const storage = openWorkspaceStorage({ workspacePath })
  const created = storage.createProject({
    operationId: `create:${projectId}`,
    projectId,
    name,
    mode: 'quick',
    actor,
  })
  assert.equal(created.ok, true)
  return storage
}

describe('desktop workspace restore', () => {
  it('replaces the closed live database with only the selected verified backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'writing-agent-desktop-restore-'))
    const activePath = join(root, 'active')
    const sourcePath = join(root, 'source')
    const backupPath = join(root, 'selected.sqlite3')
    const active = addProject(activePath, 'current-project', '当前工作区')
    const source = addProject(sourcePath, 'restored-project', '备份中的工作区')
    try {
      await source.createBackup(backupPath)
    } finally {
      active.close()
      source.close()
    }

    try {
      const restored = await replaceWorkspaceDatabaseFromBackup({
        workspacePath: activePath,
        backupPath,
        idFactory: () => 'test-swap',
      })
      assert.equal(restored.schemaVersion > 0, true)
      const reopened = openWorkspaceStorage({ workspacePath: activePath })
      try {
        assert.equal(reopened.inspectProject('current-project'), null)
        assert.equal(reopened.inspectProject('restored-project')?.name, '备份中的工作区')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the live database when the selected file is not a valid backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'writing-agent-desktop-restore-invalid-'))
    const activePath = join(root, 'active')
    const active = addProject(activePath, 'current-project', '当前工作区')
    active.close()
    try {
      await assert.rejects(
        () => replaceWorkspaceDatabaseFromBackup({
          workspacePath: activePath,
          backupPath: join(root, 'missing.sqlite3'),
        }),
        (error) => error instanceof Error && 'code' in error && error.code === 'DATABASE_NOT_FOUND',
      )
      const reopened = openWorkspaceStorage({ workspacePath: activePath })
      try {
        assert.equal(reopened.inspectProject('current-project')?.name, '当前工作区')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
