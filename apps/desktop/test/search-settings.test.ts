import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApplicationHost } from '../src/application-host.js';
import { SearchSettingsStore } from '../src/search-settings.js';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import { createFactSearchTools } from '../../../packages/application/src/fact-search.js';

test('DeepSeek settings migrate disabled, keep a separate secret and verify only its fixed public probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-deepseek-settings-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const path = join(root, 'search-settings.json');
  const calls: string[] = [];
  try {
    writeFileSync(path, JSON.stringify({ parallelEnabled: true, tavilyEnabled: false }));
    const store = new SearchSettingsStore(path, credentials, { fetch: async url => { calls.push(String(url));
      return Response.json({ results: [{ url: 'https://example.com/date', summary: '1949年10月1日' }] }); } });
    assert.equal((await store.status()).deepseekEnabled, false);
    await assert.rejects(store.save({ parallelEnabled: false, tavilyEnabled: false, deepseekEnabled: true }), /SEARCH_API_KEY_REQUIRED/);
    const saved = await store.save({ parallelEnabled: false, tavilyEnabled: true, deepseekEnabled: true,
      deepseekApiKey: 'deepseek-private', tavilyApiKey: 'tavily-private' });
    assert.equal(saved.deepseekKeyConfigured, true); assert.equal(saved.verification?.deepseek, undefined);
    assert.doesNotMatch(readFileSync(path, 'utf8') + JSON.stringify(saved), /deepseek-private|tavily-private/);
    assert.equal(keys.size, 2);
    assert.equal((await store.verify('deepseek')).verification?.deepseek?.status, 'available');
    assert.deepEqual(calls, ['https://api.deepseek.com/v1/tools/search']);
    const changed = await store.save({ parallelEnabled: false, tavilyEnabled: true, deepseekEnabled: true, deepseekApiKey: 'new-deepseek' });
    assert.equal(changed.verification?.deepseek, undefined);
    await store.save({ parallelEnabled: true, tavilyEnabled: true });
    assert.equal(store.configuration().deepseekEnabled, true, 'an old client does not reset the new opt-in');
    assert.equal(await store.configuration().getDeepSeekKey?.(), 'new-deepseek');
    assert.equal(await store.configuration().getTavilyKey?.(), 'tavily-private');
    assert.equal((await new SearchSettingsStore(path, credentials).status()).verification?.deepseek, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed search-settings commit restores both independently updated keys and flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-two-key-rollback-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const path = join(root, 'search-settings.json');
  const store = new SearchSettingsStore(path, credentials);
  try {
    await store.save({ parallelEnabled: false, tavilyEnabled: true, deepseekEnabled: true,
      tavilyApiKey: 'old-tavily', deepseekApiKey: 'old-deepseek' });
    rmSync(path); mkdirSync(path);
    await assert.rejects(store.save({ parallelEnabled: true, tavilyEnabled: true, deepseekEnabled: true,
      tavilyApiKey: 'new-tavily', deepseekApiKey: 'new-deepseek' }));
    assert.equal(store.configuration().parallelEnabled, false);
    assert.deepEqual([...keys.values()].sort(), ['old-deepseek', 'old-tavily']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ['delete', 'restore'] as const) {
test(`one credential rollback ${failure} failure does not prevent remaining restoration or leak secrets`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-rollback-error-'));
  const keys = new Map<string, string>();
  class FailingRollbackBroker extends CredentialBroker {
    override async deleteManaged(id: string) {
      if (failure === 'delete' && id.startsWith('search-deepseek-')) throw new Error('backend exposed new-deepseek-secret');
      return await super.deleteManaged(id);
    }
    override async saveManaged(id: string, secret: string, persistence: 'system' | 'session') {
      if (failure === 'restore' && secret === 'old-deepseek-secret' && keys.get(id) === 'new-deepseek-secret')
        throw new Error('backend exposed old-deepseek-secret');
      return await super.saveManaged(id, secret, persistence);
    }
  }
  const credentials = new FailingRollbackBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const path = join(root, 'search-settings.json');
  const store = new SearchSettingsStore(path, credentials);
  try {
    await store.save({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: 'old-tavily-secret',
      ...(failure === 'restore' ? { deepseekEnabled: true, deepseekApiKey: 'old-deepseek-secret' } : {}) });
    rmSync(path); mkdirSync(path);
    let rejected: unknown;
    try {
      await store.save({ parallelEnabled: true, tavilyEnabled: true, deepseekEnabled: true,
        tavilyApiKey: 'new-tavily-secret', deepseekApiKey: 'new-deepseek-secret' });
    } catch (error) { rejected = error; }
    assert.equal(await store.configuration().getTavilyKey?.(), 'old-tavily-secret', 'other credentials must still be restored');
    assert.ok(rejected instanceof Error, 'incomplete rollback must not report success');
    assert.equal(rejected.message, 'SEARCH_SETTINGS_ROLLBACK_FAILED');
    assert.doesNotMatch(`${rejected.stack}${JSON.stringify(rejected)}`, /(?:new|old)-(?:deepseek|tavily)-secret|backend exposed/);
    assert.equal(store.configuration().parallelEnabled, false);
    assert.equal(store.configuration().deepseekEnabled, failure === 'restore');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
}

test('batch preferences persist independently including values below ten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-limit-'));
  const keys = new Map<string, string>();
  const credentials = new CredentialBroker({ systemBackend: { isAvailable: async () => true,
    read: async id => keys.get(id) ?? null, write: async (id, key) => { keys.set(id, key); }, delete: async id => { keys.delete(id); } } });
  const path = join(root, 'search-settings.json');
  try {
    writeFileSync(path, JSON.stringify({ parallelEnabled: false, tavilyEnabled: false, searchLimit: 6 }));
    const store = new SearchSettingsStore(path, credentials);
    const budgets = (settings: { researchSearchLimit?: number; supplementSearchLimit?: number; searchLimit?: number }) =>
      [settings.researchSearchLimit, settings.supplementSearchLimit, settings.searchLimit];
    assert.deepEqual(budgets(await store.status()), [10, 10, 6]);
    await store.save({ parallelEnabled: false, tavilyEnabled: true, researchSearchLimit: 2, supplementSearchLimit: 7, searchLimit: 1, tavilyApiKey: 'test-key' });
    assert.deepEqual(budgets(new SearchSettingsStore(path, credentials).configuration()), [2, 7, 1]);
    await store.save({ parallelEnabled: true, tavilyEnabled: true });
    assert.deepEqual(budgets(await store.status()), [2, 7, 1], 'older API clients must not reset saved custom limits');
    const before = readFileSync(path, 'utf8');
    for (const key of ['researchSearchLimit', 'supplementSearchLimit', 'searchLimit'] as const) {
      for (const value of [0, 31, 10.2, NaN]) await assert.rejects(store.save({
        parallelEnabled: false, tavilyEnabled: false, [key]: value, tavilyApiKey: 'replacement',
      }), /SEARCH_SETTINGS_INVALID/);
    }
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
    fetch: async () => { requests++; return Response.json({ results: [{ url: 'https://example.com/archive', content: '公开记录' }] }); } });
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
  let response = async () => Response.json({ results: [{ url: 'https://example.com/archive', content: '公开记录' }] });
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
    complete(Response.json({ results: [{ url: 'https://example.com/archive', content: '公开记录' }] }));
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
    if (String(url).includes('tavily')) return Response.json({ results: [{ url: 'https://example.com/archive', content: '公开记录' }] });
    if (String(url).includes('keenable')) return Response.json({ results: [{ url: 'https://example.com/archive', snippet: '公开记录' }] });
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2024-11-05' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ id: 2, result: { content: [{ type: 'text', text: 'public evidence https://example.com/archive' }] } });
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
    const keenable = await store.verify('keenable');
    assert.equal(keenable.verification?.keenable?.status, 'available');
    assert.equal(keenable.keenableEnabled, false);
    assert.equal(urls.at(-1), 'https://api.keenable.ai/v1/search/public');
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
    assert.equal((await host.searchStatus()).parallelEnabled, true);
    assert.equal((await host.searchStatus()).keenableEnabled, false);
    await assert.rejects(host.configureSearch({ parallelEnabled: false, tavilyEnabled: true }), /SEARCH_API_KEY_REQUIRED/);
    const status = await host.configureSearch({ parallelEnabled: true, keenableEnabled: true, tavilyEnabled: true, tavilyApiKey: 'test-secret-only' });
    assert.equal(status.keenableEnabled, true);
    assert.equal(status.tavilyKeyConfigured, true);
    assert.ok(!JSON.stringify(status).includes('test-secret-only'));
    assert.ok(!readFileSync(join(root, 'search-settings.json'), 'utf8').includes('test-secret-only'));
    await host.configureSearch({ parallelEnabled: false, tavilyEnabled: true, tavilyApiKey: '' });
    host.close(); host = new DesktopApplicationHost(options);
    assert.equal((await host.searchStatus()).tavilyEnabled, true);
    assert.equal((await host.searchStatus()).parallelEnabled, false);
    assert.equal((await host.searchStatus()).keenableEnabled, true);
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
      keenableEnabled: false,
      tavilyEnabled: true,
      deepseekEnabled: false,
      deepseekKeyConfigured: false,
      tavilyKeyConfigured: true,
      credentialPersistence: 'system',
      researchSearchLimit: 10,
      supplementSearchLimit: 10,
      searchLimit: 10,
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
      parallelEnabled: true,
      keenableEnabled: false,
      tavilyEnabled: false,
      deepseekEnabled: false,
      deepseekKeyConfigured: false,
      tavilyKeyConfigured: false,
      credentialPersistence: 'missing',
      researchSearchLimit: 10,
      supplementSearchLimit: 10,
      searchLimit: 10,
    });
    assert.equal(keys.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
