import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { readLocalSettings, type LocalSettingsRecovery } from './local-settings-recovery.js'

import type {
  PersistedUiSettings,
  UiSettingsPersistence,
} from './application-bridge.js'

interface UiSettingsFile extends PersistedUiSettings {
  readonly schemaVersion: 1
}

export interface FileUiSettingsPersistenceOptions {
  readonly filePath: string
  readonly recovery?: LocalSettingsRecovery
}

function parseSettings(value: unknown): PersistedUiSettings {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('theme' in value) ||
    (value.theme !== 'light' &&
      value.theme !== 'dark' &&
      value.theme !== 'system' &&
      value.theme !== 'paper') ||
    !('contentFontSize' in value) ||
    typeof value.contentFontSize !== 'number' ||
    ![13, 14, 16].includes(value.contentFontSize)
  ) {
    throw new Error('UI_SETTINGS_INVALID')
  }
  return { theme: value.theme, contentFontSize: value.contentFontSize }
}

export function createFileUiSettingsPersistence(
  options: FileUiSettingsPersistenceOptions,
): UiSettingsPersistence {
  const filePath = resolve(options.filePath)
  return {
    load() {
      return readLocalSettings(filePath, 'appearance', null, parseSettings, options.recovery)
    },
    save(value) {
      options.recovery?.assertWritable(filePath)
      const validated = parseSettings({ schemaVersion: 1, ...value })
      const payload: UiSettingsFile = {
        schemaVersion: 1,
        ...validated,
      }
      mkdirSync(dirname(filePath), { recursive: true })
      const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
      try {
        writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        renameSync(temporaryPath, filePath)
      } finally {
        rmSync(temporaryPath, { force: true })
      }
    },
  }
}
