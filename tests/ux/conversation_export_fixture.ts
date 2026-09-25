// Real desktop host, bridge and SQLite. Only the native file chooser/reveal UI is
// substituted; all paths are confined to a fresh temporary fixture directory.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import { dispatchDesktopRpc, safeDesktopFailure } from '../../apps/desktop/src/rpc-host.js';
import { startLocalWebHost } from '../../packages/client-bridge/src/local-web-host.js';
import { seedPublicationWorkspace } from '../fixtures/publication-workspace.js';
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../packages/client-bridge/src/protocol.js';

const root = mkdtempSync(join(tmpdir(), 'wa-export-browser-'));
const workspacePath = join(root, 'workspace');
seedPublicationWorkspace(workspacePath);
const desktop = new DesktopApplicationHost({ workspacePath, providerProfilePath: join(root, 'provider.json') });
await desktop.bridge.selectSession('publication-fixture', 'export-session');
const web = await startLocalWebHost({ staticRoot: resolve('apps/web/dist/production'), bridgeFactory: () => desktop.bridge });
const output = join(root, 'saved');
mkdirSync(output);
let choice = 'save';
let lastRevealed: string | null = null;
process.stdout.write(`${JSON.stringify({ origin: web.origin, root, protocolVersion: UI_BRIDGE_PROTOCOL_VERSION })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'stop') break;
  let response;
  try {
    if (request.method === 'testChoice') { choice = request.args[0]; response = { ok: true }; }
    else if (request.method === 'testReveal') response = { path: lastRevealed };
    else if (request.method === 'testChangeBody') {
      const body = desktop.bridge.getSnapshot().deliveryWorkspace.bodyVersionId!;
      await desktop.bridge.saveBody(body, '# 修改后的夜跑随想\n\n我想再调整一点。', 'browser negative case');
      response = { ok: true };
    } else if (request.method === 'savePublicationAs') {
      const result = await desktop.savePublicationAs(request.args[0], async name => choice === 'cancel' ? null
        : choice === 'invalid' ? join(workspacePath, name) : join(output, name));
      response = { ok: true, result, snapshot: desktop.bridge.getSnapshot() };
    } else if (request.method === 'revealPublication') {
      lastRevealed = desktop.publicationSavedPath(request.args[0]);
      response = { ok: true, result: null, snapshot: desktop.bridge.getSnapshot() };
    } else response = await dispatchDesktopRpc(desktop.bridge, request);
  } catch (error) { response = safeDesktopFailure(error); }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
await web.close(); desktop.close();
