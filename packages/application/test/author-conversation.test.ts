import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import { buildExpertInstructions } from '../../writing-pack/src/expert-instructions.js';
import { savePublicationCandidates, choosePublicationCandidate, publicationSelectionIndex } from '../src/publication-choice.js';
import { withIntentFixture } from './intent-fixture.js';
import { getApprovedAuthorPreferences } from '../src/author-preferences.js';

class AuthorProvider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  constructor(readonly calls: { name: string; args: Record<string, unknown> }[]) {
    super('author-mock', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'reported' });
  }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const call = this.calls.shift();
    if (call) yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: call.name, argumentsDelta: JSON.stringify(call.args) };
    yield { type: 'completed', finishReason: call ? 'tool_calls' : 'stop' };
  }
}
it('asks which title after a general acknowledgement without repeating proposals or selecting for the author', async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '理解你的意思，已重拟三个。以下重复上一轮完整解释。' } }]);
  const f = setup(provider);
  try {
    f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:author-conversation' });
    f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'waiting-title', planVersion: 'test', purpose: 'writing-pack:draft' });
    f.storage.pauseRun({ projectId: 'p', runId: 'waiting-title', operationId: 'pause-title', reason: 'WRITING_INPUT_REQUIRED', payload: {
      kind: 'publication_selection', reason: '确认标题', nextStage: 'fact_check', questions: [] } });
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    savePublicationCandidates(f.storage, 'p', 'candidates', bodyId, ['窗边的安静', '留下片刻', '停一停'].map(title => ({title, opening: null, distributionCopy: null, rationale: '区别'})));
    const result = await f.service.startAuthorTurn({ ...input('ok了'), sessionId: 'conversation' }).result;
    assert.equal(result.ok, true);
    const saved = f.storage.listArtifactVersions('p', 'report', `author-turn:${result.runId}`).at(-1)!;
    const reply = JSON.parse(saved.content).reply;
    assert.match(reply, /哪一个/u);
    assert.match(reply, /确认.*核查/u);
    assert.doesNotMatch(reply, /已重拟|重复上一轮/u);
    assert.ok(reply.length < 180);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, bodyId);
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null);
    assert.equal(f.storage.getRun('waiting-title')!.status, 'waiting_user');
  } finally { f.close(); }
});

