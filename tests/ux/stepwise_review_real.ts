/** Isolated real specialist checks; preparation/director are deterministic fixtures. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';

const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, 'MiniMax-M3');
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
const requests: any[] = [];
class FixtureDirector extends ModelProviderBase {
  constructor() { super(real.id, real.adapterVersion, real.capabilities); }
  override capabilitiesFor(model: string) { return real.capabilitiesFor(model); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const raw = request.messages.find(m => m.role === 'user')?.content ?? '';
    const state = raw.includes('\nCOLLABORATION_STATE=') ? JSON.parse(raw.split('\nCOLLABORATION_STATE=')[1]!) : null;
    if (!state || ['review_editor', 'review_publish'].includes(state.actor)) {
      assert.ok(requests.length < 10, 'isolate validation limit');
      const sample: any = { actor: state?.actor ?? 'review_discussion', text: '', textDeltas: 0 };
      requests.push(sample); console.log(JSON.stringify({ request: requests.length, actor: sample.actor }));
      for await (const event of real.stream(request)) {
        if (event.type === 'text_delta') { sample.text += event.delta; sample.textDeltas++; }
        if (event.type === 'usage') sample.usage = event.usage;
        yield event;
      }
      return;
    }
    let name: string; let args: any;
    if (state.actor === 'director') {
      const read = request.messages.flatMap(m => m.role === 'tool' && m.name === 'read_artifact_version' ? [JSON.parse(m.content).result?.versionId] : []);
      const unread = state.unreadArtifactVersionIds.find((id: string) => !read.includes(id));
      name = !state.ready && unread ? 'read_artifact_version' : !state.ready ? 'assess_writing_readiness' : 'director_decide';
      args = name === 'read_artifact_version' ? { versionId: unread } : name === 'assess_writing_readiness'
        ? { status: 'ready', reason: '已确认非亲历的短篇观察，材料边界充分', questions: [] }
        : { action: 'dispatch', stage: state.nextStage, reason: '对这份短文只给本角色最重要的建议，不评价其他专家，不新增事实。', questions: [] };
    } else {
      name = 'submit_writing_stage';
      args = { stage: state.stage, content: state.stage === 'research' ? '{"claims":[],"notes":"纯粹个人表达，没有外部事实。"}'
        : '# 把安静留给自己\n\n有时候，你想要的不是更热闹的周末，而是能把手机放下的一小段时间。\n\n不必把这段时间变成新的任务。坐着，听一听窗外，也允许自己什么都没想明白。\n\n等你愿意时，再把手机拿起来。安静不是必须完成的功课。' };
      if (state.stage !== 'research') { yield { type: 'text_delta', delta: args.content }; yield { type: 'completed', finishReason: 'stop' }; return; }
    }
    yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const root = mkdtempSync(join(tmpdir(), 'writing-agent-stepwise-real-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const app = new WritingApplicationService({ storage, provider: new FixtureDirector() });
const actor = { kind: 'user', id: 'isolated-test' } as const;
const report: any = { root, status: 'FAIL', scope: 'real editor/discussion/publish; fixture director and preparation', requests };
try {
  app.createProject({ projectId: 'test', operationId: 'create', name: '逐位审校隔离验证', mode: 'deep', actor });
  const brief = app.saveWritingBrief({ projectId: 'test', operationId: 'brief', expectedProjectRevision: storage.inspectProject('test')!.revision, baseVersionId: null, actor,
    brief: { schemaVersion: 1, topic: '把安静留给自己', genre: 'narrative_observation', audience: '普通读者', lengthTarget: { targetCharacters: 200 }, materialIds: [], constraints: ['纯观察和感受，不编造亲历，不增加外部事实，保留结尾。'], interactionMode: 'co_creation', authorAuthorization: { voice: '克制', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: '微信公众号', publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  assert.ok(brief.ok);
  const input = { projectId: 'test', expectedProjectRevision: storage.inspectProject('test')!.revision, expectedBriefVersionId: storage.inspectProject('test')!.currentBriefVersionId!, model: config.model, parameters: { temperature: 0 }, budget: { maxModelRequests: 16, maxToolCalls: 24, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } };
  const first = await app.runDraft(input);
  const resume = (operationId: string) => app.resumeDraft({ ...input, sessionId: first.sessionId, runId: first.runId, operationId, decision: 'resume', userInstruction: 'ok', expectedProjectRevision: storage.inspectProject('test')!.revision }).result;
  await resume('confirm-outline'); await resume('confirm-draft');
  const waiting = () => storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1)?.payload.stage;
  assert.equal(waiting(), 'review_editor');
  const body = storage.inspectProject('test')!.latestBodyVersionId;
  const turn = await app.startAuthorTurn({ projectId: 'test', sessionId: first.sessionId, model: config.model, parameters: { temperature: 0 }, userInstruction: '结尾我想保留原样，别改正文。请简短解释你这一轮最重要的建议，我们先沟通，不进入下一位。' }).result;
  assert.ok(turn.ok, JSON.stringify(turn));
  assert.equal(waiting(), 'review_editor');
  assert.equal(storage.listArtifactVersions('test', 'review', `review_publish:${first.runId}`).length, 0);
  await resume('confirm-editor');
  assert.equal(waiting(), 'review_publish');
  assert.equal(storage.listArtifactVersions('test', 'review', `review_reader:${first.runId}`).length, 0);
  assert.equal(storage.inspectProject('test')!.latestBodyVersionId, body);
  report.reply = JSON.parse(storage.listArtifactVersions('test', 'report', `author-turn:${turn.runId}`).at(-1)!.content).reply;
  assert.doesNotMatch(report.reply, /请确认两点|你回[“"].*保存本轮|全部作废/);
  assert.match(report.reply, /明确认可后才交给发布审校专家/);
  report.status = 'PASS';
} finally {
  storage.close(); mkdirSync('output/stepwise', { recursive: true });
  writeFileSync('output/stepwise/real-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, requests: requests.length, root }));
}
