import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApplicationHost } from '../src/application-host.js';
import { SearchSettingsStore } from '../src/search-settings.js';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';

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
    });
    assert.equal(keys.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