function setup(provider: AuthorProvider) {
  const directory = mkdtempSync(join(tmpdir(), 'author-conversation-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const service = new WritingApplicationService({ storage, provider: withIntentFixture(provider) });
  const actor = { kind: 'user', id: 'tester' } as const;
  storage.createProject({ projectId: 'p', operationId: 'project', name: '安静', mode: 'quick', actor });
  storage.saveWritingBrief({ operationId: 'brief', projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静', genre: 'narrative_observation', audience: '普通读者', lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: [], interactionMode: 'co_creation', authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  storage.commitArtifactVersion({ operationId: 'body', projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
    kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 安静\n\n第一段保留。\n\n第二段有点长，需要调整。', reason: '测试现稿', actor });
  return { storage, service, close() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const input = (userInstruction: string) => ({ projectId: 'p', sessionId: 'conversation', model: 'mock', parameters: {}, userInstruction });

it('corrects a text-only formal-check handoff using the available tool, never an unavailable reply tool', async () => {
  class TextThenHandoff extends AuthorProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      this.requests.push(structuredClone(request));
      if (this.requests.length === 1) {
        assert.equal(request.parameters.toolChoice, 'required');
        yield {type:'text_delta',delta:'先用文字结束。'}; yield {type:'completed',finishReason:'stop'}; return;
      }
      const correction = request.messages.at(-1)!.content;
      assert.match(correction, /request_author_fact_check/);
      assert.doesNotMatch(correction, /请调用 respond_author/);
      yield {type:'tool_call_delta',index:0,id:'handoff',name:'request_author_fact_check',argumentsDelta:'{}'};
      yield {type:'completed',finishReason:'tool_calls'};
    }
  }
  const provider=new TextThenHandoff([]); const f=setup(provider);
  try { const result=await f.service.startAuthorTurn(input('标题已确认，请继续核查当前稿件')).result; assert.equal(result.ok,true); assert.equal(provider.requests.length,2); }
  finally { f.close(); }
});

it('does not let a title selection delegate to an expert unable to save the required choice', async () => {
  const provider = new AuthorProvider([]);
  const f = setup(provider);
  try {
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const candidates = savePublicationCandidates(f.storage, 'p', 'choices', bodyId, [{title:'窗边',opening:null,distributionCopy:null,rationale:'意象'}]);
    provider.calls.push({name:'delegate_author_expert',args:{role:'fact_check',task:'核查'}},
      {name:'choose_publication',args:{candidateVersionId:candidates.id,index:1}},
      {name:'respond_author',args:{reply:'标题已确认，正文未改。'}});
    const result = await f.service.startAuthorTurn(input('1')).result;
    assert.equal(result.ok, true);
    assert.deepEqual(provider.requests[0]!.tools?.map(t=>t.name), ['choose_publication']);
    assert.equal(provider.requests.length, 2, 'selection saves its acknowledgement without another generative reply');
  } finally { f.close(); }
});

it('self-corrects a wrong candidateVersionId and defaults to the current candidates when omitted', () => {
  const provider = new AuthorProvider([]);
  const f = setup(provider);
  try {
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const candidates = savePublicationCandidates(f.storage, 'p', 'choices', bodyId, [{title:'窗边',opening:null,distributionCopy:null,rationale:'意象'}]);
    // Omitted id falls back to the current candidates version.
    const chosen = choosePublicationCandidate(f.storage, 'p', 'select-1', '1', undefined, 1);
    assert.equal(chosen.title, '窗边');
    // The salient body id is the classic wrong guess: the error must hand back the exact correction.
    const fresh = savePublicationCandidates(f.storage, 'p', 'choices-2', bodyId, [{title:'灯下',opening:null,distributionCopy:null,rationale:'对照'}]);
    assert.throws(
      () => choosePublicationCandidate(f.storage, 'p', 'select-2', '1', bodyId, 1),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /candidateVersionId 不匹配/u);
        assert.ok(message.includes(fresh.id), 'error must name the correct candidates id');
        assert.ok(message.includes('不是正文 id'), 'error must say what the wrong id actually was');
        return true;
      },
    );
    assert.ok(candidates.id !== fresh.id);
  } finally { f.close(); }
});

it('parses natural selection phrases the way users actually write them', () => {
  const provider = new AuthorProvider([]);
  const f = setup(provider);
  try {
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const saved = savePublicationCandidates(f.storage, 'p', 'choices', bodyId, [
      { title: '窗边', opening: null, distributionCopy: null, rationale: '一' },
      { title: '灯下', opening: null, distributionCopy: null, rationale: '二' },
    ]);
    for (const [phrase, expected] of [
      ['选择标题2', 2], ['确认标题2', 2], ['用标题2', 2], ['选标题二', 2],
      ['标题2', 2], ['标题第2条', 2],
      ['用第2条', 2], ['选第2条', 2], ['就用第2条', 2], ['第2条', 2], ['第2个', 2],
      ['2', 2], ['我就选第2个', 2], ['确认标题：《灯下》', 2],
    ] as const) {
      assert.equal(publicationSelectionIndex(phrase, saved), expected, phrase);
    }
    for (const phrase of ['说说标题2的问题', '标题2哪里好', '先聊聊第二条', 'ok']) {
      assert.equal(publicationSelectionIndex(phrase, saved), null, phrase);
    }
  } finally { f.close(); }
});

it('keeps an already chosen title after body correction without a second selection loop', async () => {
  const provider = new AuthorProvider([{name:'respond_author',args:{reply:'保留你已选的标题，不用再选。'}}]);
  const f = setup(provider);
  try {
    const project = f.storage.inspectProject('p')!;
    const candidates = savePublicationCandidates(f.storage, 'p', 'choices', project.latestBodyVersionId!, [{title:'窗边',opening:null,distributionCopy:null,rationale:'意象'}]);
    choosePublicationCandidate(f.storage, 'p', 'select', '1', candidates.id, 1);
    f.storage.commitArtifactVersion({operationId:'correction',projectId:'p',expectedProjectRevision:f.storage.inspectProject('p')!.revision,
      kind:'body',logicalKey:'main',baseVersionId:project.latestBodyVersionId,content:'# 安静\n\n删去未经授权的细节。',reason:'workflow:central_revision',actor:{kind:'agent',id:'central_revision',runId:'correction'}});
    const result = await f.service.startAuthorTurn(input('1')).result;
    assert.equal(result.ok, true);
    assert.equal(provider.requests.length, 1);
    assert.equal(f.storage.listArtifactVersions('p','title','main').length, 1);
    assert.notEqual(f.storage.getFactCheckStatus('p').status, 'passed');
  } finally { f.close(); }
});

it('preserves an explicit title choice after a body edit instead of discarding the author decision', () => {
  const f = setup(new AuthorProvider([]));
  try {
    const oldBody = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const candidates = savePublicationCandidates(f.storage, 'p', 'choices', oldBody,
      [{ title: '窗边的安静', opening: null, distributionCopy: '留下一刻安静。', rationale: '观察' }]);
    const saved = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'edit-body', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: oldBody, content: '# 安静\n\n修订后的文章。', reason: 'author edit', actor: { kind: 'user', id: 'u' } });
    assert.equal(saved.ok, true);
    const currentBody = f.storage.inspectProject('p')!.latestBodyVersionId;
    const choice = choosePublicationCandidate(f.storage, 'p', 'choose-edited', '窗边的安静', candidates.id, 1,
      { sourceQuote: '窗边的安静', candidateVersionId: candidates.id, index: 1 });
    assert.equal(choice.title, '窗边的安静');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, currentBody);
    assert.equal(f.storage.listArtifactVersions('p', 'report', 'author-publication-candidates').length, 1);
    assert.notEqual(f.storage.getFactCheckStatus('p').status, 'passed');
  } finally { f.close(); }
});

