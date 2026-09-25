import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { getPublicationCandidates, PUBLICATION_SELECTION_WAIT_REASON } from '../../packages/application/src/publication-choice.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';
import { startLocalWebHost } from '../../packages/client-bridge/src/local-web-host.js';

globalThis.fetch = async () => { throw new Error('FIXTURE_EXTERNAL_NETWORK_FORBIDDEN'); };
const parent = resolve('output/rc15-title-browser'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'workspace-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const actor = { kind: 'user' as const, id: 'fixture' };
const opening = '键盘被推到一边，桌角散着几张没人归档的需求单。他光脚踩在地毯上，整个人陷进椅背。这个开场段落不能当作标题。';
storage.createProject({ projectId: 'p', operationId: 'p', name: '标题交流测试', mode: 'quick', actor });
storage.saveWritingBrief({ projectId: 'p', operationId: 'brief', actor, expectedProjectRevision: storage.inspectProject('p')!.revision, baseVersionId: null,
  brief: { schemaVersion: 1, topic: '贡献不能换特权', genre: 'explanatory_analysis', audience: '普通读者', lengthTarget: { targetCharacters: 800 },
    materialIds: [], constraints: [], interactionMode: 'co_creation', authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
storage.commitArtifactVersion({ projectId: 'p', operationId: 'body', actor, expectedProjectRevision: storage.inspectProject('p')!.revision,
  kind: 'body', logicalKey: 'main', baseVersionId: null, content: `${opening}\n\n虚构示意场景，用于讨论自我要求。`, reason: 'fixture' });
const bodyId = storage.inspectProject('p')!.latestBodyVersionId!;
storage.commitArtifactVersion({ projectId: 'p', operationId: 'old', actor, expectedProjectRevision: storage.inspectProject('p')!.revision,
  kind: 'report', logicalKey: 'author-publication-candidates', baseVersionId: null, content: JSON.stringify({ bodyVersionId: bodyId,
    candidates: [{ title: opening, opening: null, distributionCopy: null, rationale: '旧版错误候选' }] }), reason: 'legacy fixture' });
storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:draft' });
storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'waiting-title', purpose: 'writing-pack:draft', planVersion: 'test', expectedBodyVersionId: bodyId });
storage.pauseRun({ projectId: 'p', runId: 'waiting-title', operationId: 'pause', reason: 'WRITING_INPUT_REQUIRED',
  payload: { reason: PUBLICATION_SELECTION_WAIT_REASON, questions: [`当前工作标题是「${opening}」。`], nextStage: 'fact_check' } });
class TitleProvider extends ModelProviderBase {
  batches = 0;
  constructor() { super('fixture-title', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    let name: string; let args: unknown;
    if (!request.messages[0]!.content.includes('ACTOR=title')) {
      name = 'delegate_author_expert'; args = { role: 'title', task: '按用户修改意见重新拟题，不修改正文' };
    } else if (!request.messages.some(m => m.role === 'tool' && m.name === 'propose_publication_choices')) {
      this.batches++;
      name = 'propose_publication_choices'; args = { candidates: (this.batches === 1
        ? ['功劳不是通行证', '被需要，不等于有特权', '别用贡献抵消标准'] : ['忙，也要守住标准', '把要求留给自己', '做好事，也做好自己'])
        .map(title => ({ title, opening: null, distributionCopy: null, rationale: '真实候选，供用户讨论；不替用户选择。' })) };
    } else { name = 'respond_author'; args = { reply: `第 ${this.batches} 组新标题已列在候选卡中，你可以继续提出意见，正文没有改动。` }; }
    yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const service = new WritingApplicationService({ storage, provider: new TitleProvider() });
const bridge = createApplicationBridge({ service, workspaceId: 'title-browser', initialProjectId: 'p',
  model: { model: 'fixture', parameters: {}, providerLabel: 'synthetic', credentialReference: 'synthetic' }, pollIntervalMs: 50 });
await bridge.selectSession('p', 'conversation');
const host = await startLocalWebHost({ staticRoot: resolve('apps/web/dist/production'), bridgeFactory: () => bridge });
console.log(JSON.stringify({ origin: host.origin, root }));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'stop') break;
  console.log(JSON.stringify({ bodyUnchanged: storage.inspectProject('p')!.latestBodyVersionId === bodyId,
    selectedTitle: storage.inspectProject('p')!.currentTitleVersionId, waiting: storage.getRun('waiting-title')!.status,
    candidates: getPublicationCandidates(storage, 'p'), runs: storage.listRuns('p').map(r => ({ id: r.id, status: r.status })) }));
}
await host.close(); bridge.dispose(); storage.close();
