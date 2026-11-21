import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const productionRoot = resolve('apps/web/dist/production')
const mockRoot = resolve('apps/web/dist/mock')
const extensionDemoRoot = resolve('apps/web/dist/extension-demo')

async function allFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? allFiles(path) : [path]
  }))
  return nested.flat()
}

async function bundleText(root) {
  const files = await allFiles(root)
  const textual = files.filter(path => /\.(?:html|css|js|map)$/u.test(path))
  return (await Promise.all(textual.map(path => readFile(path, 'utf8')))).join('\n')
}

const production = await bundleText(productionRoot)
const mock = await bundleText(mockRoot)
const extensionDemo = await bundleText(extensionDemoRoot)

for (const marker of [
  'deterministic-mock',
  'mock-run-',
  '界面移植预览，未接入真实写作',
  'writing-agent-app',
  '@tauri-apps',
  'download.deepseek.com',
  '127.0.0.1:4173',
  '127.0.0.1:4174',
  '$DSH_HOME',
  'example.editorial-notes',
  '编辑备注演示',
  'sessionStorage',
]) {
  assert.equal(production.includes(marker), false, `production bundle contains ${marker}`)
}

// Unsent author text may persist through the scoped draft module. Keep the
// renderer storage boundary for every other source, including model settings.
const storageUses = (text) => text?.match(/\blocalStorage\b/gu)?.length ?? 0
for (const path of (await allFiles(productionRoot)).filter(path => path.endsWith('.js'))) {
  const script = await readFile(path, 'utf8')
  const map = JSON.parse(await readFile(path + '.map', 'utf8'))
  let allowedUses = 0
  for (const [index, source] of map.sources.entries()) {
    const content = map.sourcesContent?.[index]
    const uses = storageUses(content)
    if (uses === 0) continue
    assert.ok(source.endsWith('/packages/ui/src/shell/draft-storage.ts'), `unexpected renderer storage source: ${source}`)
    assert.ok(content.includes('writing-agent:draft:v1:'), 'draft storage must use its own namespace')
    allowedUses += uses
  }
  assert.equal(storageUses(script), allowedUses, `unexpected browser storage in ${path}`)
}

assert.match(production, /生产构建不会自动启用 Mock/u)
// Provider addresses are selectable catalog data, not a hidden DSH dependency.
// Source checks forbid renderer networking and CSP continues to be self-only.
assert.match(production, /writing-agent-bootstrap-capability/u)
assert.match(production, /x-writing-agent-protocol/u)
assert.match(production, /LOCAL_WEB_ORIGIN_REQUIRED/u)
assert.match(mock, /界面移植预览，未接入真实写作/u)
assert.match(mock, /deterministic-mock/u)
assert.match(extensionDemo, /deterministic-mock/u)
assert.match(extensionDemo, /example\.editorial-notes/u)
assert.match(extensionDemo, /编辑备注演示/u)
console.log('UI distribution boundary: PASS')