for (const freshBatch of [false, true]) it(`hands a title selected after manual editing to current-body fact check, not the obsolete writing run (freshBatch=${freshBatch})`, async () => {
  class SelectionThenCheck extends AuthorProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (request.tools?.some(t => t.name === 'choose_publication')) { yield* super.providerStream(request); return; }
      this.requests.push(structuredClone(request));
      yield { type: 'error', error: { code: 'PROVIDER_UNAVAILABLE', message: 'TEST_CHECK_BOUNDARY: stop after observing the independent fact-check request', retryable: false } };
    }
  }
  const provider = new SelectionThenCheck([{ name: 'choose_publication', args: { index: 1 } }]), f = setup(provider);
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'edited-title', initialProjectId: 'p', model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: null } });
  try {
    f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:draft' });
    f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'old-writing', planVersion: 'test', purpose: 'writing-pack:draft' });
    f.storage.pauseRun({ projectId: 'p', runId: 'old-writing', operationId: 'wait-title', reason: 'WRITING_INPUT_REQUIRED', payload: { kind: 'publication_selection', reason: '确认标题', nextStage: 'fact_check', questions: [] } });
    f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'old-language', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: f.storage.inspectProject('p')!.latestBodyVersionId, content: '# 安静\n\n旧润色稿。', reason: 'workflow:language_review', actor: { kind: 'agent', id: 'language_review', runId: 'old-writing' } });
    const oldBody = f.storage.inspectProject('p')!.latestBodyVersionId!;
    savePublicationCandidates(f.storage, 'p', 'choices', oldBody, [{ title: '窗边', opening: null, distributionCopy: null, rationale: '观察' }]);
    f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'manual-edit', expectedProjectRevision: f.storage.inspectProject('p')!.revision, kind: 'body', logicalKey: 'main', baseVersionId: oldBody,
      content: '# 安静\n\n我喜欢窗边。', reason: 'user edit', actor: { kind: 'user', id: 'u' } });
    const currentBody = f.storage.inspectProject('p')!.latestBodyVersionId;
    if (freshBatch) savePublicationCandidates(f.storage, 'p', 'fresh-choices', currentBody!, [{ title: '窗边', opening: null, distributionCopy: null, rationale: '新稿观察' }]);
    f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'evidence', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'evidence', logicalKey: 'main', baseVersionId: null, content: JSON.stringify({ claims: [], notes: '作者的主观感受' }), reason: 'fixture', actor: { kind: 'user', id: 'u' } });
    await bridge.selectSession('p', 'conversation');
    await bridge.sendMessage('就用第一个吧');
    const deadline = Date.now() + 5000;
    while (f.storage.getRun('old-writing')?.status !== 'cancelled') {
      assert.ok(Date.now() < deadline, 'must hand off instead of asking for another title selection');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, currentBody);
    assert.equal(f.storage.listArtifactVersions('p', 'title', 'main').length, 1);
    assert.ok(provider.requests.some(r => JSON.stringify(r.messages).includes(currentBody!)));
    assert.equal(f.storage.listArtifactVersions('p', 'report', 'author-publication-candidates').length, freshBatch ? 2 : 1);
  } finally { bridge.dispose(); f.close(); }
});

it('keeps review objections with the current expert and leaves the original handoff waiting', async () => {
  class PlainReviewDiscussion extends AuthorProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      this.requests.push(structuredClone(request));
      yield { type: 'text_delta', delta: '第二条可以保留原写法。这是更新后的建议，还没有交给下一位专家。要不要进入下一位？' };
      yield { type: 'completed', finishReason: 'stop' };
    }
  }
  const provider = new PlainReviewDiscussion([]);
  const f = setup(provider);
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'review-discussion', model: { model: 'mock', providerLabel: 'mock', parameters: {}, credentialReference: null } });
  try {
    f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:draft' });
    f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'review-wait', planVersion: 'test', purpose: 'writing-pack:draft' });
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    f.storage.commitArtifactVersion({ operationId: 'editor-opinion', projectId: 'p', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'review', logicalKey: 'review_editor:review-wait', baseVersionId: null,
      content: JSON.stringify({ content: '第二条建议缩短开头。', bodyVersionId: before, reviewType: 'review_editor' }), reason: 'review', actor: { kind: 'agent', id: 'review_editor', runId: 'review-wait' } });
    f.storage.pauseRun({ projectId: 'p', runId: 'review-wait', operationId: 'wait-editor', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'review_editor', nextStage: 'review_publish' } });
    await bridge.selectSession('p', 'conversation');
    const result = await bridge.sendMessage('第二条不改，为什么要删开头？');
    const deadline = Date.now() + 5000;
    while (f.storage.getRun(result.runId)?.status === 'running') {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.storage.getRun(result.runId)?.status, 'completed');
    assert.equal(provider.requests.length, 1, 'harness saves a complete discussion without asking the model to serialize it again');
    assert.match(provider.requests[0]!.messages[0]!.content, /ACTOR=review_editor/);
    assert.match(JSON.stringify(provider.requests[0]!.messages), /第二条建议缩短开头/);
    assert.ok(!provider.requests[0]!.tools?.some(t => ['director_decide', 'propose_author_revision', 'delegate_author_expert'].includes(t.name)));
    assert.equal(f.storage.getRun('review-wait')?.status, 'waiting_user');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
    await bridge.refresh();
    const reply = bridge.getSnapshot().timelineBySession.conversation!.find(item => item.kind === 'message' && item.body.includes('第二条可以保留'));
    assert.equal(reply?.kind === 'message' ? reply.stage : null, 'review_editor');
    assert.ok(reply?.kind === 'message');
    assert.doesNotMatch(reply.body, /要不要进入下一位/);
    assert.equal((reply.body.match(/明确认可后才交给/g) ?? []).length, 1);
  } finally { bridge.dispose(); f.close(); }
});

