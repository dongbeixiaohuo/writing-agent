import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Render the actual shell. Only CSS is removed; no fake composer or form component.
test('a new topic and an earlier unfinished conversation open a direct composer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-conversation-entry-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({
      stdin: { contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { WritingAgentShell } from './packages/ui/src/shell/WritingAgentShell.tsx';
        import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
        export function renderEntry(existing, savedReply) {
          const mock = createDeterministicMockBridge();
          const original = mock.getSnapshot();
          const snapshot = { ...original, mode:'application', selectedProjectId: existing ? original.selectedProjectId : '', selectedSessionId:savedReply ? 'history' : '',
            timelineBySession: savedReply ? {history: [{kind:'message', role:'assistant', id:'saved', body:savedReply, createdAt:'10:00'}]} : original.timelineBySession,
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
      assert.match(html, existing ? /<h1>新品发布项目<\/h1>/u : /<h1>今天，写点什么？<\/h1>/u)
      assert.doesNotMatch(html, /手动建立项目|手动建立写作简报|简报创建进度/u)
      assert.match(html, /aria-label="新建创作"/u)
      if (existing) assert.match(html, /查看写作设置/u, 'Existing brief editing remains available')
      else assert.doesNotMatch(html, /高级设置（可选）/u, 'New projects must not show an empty setup menu')
    }
    const inline = '1. 客户要的是"系统上线"\n2. 招人是补产品还是补销售\n3. 报价里怎么算毛利'
    const appended = inline.replace('"系统上线"', '“系统上线”')
    const history = `有三个切口。\n\n${inline}\n\n想先确认目标读者。\n\n${appended}\n\n你可以选一个编号，也可以直接说想写哪个方向。`
    const reopened = renderEntry(true, history)
    assert.equal(reopened.match(/招人是补产品还是补销售/gu)?.length, 1)
    assert.match(reopened, /想先确认目标读者/u)
    assert.match(reopened, /你可以选一个编号/u)
    const distinct = renderEntry(true, history.replace(appended, appended.replace('报价里怎么算毛利', '这套机制如何实施')))
    assert.equal(distinct.match(/招人是补产品还是补销售/gu)?.length, 2, 'different lists stay visible')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
