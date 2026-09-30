import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Render the actual shell. Only CSS is removed; no fake composer or form component.
test('first use and an unconfirmed project both expose conversation without a required form', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-conversation-entry-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({
      stdin: { contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { WritingAgentShell } from './packages/ui/src/shell/WritingAgentShell.tsx';
        import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
        export function renderEntry(existing) {
          const mock = createDeterministicMockBridge();
          const original = mock.getSnapshot();
          const snapshot = { ...original, mode:'application', selectedProjectId: existing ? original.selectedProjectId : '', selectedSessionId:'',
            brief:existing ? {...original.brief, confirmationStatus:'tentative'} : null,
            projects:existing ? original.projects : [], sessions:[], activeRunId:null, recoverableRuns:[],
            settings:{...original.settings,credentialReference:'TEST_ONLY'}, runRecords:[] };
          const bridge = {...mock,getSnapshot:()=>snapshot};
          const extensions = {extensionIds:[],listLaunchers:()=>[],getPanel:()=>undefined};
          const html = renderToStaticMarkup(React.createElement(WritingAgentShell,{bridge,extensions}));
          mock.dispose(); return html;
        }
      `, resolveDir: resolve('.'), loader: 'tsx' },
      bundle: true, platform: 'node', format: 'cjs', outfile: output, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.css': 'empty' }, logLevel: 'silent',
    })
    const { renderEntry } = createRequire(import.meta.url)(output)
    for (const existing of [false, true]) {
      const html = renderEntry(existing)
      assert.match(html, /contenteditable="true"[^>]*role="textbox"/i, 'Natural language must be available before brief confirmation')
      assert.doesNotMatch(html, /role="dialog"|填写写作目标并粘贴|请先确认写作简报和方向/u)
      assert.match(html, /今天想写什么|开始新对话/u)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