it('streams an author discussion before saving without changing the current manuscript', async () => {
  let release!: () => void;
  let emitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { emitted = resolve; });
  class StreamingAuthor extends AuthorProvider {
    protected override async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'text_delta', delta: '可以先比较两个角度。' };
      emitted(); await gate;
      yield { type: 'tool_call_delta', index: 0, id: 'save', name: 'respond_author', argumentsDelta: JSON.stringify({ reply: '可以先比较两个角度。正文暂时不改。' }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const f = setup(new StreamingAuthor([]));
  let handle: ReturnType<typeof f.service.startAuthorTurn> | undefined;
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    handle = f.service.startAuthorTurn(input('正文别改，先讨论两个角度'));
    await first;
    assert.equal(f.service.getLiveReply('p', 'conversation', handle.runId)?.text, '可以先比较两个角度。');
    assert.equal(f.storage.listArtifactVersions('p', 'report', `author-turn:${handle.runId}`).length, 0);
    release(); assert.equal((await handle.result).ok, true);
    assert.equal(f.service.getLiveReply('p', 'conversation', handle.runId), null);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
  } finally { release(); await handle?.result; f.close(); }
});

it('can save supplementary material during a review discussion without treating its compound approval as handoff', async () => {
  class ReviewMaterialProvider extends AuthorProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      this.requests.push(request);
      if (this.requests.length === 1) {
        assert.ok(request.tools?.some(tool => tool.name === 'attach_author_material'));
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'attach_author_material',
          argumentsDelta: JSON.stringify({ name: '补充观察', role: 'illustrative' }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: '补充材料已保存。先核对它对当前建议的影响，再确认交接。' };
        yield { type: 'completed', finishReason: 'stop' };
      }
    }
  }
  const f = setup(new ReviewMaterialProvider([]));
  try {
    f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:draft' });
    f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'review-wait', planVersion: 'test', purpose: 'writing-pack:draft' });
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId;
    f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'review', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'review', logicalKey: 'review_editor:review-wait', baseVersionId: null,
      content: JSON.stringify({ content: '开头可更具体。', bodyVersionId: bodyId, reviewType: 'review_editor' }),
      reason: 'review', actor: { kind: 'agent', id: 'review_editor', runId: 'review-wait' } });
    f.storage.pauseRun({ projectId: 'p', runId: 'review-wait', operationId: 'pause', reason: 'CO_CREATION_CHECKPOINT',
      payload: { stage: 'review_editor', nextStage: 'review_publish' } });
    const message = '可以，顺便把这句存为参考材料：窗边的夜景。先记下来再继续。';
    const result = await f.service.startAuthorTurn(input(message)).result;
    assert.equal(result.ok, true);
    const material = f.storage.listMaterials('p').find(m => m.displayName === '补充观察');
    assert.equal(material?.content, message);
    assert.ok(f.storage.getWritingBriefVersion(f.storage.inspectProject('p')!.currentBriefVersionId!)?.brief.materialIds.includes(material!.id));
    assert.equal(f.storage.getRun('review-wait')?.status, 'waiting_user');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, bodyId);
  } finally { f.close(); }
});

