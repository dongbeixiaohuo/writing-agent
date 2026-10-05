import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('sidebar exposes project rename separately from article title editing', () => {
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
    assert.match(html, /aria-label="重命名项目“新品发布项目”"/u)
    assert.match(html, /aria-label="重命名项目“客户案例专题”"/u)
    assert.doesNotMatch(html, /重命名文章|重命名发布标题/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
