import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'esbuild'
import { openWorkspaceStorage } from '../../packages/storage/src/index.js'
import { seedPublicationWorkspace } from '../fixtures/publication-workspace.js'

const source = resolve(process.env.WA_COMPILED_ROOT ?? '.')
const staging = mkdtempSync(join(tmpdir(), 'wa-native-requests-'))
const fixture = resolve('apps/desktop/test/fixtures/batch2-requests-electron.cjs')
const devElectron = createRequire(import.meta.url)('electron') as string
const binary = process.platform === 'win32' ? join(staging, 'runtime', basename(devElectron)) : devElectron

before(async () => {
  if (process.platform === 'win32') cpSync(dirname(devElectron), dirname(binary), { recursive: true })
  const compiled = join(source, 'apps/desktop/dist/package')
  cpSync(join(compiled, 'renderer'), join(staging, 'renderer'), { recursive: true })
  cpSync(join(compiled, 'preload.cjs'), join(staging, 'preload.cjs'))
  await build({ entryPoints: [join(source, 'apps/desktop/src/main.ts')], outfile: join(staging, 'main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent',
    plugins: [{ name: 'isolated-provider', setup(b) {
      b.onResolve({ filter: /runtime\/provider-config\/src\/index\.js$/ }, () => ({ path: 'isolated-provider', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: source, contents:
        'export * from "./packages/runtime/provider-config/src/index.ts"; export const createConfiguredProvider = () => globalThis.fixtureProvider;' }))
    } }] })
})
after(() => rmSync(staging, { recursive: true, force: true, maxRetries: 3 }))

const scenarios = { receipt: ['lost', 'reopened'], 'project-only': ['partial-lost', 'partial-reopened'], cancel: ['cancel'],
  'single-conversation': ['single-conversation'] }
for (const [scenario, phases] of Object.entries(scenarios)) test(`Electron desktop ${scenario} fault through composer, IPC and SQLite`, t => {
  const id = 'requests-' + randomUUID()
  const root = join(tmpdir(), 'writing-agent-desktop-test-' + id)
  mkdirSync(join(root, 'user-data'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  writeFileSync(join(root, 'user-data/provider.json'), JSON.stringify({
    schemaVersion: 3, activeProfileId: 'offline-test', profiles: [{
      id: 'offline-test', displayName: '离线测试', models: ['synthetic'], verifiedAt: '2026-11-01T00:00:00.000Z',
      config: { schemaVersion: 2, kind: 'openai_compatible', providerId: 'offline-test', model: 'synthetic',
        baseURL: 'https://example.invalid/v1', credentialRef: 'env:WA_SYNTHETIC_KEY', tools: 'supported', usage: 'unknown' },
    }],
  }))
  if (scenario === 'single-conversation') {
    const workspace = join(root, 'workspace')
    seedPublicationWorkspace(workspace)
    const storage = openWorkspaceStorage({ workspacePath: workspace })
    try {
      storage.createSession({ projectId: 'publication-fixture', sessionId: 'legacy-extra', purpose: 'writing-pack:author-conversation' })
    } finally { storage.close() }
  }
  for (const phase of phases) {
    const env: NodeJS.ProcessEnv = { ...process.env, WRITING_AGENT_DESKTOP_TEST: id, WA_SYNTHETIC_KEY: 'local-fixture',
      WA_REQUEST_PHASE: phase, WA_NATIVE_MAIN: join(staging, 'main.cjs') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.WRITING_AGENT_DESKTOP_SMOKE
    const child = spawnSync(binary, [fixture], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 })
    const path = join(root, phase + '.json')
    assert.ok(existsSync(path), child.stderr || child.error?.message)
    const result = JSON.parse(readFileSync(path, 'utf8'))
    t.diagnostic(JSON.stringify({ phase, ...result }))
    if (phase === 'lost' || phase === 'partial-lost') {
      assert.equal(result.error, undefined, JSON.stringify(result))
      assert.ok(child.signal === 'SIGKILL' || (child.status !== null && child.status !== 0), 'the original Electron process must be forcibly terminated')
    } else assert.equal(child.status, 0, JSON.stringify(result))
  }
})