for (const entry of ['checkpoint', 'composer'] as const) it(`keeps natural title feedback conversational through ${entry}, without resuming fact check`, async () => {
  const feedback = entry === 'checkpoint' ? '这是工作标题吗？完全不像适合可以吸引人的标题' : '不行，换一批';
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '这段是开场，不适合作为标题。我们可以重新讨论方向，正文不会改动。' } }]);
  const f = setup(provider);
  f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:draft' });
  f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'waiting-title', planVersion: 'test', purpose: 'writing-pack:draft' });
  f.storage.pauseRun({ projectId: 'p', runId: 'waiting-title', operationId: 'pause-title', reason: 'WRITING_INPUT_REQUIRED', payload: {
    reason: '正文已润色，正式核查前还需要确认发布标题。当前标题只是候选，不代表你已选择。',
    nextStage: 'fact_check', questions: ['旧版本错误地要求确认正文开场。'],
  } });
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'title-feedback', initialProjectId: 'p',
    model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: 'test' }, pollIntervalMs: 10 });
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    await bridge.selectSession('p', 'conversation');
    if (entry === 'checkpoint') await bridge.resumeRun('waiting-title', 'resume', { feedback, operationId: 'feedback' });
    else await bridge.sendMessage(feedback, { operationId: 'feedback' });
    for (let n = 0; n < 100 && !f.storage.listRuns('p').some(run => run.id !== 'waiting-title' && run.status === 'completed'); n++) await new Promise(resolve => setTimeout(resolve, 10));
    const authorRun = f.storage.listRuns('p').find(run => run.id !== 'waiting-title');
    assert.ok(authorRun, 'feedback must create a bounded author turn');
    assert.equal(authorRun.status, 'completed');
    assert.equal(f.storage.listRunEvents(authorRun.id).find(e => e.type === 'run.started')?.payload.displayInstruction, feedback);
    assert.equal(f.storage.getRun('waiting-title')!.status, 'waiting_user');
    assert.equal(f.storage.listRunEvents('waiting-title').some(e => e.type === 'run.resumed'), false);
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
    assert.match(provider.requests[0]!.messages[1]!.content, /pendingPublicationSelection/u);
  } finally { bridge.dispose(); f.close(); }
});

for (const unknown of [false, true]) it(`retries an interrupted author conversation without turning it into full writing (unknown: ${unknown})`, async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '这里只讨论第二段的节奏，正文没有变化。' } }]);
  const f = setup(provider);
  f.storage.createSession({ projectId: 'p', sessionId: 'conversation', purpose: 'writing-pack:author-conversation' });
  f.storage.startRun({ projectId: 'p', sessionId: 'conversation', runId: 'lost-author', purpose: 'writing-pack:author-conversation',
    displayInstruction: '先别改稿，讨论第二段的节奏', planVersion: 'test' });
  if (unknown) f.storage.pauseRun({ projectId: 'p', runId: 'lost-author', operationId: 'pause', reason: 'UNKNOWN_EXTERNAL_OUTCOME' });
  f.service.recoverWorkspace();
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'test', initialProjectId: 'p',
    model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: 'test' }, pollIntervalMs: 10 });
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    await bridge.selectSession('p', 'conversation');
    if (unknown) await assert.rejects(bridge.resumeRun('lost-author', 'resume'), /UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION/u);
    await bridge.resumeRun('lost-author', unknown ? 'retry_unknown' : 'resume');
    for (let n = 0; n < 100 && !f.storage.listRuns('p').some(run => run.id !== 'lost-author' && run.status === 'completed'); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.storage.getRun('lost-author')!.status, 'cancelled');
    const retry = f.storage.listRuns('p').find(run => run.id !== 'lost-author')!;
    assert.equal(retry.status, 'completed');
    assert.equal(f.storage.listRunEvents(retry.id).find(event => event.type === 'run.started')?.payload.purpose, 'writing-pack:author-conversation');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
  } finally { bridge.dispose(); f.close(); }
});

it('routes ordinary main-conversation feedback to author collaboration and renders the saved reply', async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '这里只讨论，不改正文。' } }]);
  const f = setup(provider);
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'test', initialProjectId: 'p',
    model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: 'test' }, pollIntervalMs: 10 });
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    const started = await bridge.sendMessage('先别修改，解释第二段的思路');
    for (let n = 0; n < 100 && ['created', 'running'].includes(f.storage.getRun(started.runId)!.status); n++) await new Promise(resolve => setTimeout(resolve, 10));
    bridge.refresh();
    assert.equal(f.storage.listRunEvents(started.runId).find(e => e.type === 'run.started')?.payload.purpose, 'writing-pack:author-conversation');
    assert.equal(f.storage.getRun(started.runId)!.status, 'completed');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
    assert.match(JSON.stringify(bridge.getSnapshot().timelineBySession), /这里只讨论，不改正文/u);
    assert.doesNotMatch(JSON.stringify(bridge.getSnapshot().timelineBySession), /尚未达到交付条件/u);
  } finally { bridge.dispose(); f.close(); }
});

it('discusses the saved article without starting a writing workflow or changing the body', async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '可以先讨论，第二段主要是节奏问题。' } }]);
  const f = setup(provider);
  try {
    assert.equal(typeof f.service.startAuthorTurn, 'function', 'requires a dedicated bounded author conversation, not startDraft');
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    const result = await f.service.startAuthorTurn(input('先别改稿，讨论第二段为什么拖沓')).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
    assert.equal(f.storage.listRunEvents(result.runId).some(e => (e.payload.result as any)?.toolName === 'submit_writing_stage'), false);
    assert.match(provider.requests[0]!.messages[1]!.content, /第二段有点长/u);
  } finally { f.close(); }
});

