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
  assert.match(html, /样本（0\/10/u)
  assert.match(html, /<textarea[^>]*aria-label="网页样文链接"/u)
  assert.match(html, /每行一个/u)
  assert.match(html, /最多.*10.*份/u)
})

test('batch link intake accepts multiple lines, deduplicates and rejects over-capacity without truncating', () => {
  const api = helpers();
  assert.equal(typeof api.prepareStyleLinks, 'function');
  const a = 'https://mp.weixin.qq.com/s/a', b = 'http://example.test/b';
  assert.deepEqual(api.prepareStyleLinks(`${a}\n${b}\n${a}`, []), { urls: [a, b], duplicateCount: 1 });
  const existing = [{ id: 'a', title: '已有', kind: 'web' as const, sourceReference: a, text: '已有样文' }];
  assert.deepEqual(api.prepareStyleLinks(`${a}\n${b}`, existing), { urls: [b], duplicateCount: 1 });
  assert.throws(() => api.prepareStyleLinks(Array.from({ length: 11 }, (_, i) => `https://example.test/${i}`).join('\n'), []), /STYLE_SAMPLE_LIMIT_EXCEEDED/);
  assert.throws(() => api.prepareStyleLinks(`${a}\nnot-a-link`, []), /STYLE_SOURCE_URL_INVALID/);
});

test('batch merge reports duplicate and failed documents without losing successful or existing samples', () => {
  const api = helpers();
  assert.equal(typeof api.mergeStyleImports, 'function');
  const original = { id: 'a', title: '已有', kind: 'text' as const, sourceReference: null, text: '已有样文。' };
  const other = { ...original, id: 'b', title: '新增', text: '另一个样文。' };
  const result = api.mergeStyleImports([original], [
    { label: '重复', status: 'loaded', sample: { ...original, id: 'duplicate' } },
    { label: '坏文件', status: 'failed', code: 'STYLE_DOCUMENT_INVALID' },
    { label: '新增', status: 'loaded', sample: other },
  ]);
  assert.deepEqual(result.samples, [original, other]);
  assert.deepEqual(result.items.map(item => item.status), ['failed', 'failed', 'loaded']);
  assert.equal(result.items[0].code, 'STYLE_SAMPLE_DUPLICATE');
});
