// Synthetic provider only. Real storage/runtime/Bridge/UI; no credentials or API calls.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';
import { startLocalWebHost } from '../../packages/client-bridge/src/local-web-host.js';
import { ImmediateWorkflowProvider } from '../../packages/client-bridge/test/helpers/workflow-provider.js';
import type { ModelRequest, ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';

class BrowserIntakeProvider extends ImmediateWorkflowProvider {
  protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    if (!request.tools.some(tool => tool.name === 'respond_writing_intake')) { yield* super.providerStream(request); return; }
    if (request.messages.some(message => message.role === 'tool')) {
      yield { type: 'text_delta', delta: '交流已保存。' }; yield { type: 'completed', finishReason: 'stop' }; return;
    }
    const user = request.messages.find(message => message.role === 'user');
    const content = user?.role === 'user' ? user.content.split('当前用户消息（也已按原文保存）：').at(-1) ?? '' : '';
    const next = content.includes('换个方向')
      ? { reply: '可以换方向，旧方案先不执行。你想聚焦什么新的观察？', summary: '正在重新讨论方向，旧建议尚未确认。', questions: ['你想聚焦什么新的观察？'] }
      : content.includes('没想好')
        ? { reply: '我们可以先聊聊夜跑给你的感受。你更想写个人观察，还是分享实用经验？', summary: '想写夜跑，角度仍未知。', questions: ['你更想写个人观察，还是分享实用经验？'] }
        : { reply: '建议先写一篇夜跑观察：面向初学者，约 1200 字。读者和篇幅是建议值，我们一起逐步确认，不编造经历。', summary: '夜跑观察，建议面向初学者、约 1200 字。', questions: [],
          proposal: { brief: { topic: '夜跑观察', genre: 'practical_experience', audience: '初学者', targetCharacters: 1200, constraints: ['不编造经历'], voice: null, styleReference: null, platform: null, publicationGoal: 'not_applicable' }, assumptions: ['读者和篇幅为建议值'], sourceQuotes: [] } };
    yield { type: 'tool_call_delta', index: 0, id: `reply-${request.requestId}`, name: 'respond_writing_intake', argumentsDelta: JSON.stringify(next) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const workspacePath = mkdtempSync(join(tmpdir(), 'wa-cr003-browser-'));
const storage = openWorkspaceStorage({ workspacePath });
const service = new WritingApplicationService({ storage, provider: new BrowserIntakeProvider() });
const host = await startLocalWebHost({ staticRoot: resolve('apps/web/dist/production'),
  bridgeFactory: () => createApplicationBridge({ service, workspaceId: 'cr003-synthetic-browser',
    model: { model: 'synthetic-no-api', providerLabel: '合成验收', credentialReference: 'TEST_ONLY', parameters: {} } }) });
process.stdout.write(`${JSON.stringify({ origin: host.origin, workspacePath })}\n`);
await new Promise<void>(done => { process.stdin.resume(); process.stdin.once('data', () => done()); process.once('SIGTERM', done); });
await host.close(); storage.close();