it('persists completed conversations into the next turn including earlier alternatives', async () => {
  const provider = new AuthorProvider([
    { name: 'respond_author', args: { reply: '方案一：夜色。方案二：窗边。' } },
    { name: 'respond_author', args: { reply: '按窗边这个方向进一步讨论。' } },
  ]);
  const f = setup(provider);
  try {
    assert.equal(typeof f.service.startAuthorTurn, 'function');
    assert.equal((await f.service.startAuthorTurn(input('给两个开头方案')).result).ok, true);
    assert.equal((await f.service.startAuthorTurn(input('接着第二个方案聊')).result).ok, true);
    assert.match(provider.requests.at(-1)!.messages[1]!.content, /方案二：窗边/u);
    assert.match(provider.requests.at(-1)!.messages[1]!.content, /给两个开头方案/u);
  } finally { f.close(); }
});

it('only offers web reading for exact HTTPS links supplied by this user, never model-invented links', async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '已了解你的链接要求。' } },
    { name: 'respond_author', args: { reply: '继续讨论。' } }]);
  const f = setup(provider);
  try {
    await f.service.startAuthorTurn(input('请阅读 https://example.com/article 再讨论')).result;
    assert.ok(provider.requests[0]!.tools?.some(t => t.name === 'read_author_web'));
    await f.service.startAuthorTurn(input('先讨论，暂不联网')).result;
    assert.equal(provider.requests.at(-1)!.tools?.some(t => t.name === 'read_author_web'), false);
  } finally { f.close(); }
});

it('attaches the exact supplementary user message as untrusted material, without model-invented content', async () => {
  const provider = new AuthorProvider([
    { name: 'attach_author_material', args: { name: '新增来源', role: 'illustrative' } },
    { name: 'respond_author', args: { reply: '补充材料已保存，下次写作会读取，尚不代表事实已核实。' } },
  ]);
  const f = setup(provider);
  try {
    const message = '补充材料：来源原文写明试验仅有五人参加，请保留这个边界。';
    assert.equal((await f.service.startAuthorTurn(input(message)).result).ok, true);
    const material = f.storage.listMaterials('p')[0]!;
    assert.equal(material.content, message);
    assert.equal(material.trustLabel, 'user_provided_untrusted');
    const brief = f.storage.getWritingBriefVersion(f.storage.inspectProject('p')!.currentBriefVersionId!)!.brief;
    assert.ok(brief.materialIds.includes(material.id));
  } finally { f.close(); }
});

it('delegates a scoped expert without inheriting the director tool transcript', async () => {
  const provider = new AuthorProvider([
    { name: 'delegate_author_expert', args: { role: 'title', task: '给三个标题并说明承诺差异' } },
    { name: 'propose_publication_choices', args: { candidates: [{ title: '安静', opening: null, distributionCopy: null, rationale: '保留作者声音' }] } },
    { name: 'respond_author', args: { reply: '三个标题方案，等待你选择。' } },
  ]);
  const f = setup(provider);
  try {
    assert.equal(typeof f.service.startAuthorTurn, 'function');
    assert.equal((await f.service.startAuthorTurn(input('给三个不同标题，我来选')).result).ok, true);
    const expert = provider.requests[1]!;
    assert.match(expert.messages[0]!.content, /ACTOR=title/u);
    assert.ok(expert.messages[0]!.content.includes(buildExpertInstructions('title')), 'actual request must contain migrated title expertise');
    assert.equal(expert.messages.some(m => m.role === 'tool'), false);
    assert.equal(expert.tools?.some(t => t.name === 'delegate_author_expert'), false);
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null);
  } finally { f.close(); }
});

it('creates a model patch proposal without applying it and retains untouched paragraphs after acceptance', async () => {
  const provider = new AuthorProvider([]);
  const f = setup(provider);
  try {
    assert.equal(typeof f.service.startAuthorTurn, 'function');
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const block = f.storage.getBodyDocument(bodyId)!.blocks.at(-1)!;
    provider.calls.push({ name: 'delegate_author_expert', args: { role: 'central_revision', task: '只压缩第二段，保留其他段落' } },
      { name: 'propose_author_revision', args: { edits: [{ blockId: block.id, content: '第二段简洁。' }] } },
      { name: 'respond_author', args: { reply: '已生成第二段的修改建议，请查看差异后接受。' } });
    assert.equal((await f.service.startAuthorTurn(input('只把第二段缩短，其他内容别动')).result).ok, true);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, bodyId);
    const proposal = f.storage.listRevisionProposals('p')[0]!;
    assert.equal(proposal.edits.length, 1);
    const accepted = f.storage.acceptRevisionProposal({ operationId: 'accept', projectId: 'p', expectedProjectRevision: f.storage.inspectProject('p')!.revision, proposalId: proposal.id, actor: { kind: 'user', id: 'tester' } });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const content = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.latestBodyVersionId!)!.content;
    assert.match(content, /第一段保留。/u);
    assert.match(content, /第二段简洁。/u);
  } finally { f.close(); }
});

