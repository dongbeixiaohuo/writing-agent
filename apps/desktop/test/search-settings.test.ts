import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApplicationHost } from '../src/application-host.js';
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
