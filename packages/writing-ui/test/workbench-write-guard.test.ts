import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

function button(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*>${label}</button>`, 'u'))
  assert.ok(match, `missing button: ${label}`)
  return match[0]
}

function buttons(html: string, label: string): string[] {
  return [...html.matchAll(new RegExp(`<button[^>]*>${label}</button>`, 'gu'))].map(match => match[0])
}

test('an active run disables every workbench action that can mutate the current body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-workbench-write-guard-'))
  try {
    const output = join(directory, 'render.cjs')
    buildSync({ stdin: { contents: `
      import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import { WritingWorkbenchPanel, guardedDocumentWrite } from './packages/writing-ui/src/WritingWorkbenchPanel.tsx';
      import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
      export function render(view, active) {
        const bridge = createDeterministicMockBridge({ latencyMs: 0 });
        const baseline = bridge.getSnapshot();
        const snapshot = { ...baseline, mode: 'application', connection: 'ready', activeRunId: active ? 'run-active' : null, revisionWorkspace: {
          ...baseline.revisionWorkspace,
          proposals: [{ id: 'proposal-active-guard', status: 'proposed', baseBodyVersionId: baseline.revisionWorkspace.bodyVersionId,
            instruction: '修改正文', diff: [{ type: 'replace', targetBlockId: 'mock-block-2', before: '原文', after: '新文' }] }],
        } };
        return renderToStaticMarkup(React.createElement(WritingWorkbenchPanel, {
          bridge: { ...bridge, getSnapshot: () => snapshot }, snapshot, initialView: view, closePanel: () => {},
        }));
      }
      export async function invokeGuard(active) {
        const bridge = createDeterministicMockBridge({ latencyMs: 0 });
        const baseline = bridge.getSnapshot();
        const snapshot = { ...baseline, mode: 'application', connection: 'ready', activeRunId: active ? 'run-active' : null };
        let calls = 0;
        try {
          await guardedDocumentWrite({ ...bridge, getSnapshot: () => snapshot }, async () => { calls += 1; return 'written'; });
          return { calls, blocked: false };
        } catch { return { calls, blocked: true }; }
      }
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: output,
      jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' })
    const { render, invokeGuard } = createRequire(import.meta.url)(output) as {
      render(view: string, active: boolean): string
      invokeGuard(active: boolean): Promise<{ calls: number; blocked: boolean }>
    }

    const activeEdit = render('edit', true)
    for (const label of ['接受并创建新版本', '取消提案', '局部修改', '显式解锁']) {
      assert.match(button(activeEdit, label), /disabled=""/u, `${label} must be blocked while a run is active`)
    }
    assert.match(button(render('versions', true), '回退到此版'), /disabled=""/u)
    assert.match(button(render('delivery', true), '保存 Markdown 工作备份'), /disabled=""/u)

    const idleEdit = render('edit', false)
    assert.doesNotMatch(button(idleEdit, '接受并创建新版本'), /disabled=/u)
    assert.doesNotMatch(button(idleEdit, '取消提案'), /disabled=/u)
    assert.ok(buttons(idleEdit, '局部修改').some(candidate => !candidate.includes('disabled=')))
    assert.doesNotMatch(button(render('versions', false), '回退到此版'), /disabled=/u)
    assert.doesNotMatch(button(render('delivery', false), '保存 Markdown 工作备份'), /disabled=/u)

    assert.deepEqual(await invokeGuard(true), { calls: 0, blocked: true })
    assert.deepEqual(await invokeGuard(false), { calls: 1, blocked: false })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