it('persists title alternatives, then binds an explicit user choice without changing body paragraphs', async () => {
  const provider = new AuthorProvider([
    { name: 'delegate_author_expert', args: { role: 'title', task: '比较两种标题' } },
    { name: 'propose_publication_choices', args: { candidates: [
      { title: '安静', opening: null, distributionCopy: null, rationale: '保留原题' },
      { title: '窗边', opening: null, distributionCopy: '看看日常的另一面。', rationale: '具体意象' },
    ] } }, { name: 'respond_author', args: { reply: '1. 安静。2. 窗边；分发文案：看看日常的另一面。请选择。' } },
  ]);
  const f = setup(provider);
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    assert.equal((await f.service.startAuthorTurn(input('给我两个标题，我来选')).result).ok, true);
    const candidate = f.storage.listArtifactVersions('p', 'report', 'author-publication-candidates').at(-1)!;
    provider.calls.push({ name: 'choose_publication', args: { candidateVersionId: candidate.id, index: 2 } },
      { name: 'respond_author', args: { reply: '已采用第二个标题及其分发文案，正文未变，需要重新核查。' } });
    assert.equal((await f.service.startAuthorTurn(input('我选第二个，正文别动')).result).ok, true);
    const title = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.currentTitleVersionId!)!;
    assert.match(title.content, /最终标题：「窗边」/u);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
  } finally { f.close(); }
});

it('queues a formal fact check as an explicit scoped handoff, not a full-writing run', async () => {
  const provider = new AuthorProvider([
    { name: 'respond_author', args: { reply: '核查已经通过。' } },
    { name: 'request_author_fact_check', args: {} },
  ]);
  const f = setup(provider);
  try {
    const before = f.storage.inspectProject('p')!.latestBodyVersionId;
    const result = await f.service.startAuthorTurn(input('正文别动，只重新做一次事实核查')).result;
    assert.equal(result.ok, true);
    const report = JSON.parse(f.storage.listArtifactVersions('p', 'report', `author-turn:${result.runId}`)[0]!.content);
    assert.equal(report.requestedAction, 'fact_check');
    assert.equal(provider.requests.length, 2, 'a prose claim cannot replace the formal fact-check handoff');
    assert.doesNotMatch(report.reply, /核查已经通过/u);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, before);
  } finally { f.close(); }
});

for (const instruction of ['给我一个标题候选', '这不像标题，是正文开场。请重新拟一个简洁、能吸引人的标题，并说明区别；只讨论标题，正文不要改，不要替我选择。']) it(`rejects prose-only title candidates before saving the actual alternatives: ${instruction}`, async () => {
  const provider = new AuthorProvider([
    { name: 'respond_author', args: { reply: '标题候选已保存：窗边。' } },
    { name: 'delegate_author_expert', args: { role: 'title', task: '给出并保存标题候选' } },
    { name: 'propose_publication_choices', args: { candidates: [{ title: '窗边', opening: null, distributionCopy: null, rationale: '具体意象' }] } },
    { name: 'respond_author', args: { reply: '候选：窗边。请选择或提出调整。' } },
  ]);
  const f = setup(provider);
  try {
    const result = await f.service.startAuthorTurn(input(instruction)).result;
    assert.equal(result.ok, true);
    assert.equal(provider.requests.length, 4);
    assert.equal(f.storage.listArtifactVersions('p', 'report', 'author-publication-candidates').length, 1);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `author-turn:${result.runId}`).length, 1);
  } finally { f.close(); }
});

for (const question of ['先讨论这个标题方案哪里不好，不要生成新的', '请解释配图方案的作用，先不要策划配图', '如何策划配图？只解释方法']) it(`does not force artifact creation for a discussion: ${question}`, async () => {
  const provider = new AuthorProvider([{ name: 'respond_author', args: { reply: '这里先解释思路，不生成新的方案。' } }]);
  const f = setup(provider);
  try {
    assert.equal((await f.service.startAuthorTurn(input(question)).result).ok, true);
    assert.equal(provider.requests.length, 1);
    assert.equal(f.storage.listArtifactVersions('p', 'report', 'author-publication-candidates').length, 0);
    assert.equal(f.storage.listArtifactVersions('p', 'report', 'author-illustration-plan').length, 0);
  } finally { f.close(); }
});

for (const question of ['只解释第二段为什么拖沓，不要执行专项核查', '请解释一下事实核查怎么做，不要执行']) it(`does not grant formal fact-check handoff for discussion: ${question}`, async () => {
  const provider = new AuthorProvider([{ name: 'request_author_fact_check', args: {} }, { name: 'respond_author', args: { reply: '这里只讨论。' } }]);
  const f = setup(provider);
  try {
    const result = await f.service.startAuthorTurn(input(question)).result;
    assert.equal(provider.requests[0]!.tools?.some(t => t.name === 'request_author_fact_check'), false);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `author-turn:${result.runId}`).some(report => JSON.parse(report.content).requestedAction === 'fact_check'), false);
  } finally { f.close(); }
});

