import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFileUiSettingsPersistence } from '../src/ui-settings-persistence.js'

test('file UI settings persistence survives reopen and replaces atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-ui-settings-'))
  const filePath = join(root, '.writing-agent', 'ui-settings.json')
  try {
    const first = createFileUiSettingsPersistence({ filePath })
    assert.equal(first.load(), null)
    first.save({ theme: 'dark', contentFontSize: 16 })

    const reopened = createFileUiSettingsPersistence({ filePath })
    assert.deepEqual(reopened.load(), { theme: 'dark', contentFontSize: 16 })
    reopened.save({ theme: 'system', contentFontSize: 14 })
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
      schemaVersion: 1,
      theme: 'system',
      contentFontSize: 14,
    })
    assert.equal(existsSync(`${filePath}.tmp`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file UI settings persistence fails closed on malformed data', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-ui-settings-invalid-'))
  const filePath = join(root, 'ui-settings.json')
  try {
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, theme: 'neon', contentFontSize: 999 }))
    const persistence = createFileUiSettingsPersistence({ filePath })
    assert.throws(() => persistence.load(), /UI_SETTINGS_INVALID/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
