import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { styleReferenceForProfile } from '../../../packages/writing-core/src/style-profile.ts'

function helpers() {
  const directory = mkdtempSync(join(tmpdir(), 'writing-agent-style-library-'))
  const output = join(directory, 'dialog.cjs')
  try {
    buildSync({ entryPoints: [resolve('packages/ui/src/shell/StyleLibraryDialog.tsx')], outfile: output, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'text' } })
    return createRequire(import.meta.url)(output) as typeof import('../src/shell/StyleLibraryDialog.tsx')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('a new selection replaces the previous leading card without discarding draft text', () => {
  const { withStyleSelection } = helpers();
  const first = withStyleSelection('原文材料：不能丢失', '个人风格卡 · A · a · v1\n短句。');
  const next = withStyleSelection(first, '个人风格卡 · B · b · v2\n长短句交替。');
  assert.equal(next.startsWith('请按下面明确指定的风格卡写作：'), true);
  assert.equal((next.match(/<writing-style-card>/gu) ?? []).length, 1);
  assert.equal(next.includes('个人风格卡 · A'), false);
  assert.equal(next.endsWith('原文材料：不能丢失'), true);
});

function renderDialog() {
  const directory = mkdtempSync(join(tmpdir(), 'writing-agent-style-library-render-'))
  const output = join(directory, 'render.cjs')
  try {
    buildSync({
      stdin: { resolveDir: resolve('.'), sourcefile: 'style-library-render.tsx', contents: `
        import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
        import { StyleLibraryDialog } from './packages/ui/src/shell/StyleLibraryDialog.tsx';
        export const render = () => renderToStaticMarkup(React.createElement(StyleLibraryDialog, { host: { styleLibrary: async () => ({ profiles: [] }) }, onClose: () => {} }));
      ` },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' },
    })
    return (createRequire(import.meta.url)(output) as { render(): string }).render()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('saved style reference preserves a stable profile identity within the brief limit', () => {
  const reference = styleReferenceForProfile({
    id: 'style-1', version: 3, name: '克制观察', card: '短句。避免营销腔。'.repeat(100),
  })
  assert.match(reference, /^个人风格卡 · 克制观察 · style-1 · v3/u)
  assert.ok(reference.length <= 2_100)
  assert.match(reference, /短句。避免营销腔。/u)
})

test('style library capability is optional and does not mistake arbitrary host data for a callable bridge', () => {
  const { supportsStyleLibrary } = helpers()
  assert.equal(supportsStyleLibrary(undefined), false)
  assert.equal(supportsStyleLibrary({ styleLibrary: 'nope' }), false)
  assert.equal(supportsStyleLibrary({ styleLibrary: async () => ({ profiles: [] }) }), true)
})

test('style library dialog renders the bounded, evidence-oriented intake before any host result returns', () => {
  const html = renderDialog()
  assert.match(html, /风格库/u)
  assert.match(html, /TXT\/MD\/DOCX/u)
  assert.match(html, /同一作者和相近场景/u)
  assert.match(html, /读取网页/u)
  assert.match(html, /导入文档/u)
})
