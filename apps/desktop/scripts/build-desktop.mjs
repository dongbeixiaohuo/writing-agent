import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { build } from 'esbuild'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = resolve(repositoryRoot, 'apps/desktop')
const stageRoot = resolve(desktopRoot, 'dist/package')
const rendererSource = resolve(repositoryRoot, 'apps/web/dist/production')
const rendererTarget = resolve(stageRoot, 'renderer')

async function copyRenderer(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.map')) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyRenderer(from, to)
    else await cp(from, to)
  }
}

async function allFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? allFiles(path) : [path]
  }))
  return nested.flat()
}

await rm(stageRoot, { recursive: true, force: true })
await mkdir(stageRoot, { recursive: true })

await Promise.all([
  build({
    entryPoints: [resolve(desktopRoot, 'src/main.ts')],
    outfile: resolve(stageRoot, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: false,
    minify: false,
    legalComments: 'none',
  }),
  build({
    entryPoints: [resolve(desktopRoot, 'src/preload.ts')],
    outfile: resolve(stageRoot, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: false,
    minify: false,
    legalComments: 'none',
  }),
  copyRenderer(rendererSource, rendererTarget),
])

const desktopPackage = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'))
await writeFile(resolve(stageRoot, 'package.json'), `${JSON.stringify({
  name: 'writing-agent-desktop',
  version: desktopPackage.version,
  productName: 'Writing Agent',
  description: 'Local-first Writing Agent desktop application',
  author: 'Writing Agent contributors',
  main: 'main.cjs',
  type: 'commonjs',
}, null, 2)}\n`, 'utf8')

for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await cp(resolve(repositoryRoot, file), resolve(stageRoot, file))
}

const manifest = {
  schemaVersion: 1,
  product: 'Writing Agent',
  version: desktopPackage.version,
  electron: '44.0.0',
  renderer: 'apps/web production build',
  runtime: 'bundled Writing Agent Application Service',
  excludes: ['DeepSeek Harness runtime', 'Claude Code', 'Python', 'Tauri', 'legacy App.tsx'],
}
await writeFile(resolve(stageRoot, 'SOURCE_AND_DEPENDENCY_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const stagedFiles = (await allFiles(stageRoot)).sort((left, right) => {
  const leftName = relative(stageRoot, left).split(sep).join('/')
  const rightName = relative(stageRoot, right).split(sep).join('/')
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
})
const checksumLines = await Promise.all(stagedFiles.map(async path => {
  const name = relative(stageRoot, path).split(sep).join('/')
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  return `${hash}  ${name}`
}))
await writeFile(resolve(stageRoot, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8')
