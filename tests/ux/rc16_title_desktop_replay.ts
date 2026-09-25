// Keep the full historical state: reconstructed minimal projects missed rc.15's failure.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import { dispatchDesktopRpc } from '../../apps/desktop/src/rpc-host.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../packages/client-bridge/src/protocol.js';
import { DesktopClientBridge } from '../../packages/client-bridge/src/desktop-bridge.js';

const [source, runId] = process.argv.slice(2);
if (!source || !runId) throw new Error('Specify the read-only source database and waiting run');
const parent = resolve('output/rc16-title-desktop'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'offline-'));
const workspacePath = join(root, 'workspace'); mkdirSync(join(workspacePath, '.writing-agent'), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
const run = db.prepare('SELECT project_id,session_id FROM runs WHERE id=?').get(runId)!;
await backup(db, join(workspacePath, '.writing-agent/workspace.sqlite3')); db.close();
class OfflineProvider extends ModelProviderBase {
  calls = 0;
  constructor() { super('offline', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.calls++;
    yield { type: 'error', error: { code: 'MODEL_UNSUPPORTED', message: 'Offline diagnostic stops before any external request', retryable: false } };
  }
}
const provider = new OfflineProvider();
globalThis.fetch = async () => { throw new Error('External network disabled'); };
const host = new DesktopApplicationHost({ workspacePath,
  providerProfilePath: join(process.env.APPDATA!, 'Writing Agent/provider.json'), providerFactory: () => provider,
  applicationVersion: 'rc16-isolated-diagnostic' });
const report: Record<string, unknown> = { workspacePath, originalProjectWrites: 0, realModelCalls: 0 };
const client = new DesktopClientBridge({
  async invoke(request) {
    if (request.method === 'resumeRun') report.feedbackReachedHost = Boolean((request.args[2] as { feedback?: string })?.feedback);
    const result = await dispatchDesktopRpc(host.bridge, request);
    if (!result.ok) report.rpcError = result.error;
    return result;
  },
  subscribe: listener => host.subscribe(listener),
});
try {
  await client.handshake();
  await client.selectSession(String(run.project_id), String(run.session_id));
  try {
    await client.resumeRun(runId, 'resume', { feedback: '这不是标题，请重新拟三个，正文不要改', operationId: 'reproduce-desktop-title' } as Parameters<typeof host.bridge.resumeRun>[2]);
    report.submissionAccepted = true;
  } catch (error) {
    report.submissionAccepted = false;
    report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  report.offlineProviderCalls = provider.calls;
} finally {
  client.dispose();
  host.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: join(root, 'result.json') }));
}
