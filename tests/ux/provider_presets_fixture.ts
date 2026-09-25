// Real profile persistence + desktop input validation; synthetic credentials
// and connection result only. Never reads the user's profile or calls a model.
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import { parseDesktopProviderProfileInput } from '../../apps/desktop/src/provider-profile.js';
import { dispatchDesktopRpc, safeDesktopFailure } from '../../apps/desktop/src/rpc-host.js';
import { CredentialBroker } from '../../packages/runtime/credentials/src/index.js';
import { startLocalWebHost } from '../../packages/client-bridge/src/local-web-host.js';
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../packages/client-bridge/src/protocol.js';

const evidence = resolve('output/playwright/provider-presets');
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(evidence, 'workspace-'));
const values = new Map<string, string>();
const credentials = new CredentialBroker({ environment: {}, systemBackend: {
  isAvailable: async () => true, read: async id => values.get(id) ?? null,
  write: async (id, secret) => { values.set(id, secret); }, delete: async id => { values.delete(id); },
} });
globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN_IN_FIXTURE'); };
const profile = join(root, 'provider.json');
const desktop = new DesktopApplicationHost({ workspacePath: join(root, 'workspace'), providerProfilePath: profile, credentials });
const web = await startLocalWebHost({ staticRoot: resolve('apps/web/dist/production'), bridgeFactory: () => desktop.bridge });
let saves = 0;
let probes = 0;
let failProbe = false;
process.stdout.write(`${JSON.stringify({ origin: web.origin, root, protocolVersion: UI_BRIDGE_PROTOCOL_VERSION })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'stop') break;
  let response;
  try {
    if (request.method === 'testStats') response = { saves, probes, credentialCount: values.size };
    else if (request.method === 'testReadProfile') response = JSON.parse(readFileSync(profile, 'utf8'));
    else if (request.method === 'testFailProbe') { failProbe = true; response = { ok: true }; }
    else if (request.method === 'providerStatus') response = { ok: true, result: await desktop.providerStatus() };
    else if (request.method === 'configureProvider') {
      const result = await desktop.configureProvider(parseDesktopProviderProfileInput(request.args[0]));
      saves += 1;
      response = { ok: true, result };
    } else if (request.method === 'testProviderConnection') {
      probes += 1;
      const config = await desktop.providerStatus();
      response = { ok: true, result: failProbe ? {
        ok: false, provider: config.providerId, model: config.model, adapterVersion: 'fixture-only',
        stage: 'authentication', errorCode: 'AUTH_FAILED', retryable: false,
      } : { ok: true, provider: config.providerId, model: config.model, adapterVersion: 'fixture-only',
        streaming: 'supported', tools: 'supported', usage: 'reported' } };
    } else response = await dispatchDesktopRpc(desktop.bridge, request);
  } catch (error) { response = safeDesktopFailure(error); }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
await web.close(); desktop.close();
