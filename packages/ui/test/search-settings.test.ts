import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { buildSync } from 'esbuild'

import { searchSettingsInput, searchSettingsValidation } from '../src/shell/search-settings.ts'

test('query limit is saved with search settings and rejects non-integer or out-of-range values', () => {
  for (const searchLimit of [0, 31, 1.5, NaN]) assert.notEqual(searchSettingsValidation({ tavilyEnabled: false, tavilyKeyConfigured: false, searchLimit }, ''), null)
  for (const searchLimit of [1, 6, 30]) assert.equal(searchSettingsValidation({ tavilyEnabled: false, tavilyKeyConfigured: false, searchLimit }, ''), null)
  assert.deepEqual(searchSettingsInput({ parallelEnabled: true, tavilyEnabled: false, searchLimit: 12 }, ''), { parallelEnabled: true, tavilyEnabled: false, searchLimit: 12 })
})

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

test('search recovery cards visibly offer the matching decision, not a generic resume button', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-search-cards-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({ stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { CheckpointDecisionCard } from './packages/ui/src/shell/WritingAgentShell.tsx';
      export const cards = ['timeout','failure','limit'].map(kind => renderToStaticMarkup(React.createElement(CheckpointDecisionCard, {
        bridge: {}, recovery: {runId:'r', stopReason:'FACT_SEARCH_DECISION_REQUIRED', inputRequest:{kind:'search_recovery', reason:'没有取得结果',
          searchRecovery:{requestId:'search-1',kind,query:'公开日期',used:2,limit:6,attemptsUsed:3,attemptsLimit:9}}},
        onInspect:()=>{},onContinued:()=>{},runActive:false,canApproveCheckpoint:false
      })));
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: output, jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' })
    const { cards } = createRequire(import.meta.url)(output)
    for (const html of cards) { assert.match(html, /搜索恢复决定/); assert.match(html, /不再搜索，继续核查/); assert.match(html, /公开日期/); }
    assert.match(cards[0], /重试本次搜索/); assert.match(cards[1], /重试本次搜索/)
    assert.match(cards[2], /追加3次搜索/); assert.doesNotMatch(cards[2], /重试本次搜索/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