it('offers full-writing handoff only for an explicit full-writing request, never a scoped edit', async () => {
  const provider = new AuthorProvider([{ name: 'request_author_full_writing', args: {} }, { name: 'respond_author', args: { reply: '只准备第二段的修改建议。' } }]);
  const f = setup(provider);
  try {
    const result = await f.service.startAuthorTurn(input('请根据当前材料生成一份完整稿件')).result;
    assert.equal(result.ok, true);
    assert.match(f.storage.listArtifactVersions('p', 'report', `author-turn:${result.runId}`)[0]!.content, /full_writing/u);
    await f.service.startAuthorTurn(input('不要全文重写，只改第二段')).result;
    assert.equal(provider.requests.at(-1)!.tools?.some(t => t.name === 'request_author_full_writing'), false);
  } finally { f.close(); }
});

it('saves and explicitly confirms an illustration plan without image files or an image provider', async () => {
  const provider = new AuthorProvider([
    { name: 'delegate_author_expert', args: { role: 'illustrator', task: '仅策划配图，不生成图片' } },
    { name: 'propose_illustration_plan', args: { items: [{ placement: '开头之后', purpose: '给读者休息空间', description: '安静窗边的抽象光影，不暗示真实新闻现场', altText: '窗边的光影' }] } },
    { name: 'respond_author', args: { reply: '建议在开头后放一幅窗边光影图。这里只保存策划，没有生成图片；你可以回复“确认配图方案”。' } },
  ]);
  const f = setup(provider);
  try {
    assert.equal((await f.service.startAuthorTurn(input('给这篇文章策划配图，先别生成')).result).ok, true);
    const proposal = f.storage.listArtifactVersions('p', 'report', 'author-illustration-plan').at(-1)!;
    assert.equal(JSON.parse(proposal.content).status, 'proposed');
    provider.calls.push({ name: 'confirm_illustration_plan', args: { planVersionId: proposal.id } }, { name: 'respond_author', args: { reply: '配图方案已确认保存，尚未生成图片。' } });
    assert.equal((await f.service.startAuthorTurn(input('确认配图方案，仅保存策划')).result).ok, true);
    const saved = JSON.parse(f.storage.listArtifactVersions('p', 'report', 'author-illustration-plan').at(-1)!.content);
    assert.equal(saved.status, 'confirmed'); assert.deepEqual(saved.imageFiles, []); assert.equal(saved.generationAvailable, false);
    assert.equal(provider.requests.some(r => r.tools?.some(t => /generate.*image/u.test(t.name))), false);
  } finally { f.close(); }
});

it('reads actual migrated style references and remembers only the explicitly approved preference', async () => {
  const provider = new AuthorProvider([
    { name: 'read_legacy_style', args: { name: 'jiubian' } }, { name: 'respond_author', args: { reply: '档案可作为参考，尚不能视为本稿验证通过。' } },
    { name: 'save_author_preference', args: {} }, { name: 'respond_author', args: { reply: '已保存你的明确偏好。' } },
    { name: 'respond_author', args: { reply: '继续遵守你的偏好。' } },
  ]);
  const f = setup(provider);
  try {
    assert.equal((await f.service.startAuthorTurn(input('看看 jiubian 的风格档案')).result).ok, true);
    const toolMessage = provider.requests[1]!.messages.find(m => m.role === 'tool')!;
    assert.match(toolMessage.content, /reference_untrusted/u); assert.match(toolMessage.content, /legacy_unverified/u);
    assert.equal((await f.service.startAuthorTurn(input('记住我的写作偏好：开头不要套话')).result).ok, true);
    assert.equal((await f.service.startAuthorTurn(input('继续聊一下开头')).result).ok, true);
    assert.match(provider.requests.at(-1)!.messages[1]!.content, /approvedAuthorPreferences.*开头不要套话/u);
  } finally { f.close(); }
});

it('remembers and forgets preferences from contextual decisions without a magic prefix', async () => {
  const f = setup(new AuthorProvider([
    { name: 'save_author_preference', args: {} }, { name: 'respond_author', args: { reply: '已记住，以后写作参考这项偏好。' } },
    { name: 'save_author_preference', args: {} }, { name: 'respond_author', args: { reply: '已忘记本项目保存的偏好，稿件保持不变。' } },
  ]));
  try {
    const text = '以后写东西都别用套话开头，这点帮我一直记着';
    assert.equal((await f.service.startAuthorTurn(input(text)).result).ok, true);
    const remembered = getApprovedAuthorPreferences(f.storage);
    assert.equal(remembered.rules.at(-1)?.sourceUserText, text);
    assert.equal(remembered.rules.at(-1)?.text, text);
    assert.equal(remembered.mayExpandPermissions, false);
    assert.equal((await f.service.startAuthorTurn(input('之前让你记的写作习惯不用了，忘掉吧')).result).ok, true);
    assert.equal(getApprovedAuthorPreferences(f.storage).rules.length, 0);
  } finally { f.close(); }
});
