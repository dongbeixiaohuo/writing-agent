import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildSync } from 'esbuild'

import { searchSettingsInput, searchSettingsValidation } from '../src/shell/search-settings.ts'

test('Tavily requires a key only when enabled without an existing credential', () => {
  assert.match(searchSettingsValidation({ tavilyEnabled: true, tavilyKeyConfigured: false }, ''), /API Key/)
  assert.equal(searchSettingsValidation({ tavilyEnabled: true, tavilyKeyConfigured: true }, ''), null)
  assert.equal(searchSettingsValidation({ tavilyEnabled: true, tavilyKeyConfigured: false }, 'tvly-new'), null)
  assert.equal(searchSettingsValidation({ tavilyEnabled: false, tavilyKeyConfigured: false }, ''), null)
})

test('blank Tavily key is omitted so saving preserves the stored credential', () => {
  assert.deepEqual(searchSettingsInput({ parallelEnabled: true, tavilyEnabled: true }, '  '), {
    parallelEnabled: true,
    tavilyEnabled: true,
  })
  assert.deepEqual(searchSettingsInput({ parallelEnabled: false, tavilyEnabled: true }, '  tvly-new  '), {
    parallelEnabled: false,
    tavilyEnabled: true,
    tavilyApiKey: 'tvly-new',
  })
})

test('search settings renders a safe explanation when the desktop host is unavailable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-search-settings-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({
      stdin: { contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SearchSettings } from './packages/ui/src/shell/SearchSettings.tsx';
        export const html = renderToStaticMarkup(React.createElement(SearchSettings, { host: undefined }));
      `, resolveDir: resolve('.'), loader: 'tsx' },
      bundle: true, platform: 'node', format: 'cjs', outfile: output, jsx: 'automatic',
      loader: { '.css': 'empty' }, logLevel: 'silent',
    })
    const { html } = createRequire(import.meta.url)(output)
    assert.match(html, />搜索</u)
    assert.match(html, /仅在支持该功能的桌面版中可用/u)
    assert.match(html, /不会读取或保存搜索凭据/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
