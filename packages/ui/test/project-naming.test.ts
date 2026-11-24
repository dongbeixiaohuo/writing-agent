import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('sidebar displays one row per writing conversation and keeps old threads available in history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-project-naming-ui-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({
      stdin: { contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { WritingAgentShell } from './packages/ui/src/shell/WritingAgentShell.tsx';
        import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
        const bridge=createDeterministicMockBridge({latencyMs:0});
        const extensions={extensionIds:[],listLaunchers:()=>[],getPanel:()=>undefined};
        export const html=renderToStaticMarkup(React.createElement(WritingAgentShell,{bridge,extensions}));
        bridge.dispose();
      `, resolveDir: resolve('.'), loader: 'tsx' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: output,
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      logLevel: 'silent',
    })
    const { html } = createRequire(import.meta.url)(output) as { html: string }
    const sidebar = html.match(/<aside[^>]+aria-label="会话列表"[\s\S]*?<\/aside>/u)?.[0] ?? ''
    assert.equal((sidebar.match(/data-conversation-row/g) ?? []).length, 2)
    assert.match(sidebar, /aria-label="重命名会话“新品发布项目”"/u)
    assert.match(sidebar, /aria-label="重命名会话“客户案例专题”"/u)
    assert.doesNotMatch(sidebar, /新建项目|在.*中新建对话|公众号初稿|文章提纲|访谈材料整理/u)
    assert.match(html, /<summary>旧对话记录<\/summary>/u)
    assert.doesNotMatch(html, /重命名文章|重命名发布标题/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
