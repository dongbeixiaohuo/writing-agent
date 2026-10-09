import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApplicationHost } from '../src/application-host.js';
import { SearchSettingsStore } from '../src/search-settings.js';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import { createFactSearchTools } from '../../../packages/application/src/fact-search.js';

test('search limit persists, old settings default to six, and invalid changes leave credentials and flags intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-limit-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const path = join(root, 'search-settings.json');
  try {
    writeFileSync(path, JSON.stringify({ parallelEnabled: false, tavilyEnabled: false }));
    const store = new SearchSettingsStore(path, credentials);
    assert.equal((await store.status()).searchLimit, 6);
    await store.save({ parallelEnabled: false, tavilyEnabled: true, searchLimit: 12, tavilyApiKey: 'test-key' });
    assert.equal(new SearchSettingsStore(path, credentials).configuration().searchLimit, 12);
    await store.save({ parallelEnabled: true, tavilyEnabled: true });
    assert.equal((await store.status()).searchLimit, 12, 'older API clients must not reset a saved custom limit');
    const before = readFileSync(path, 'utf8');
    for (const searchLimit of [0, 31, 1.2, NaN]) await assert.rejects(store.save({ parallelEnabled: false, tavilyEnabled: false, searchLimit, tavilyApiKey: 'replacement' }), /SEARCH_SETTINGS_INVALID/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual([...keys.values()], ['test-key']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saved search switches authorize repeated public searches without per-query dialogs; disabling stops egress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-auto-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const store = new SearchSettingsStore(join(root, 'search-settings.json'), credentials);
  let requests = 0;
  const scope = createFactSearchTools({ configuration: () => store.configuration(),
    fetch: async () => { requests++; return Response.json({ results: [] }); } });
  try {
    await store.save({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: 'synthetic-key' });
    for (const query of ['国庆节是哪天', '中华人民共和国成立年份']) {
      const result = await scope.search(query);
      assert.equal(result.mode, 'external');
      assert.equal(result.provider, 'tavily');
      assert.equal(result.authorizationMs, 0);
    }
    assert.equal(requests, 2);
    assert.equal((await scope.search('国庆节是哪天')).cacheHit, true);
    await store.save({ parallelEnabled: false, tavilyEnabled: false });
    assert.equal((await scope.search('国庆节是哪天')).mode, 'model_only');
    assert.equal(requests, 2);
    const main = readFileSync('apps/desktop/src/main.ts', 'utf8');
    assert.doesNotMatch(main, /searchApprovalOptions|authorizeFactSearchQuery/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed revalidation clears old availability; stale verification cannot green-light changed settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-health-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  let response = async () => Response.json({ results: [] });
  const store = new SearchSettingsStore(join(root, 'search-settings.json'), credentials, { fetch: async () => response() });
  try {
    await store.save({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: 'synthetic-key' });
    assert.equal((await store.verify('tavily')).verification?.tavily?.status, 'available');
    response = async () => new Response('private provider error text', { status: 401 });
    const failed = await store.verify('tavily');
    assert.equal(failed.verification?.tavily?.status, 'failed');
    assert.match(failed.verification!.tavily!.message, /SEARCH_HTTP_401/);
    assert.doesNotMatch(JSON.stringify(failed), /private provider|synthetic-key/);
    let dispatched!: () => void;
    const ready = new Promise<void>(resolve => { dispatched = resolve; });
    let complete!: (value: Response) => void;
    response = () => { dispatched(); return new Promise<Response>(resolve => { complete = resolve; }); };
    const pending = store.verify('tavily');
    await ready;
    await store.save({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: 'replacement' });
    complete(Response.json({ results: [] }));
    assert.notEqual((await pending).verification?.tavily?.status, 'available');
    await assert.rejects(store.verify('unknown' as never), /SEARCH_SETTINGS_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a saved key is not verified; each service is probed directly and key changes invalidate success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-verify-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const urls: string[] = [];
  const store = new SearchSettingsStore(join(root, 'search-settings.json'), credentials, { fetch: async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('tavily')) return Response.json({ results: [] });
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2024-11-05' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ id: 2, result: { content: [{ type: 'text', text: 'public evidence' }] } });
  } });
  try {
    const saved = await store.save({ parallelEnabled: true, tavilyEnabled: true, tavilyApiKey: 'synthetic-key' });
    assert.notEqual(saved.verification?.tavily?.status, 'available');
    const tavily = await store.verify('tavily');
    assert.equal(tavily.verification?.tavily?.status, 'available');
    assert.deepEqual(urls, ['https://api.tavily.com/search']);
    const parallel = await store.verify('parallel');
    assert.equal(parallel.verification?.parallel?.status, 'available');
    assert.equal(urls.filter(url => url.includes('parallel')).length, 3);
    assert.ok(!JSON.stringify(parallel).includes('synthetic-key'));
    const changed = await store.save({ parallelEnabled: true, tavilyEnabled: true, tavilyApiKey: 'replacement-key' });
    assert.notEqual(changed.verification?.tavily?.status, 'available');
    const reopened = new SearchSettingsStore(join(root, 'search-settings.json'), credentials);
    assert.notEqual((await reopened.status()).verification?.tavily?.status, 'available');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search settings persist toggles but never plaintext keys; blank key retains saved key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-settings-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const options = { workspacePath: root, providerProfilePath: join(root, 'provider.json'), credentials };
  let host = new DesktopApplicationHost(options);
  try {
    assert.equal(typeof host.searchStatus, 'function');
    assert.equal((await host.searchStatus()).parallelEnabled, false);
    await assert.rejects(host.configureSearch({ parallelEnabled: false, tavilyEnabled: true }), /SEARCH_API_KEY_REQUIRED/);
    const status = await host.configureSearch({ parallelEnabled: true, tavilyEnabled: true, tavilyApiKey: 'test-secret-only' });
    assert.equal(status.tavilyKeyConfigured, true);
    assert.ok(!JSON.stringify(status).includes('test-secret-only'));
    assert.ok(!readFileSync(join(root, 'search-settings.json'), 'utf8').includes('test-secret-only'));
    await host.configureSearch({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: '' });
    host.close(); host = new DesktopApplicationHost(options);
    assert.equal((await host.searchStatus()).tavilyEnabled, true);
    assert.equal((await host.searchStatus()).parallelEnabled, false);
    assert.equal((await host.searchStatus()).tavilyKeyConfigured, true);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed settings replacement restores the previous Tavily key and flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-settings-rollback-'));
  const settingsPath = join(root, 'search-settings.json');
  const oldKey = 'test-old-tavily-key';
  const newKey = 'test-new-tavily-key';
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  try {
    writeFileSync(settingsPath, JSON.stringify({ parallelEnabled: true, tavilyEnabled: true }), 'utf8');
    const store = new SearchSettingsStore(settingsPath, credentials);
    await store.save({ parallelEnabled: true, tavilyEnabled: true, tavilyApiKey: oldKey });
    rmSync(settingsPath);
    mkdirSync(settingsPath);

    await assert.rejects(
      store.save({ parallelEnabled: false, tavilyEnabled: false, tavilyApiKey: newKey }),
    );

    assert.deepEqual(await store.status(), {
      parallelEnabled: true,
      tavilyEnabled: true,
      tavilyKeyConfigured: true,
      credentialPersistence: 'system',
      searchLimit: 6,
    });
    assert.deepEqual([...keys.values()], [oldKey]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed first settings replacement removes the newly created Tavily key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-settings-new-key-rollback-'));
  const settingsPath = join(root, 'search-settings.json');
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  try {
    const store = new SearchSettingsStore(settingsPath, credentials);
    mkdirSync(settingsPath);

    await assert.rejects(
      store.save({ parallelEnabled: true, tavilyEnabled: true, tavilyApiKey: 'test-new-only-tavily-key' }),
    );

    assert.deepEqual(await store.status(), {
      parallelEnabled: false,
      tavilyEnabled: false,
      tavilyKeyConfigured: false,
      credentialPersistence: 'missing',
      searchLimit: 6,
    });
    assert.equal(keys.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
