import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const stageRoot = resolve('apps/desktop/dist/package')

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  }))
  return nested.flat()
}

const staged = await files(stageRoot)
const names = staged.map(path => relative(stageRoot, path).split(sep).join('/')).sort()
for (const required of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'SOURCE_AND_DEPENDENCY_MANIFEST.json',
  'SHA256SUMS.txt',
  'main.cjs',
  'preload.cjs',
  'renderer/index.html',
]) assert.equal(names.includes(required), true, `missing ${required}`)

assert.equal(names.some(name => name.endsWith('.map')), false, 'source map shipped')
assert.equal(names.some(name => /\.(?:ts|tsx|py)$/u.test(name)), false, 'source/runtime script shipped')
assert.equal(names.some(name => name.includes('node_modules/')), false, 'unbundled dependency tree shipped')

const executableFiles = staged.filter(path => /\.(?:cjs|js|css|html|json)$/u.test(path))
const executableText = (await Promise.all(executableFiles.map(path => readFile(path, 'utf8')))).join('\n')
const preloadText = await readFile(resolve(stageRoot, 'preload.cjs'), 'utf8')
const packageMetadata = JSON.parse(await readFile(resolve(stageRoot, 'package.json'), 'utf8'))
const dependencyManifest = JSON.parse(await readFile(resolve(stageRoot, 'SOURCE_AND_DEPENDENCY_MANIFEST.json'), 'utf8'))
const sourcePackage = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8'))
assert.equal(packageMetadata.version, sourcePackage.version)
assert.equal(dependencyManifest.version, packageMetadata.version)
assert.equal(/require\(["']node:/u.test(preloadText), false, 'sandbox preload imports a Node built-in')
for (const marker of [
  '@tauri-apps',
  'deterministic-mock',
  'dsh-app',
  'DSH_HOME',
  'download.deepseek.com',
  'writing-agent-app',
  'C:\\Users\\Dante',
  'D:\\OneDrive',
]) assert.equal(executableText.includes(marker), false, `forbidden runtime marker ${marker}`)
// Migrated instructions/styles intentionally retain source provenance as data.
// Shipping the old runtime or invoking its scripts is still forbidden.
assert.equal(names.some(name => /(?:^|\/)(?:claude-runtime|\.claude|writing-agent-app)\//u.test(name)), false, 'legacy runtime directory shipped')
assert.equal(/\bsk-[A-Za-z0-9_-]{12,}\b/u.test(executableText), false, 'credential-shaped text shipped')

const sums = (await readFile(resolve(stageRoot, 'SHA256SUMS.txt'), 'utf8'))
  .trim()
  .split(/\r?\n/u)
  .map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u)
    assert.notEqual(match, null, `invalid checksum line ${line}`)
    return { hash: match?.[1] ?? '', name: match?.[2] ?? '' }
  })
const expectedNames = names.filter(name => name !== 'SHA256SUMS.txt')
assert.deepEqual(sums.map(item => item.name), expectedNames)
for (const item of sums) {
  const data = await readFile(resolve(stageRoot, item.name))
  assert.equal(createHash('sha256').update(data).digest('hex'), item.hash, item.name)
}

console.log(`Desktop distribution boundary: PASS (${names.length} files)`)
