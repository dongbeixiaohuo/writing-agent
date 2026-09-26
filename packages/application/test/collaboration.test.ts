import assert from "node:assert/strict";
import { buildExpertInstructions } from '../../writing-pack/src/expert-instructions.js';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { WritingApplicationService } from "../src/index.js";
import { collaborationState } from "./collaboration-fixture.js";
import { getPublicationCandidates, choosePublicationCandidate } from '../src/publication-choice.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import { publicStageFixtureEvents } from './collaboration-fixture.js';

export class CollaborationProvider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  constructor(readonly blocked = false) { super("collaboration-mock", "1.0.0", { protocol: "mock", tools: "supported", streaming: "supported", usage: "unknown" }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const raw = request.messages.find((message) => message.role === "user")?.content ?? "";
    const state = JSON.parse(raw.split("\nCOLLABORATION_STATE=")[1]!) as { actor: string; nextStage: string | null; stage: string | null; inputVersionIds: string[]; unreadArtifactVersionIds: string[]; factCheck?: { status: string }; finished: boolean; ready: boolean };
    let name: string; let args: unknown;
    state.ready ||= request.messages.some((message) => message.role === "tool" && message.name === "assess_writing_readiness" && JSON.parse(message.content).ok === true);
    if (state.actor === "director") {
      if (state.finished) { yield { type: "text_delta", delta: "已完成" }; yield { type: "completed", finishReason: "stop" }; return; }
      const readIds = request.messages.flatMap((message) => message.role === "tool" && message.name === "read_artifact_version" ? [JSON.parse(message.content).result?.versionId] : []);
      const unread = !state.ready ? state.unreadArtifactVersionIds.find((id) => !readIds.includes(id)) : undefined;
      if (unread !== undefined) {
        yield { type: "tool_call_delta", index: 0, id: `read-${this.requests.length}`, name: "read_artifact_version", argumentsDelta: JSON.stringify({ versionId: unread }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      name = state.ready ? "director_decide" : "assess_writing_readiness";
      args = state.ready ? { action: state.nextStage === null ? "finish" : "dispatch", stage: state.nextStage, reason: "按输入版本推进；综合独立意见后安排修订", inputVersionIds: state.inputVersionIds, questions: [] } : { status: "ready", reason: "当前个人表达范围充分", questions: [] };
      if (this.blocked && state.ready && state.nextStage === 'fact_check' && state.factCheck?.status === 'blocked') {
        name = 'assess_writing_readiness';
        args = { status: 'needs_input', reason: '作者要求保留的增长数据缺少来源，需要确认。', questions: ['关于「增长99%」：这是你想保留的真实数据吗？请提供来源，或决定去掉它。'] };
      }
    } else if (state.actor === 'title') {
      name = 'submit_publication_candidates';
      args = { candidates: [
        { title: '安静', opening: null, distributionCopy: null, rationale: '原稿标题的观察角度' },
        { title: '把安静留在窗边', opening: null, distributionCopy: null, rationale: '保留具体意象' },
        { title: '停下来听一听', opening: null, distributionCopy: null, rationale: '邀请读者感受' },
      ] };
    } else if (state.stage === "fact_check") {
      name = "submit_fact_check";
      args = this.blocked ? { claims: [{ claimId: "C001", claimText: "增长99%", claimType: "number", location: "body", status: "UNSUPPORTED", risk: "red", supportScope: "none", matchedEvidenceId: null, sourceReference: null, evidenceSummary: "没有来源", recommendedAction: "提供数据来源" }], noFactualClaimsReason: "" } : { claims: [], noFactualClaimsReason: "文章只表达个人感受，无外部事实主张。" };
    } else {
      name = "submit_writing_stage";
      args = { stage: state.stage, content: state.stage === "research" ? '{"claims":[],"notes":"仅个人感受"}' : state.stage?.startsWith("review_") ? `SECRET_OPINION_${state.stage}` : `# 安静\n\n我喜欢这样的安静。${state.stage}${raw.includes("改成对比结构") ? "对比版" : ""}` };
    }
    const prose = publicStageFixtureEvents(request, name, args);
    if (prose) { yield* prose; return; }
    yield { type: "tool_call_delta", index: 0, id: `call-${this.requests.length}`, name, argumentsDelta: JSON.stringify(args) };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

function setup(provider: CollaborationProvider, interactionMode: "autonomous" | "co_creation" = "autonomous", materialCount = 0, mode: 'quick' | 'deep' = 'quick') {
  const path = mkdtempSync(join(tmpdir(), "writing-collaboration-"));
  const storage = openWorkspaceStorage({ workspacePath: path });
  const app = new WritingApplicationService({ storage, provider });
  const actor = { kind: "user", id: "u" } as const;
  app.createProject({ operationId: "project", projectId: "p", name: "test", mode, actor });
  for (let i = 0; i < materialCount; i++) {
    const imported = app.importMaterial({ operationId: `material-${i}`, projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
      materialId: `m-${i}`, displayName: `需求对话 ${i + 1}`, sourceKind: 'pasted_text', sourceReference: 'conversation', role: 'illustrative', trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: `写安静的观察，要求 ${i}`, actor });
    assert.equal(imported.ok, true, JSON.stringify(imported));
  }
  const saved = app.saveWritingBrief({ operationId: "brief", projectId: "p", expectedProjectRevision: storage.inspectProject("p")!.revision, baseVersionId: null, actor, brief: { schemaVersion: 1, topic: "安静", genre: "narrative_observation", audience: "读者", lengthTarget: { targetCharacters: 800 }, materialIds: Array.from({ length: materialCount }, (_, i) => `m-${i}`), constraints: [], interactionMode, authorAuthorization: { voice: "克制", styleReference: null, styleDecision: "user_confirmed", directionDecision: "user_confirmed", firsthandMaterialIds: [] }, platform: null, publicationGoal: "not_applicable", confirmationStatus: "confirmed" } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const project = storage.inspectProject("p")!;
  return { storage, app, input: { projectId: "p", expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, model: "mock", parameters: {}, budget: { maxModelRequests: 60, maxToolCalls: 80, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } }, close() { storage.close(); rmSync(path, { recursive: true, force: true }); } };
}

it('requires a separate author decision after each independent review, including after restart', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation', 0, 'deep');
  try {
    const first = await f.app.runDraft(f.input);
    const stages = ['outline', 'draft', 'review_editor', 'review_publish', 'review_reader'];
    for (let index = 0; index < stages.length; index++) {
      if (index > 0) {
        const restarted = new WritingApplicationService({ storage: f.storage, provider });
        await restarted.resumeDraft({ ...f.input, runId: first.runId, operationId: `stepwise-${index}`,
          decision: 'resume', userInstruction: 'ok', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
      }
      const wait = f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1);
      assert.equal(wait?.payload.stage, stages[index]);
      assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
      const next = stages[index + 1] ?? 'central_revision';
      assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:${next}`).length, 0,
        `must not execute ${next} before the current expert is accepted`);
      if (stages[index]!.startsWith('review_')) {
        assert.throws(() => f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: `not-confirmed-${index}`,
          decision: 'resume', userInstruction: '我不同意第二条，先解释一下', expectedProjectRevision: f.storage.inspectProject('p')!.revision }),
          /confirm|confirmation/i);
        assert.equal(f.storage.getRun(first.runId)?.status, 'waiting_user');
      }
    }
  } finally { f.close(); }
});

it('carries a dead run\'s contiguous completed stages into the next run of the same session', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const firstRun = f.storage.getRun(first.runId)!;
    assert.equal(firstRun.stopReason, 'CO_CREATION_CHECKPOINT');
    const before = provider.requests.length;
    // Simulate the user abandoning the interrupted pipeline (e.g. after a bug loop).
    f.app.cancelDraft({ projectId: 'p', runId: first.runId, operationId: 'abandon', reason: 'user_stop' });

    const second = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, sessionId: firstRun.sessionId, userInstruction: '继续' });
    // Carried markers belong to the new run and reference the same stage outputs.
    const carriedOutline = f.storage.listArtifactVersions('p', 'report', `workflow:${second.runId}:outline`).at(-1);
    const sourceOutline = f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:outline`).at(-1);
    assert.ok(carriedOutline && sourceOutline);
    assert.equal(JSON.parse(carriedOutline.content).artifactVersionId, JSON.parse(sourceOutline.content).artifactVersionId);
    assert.equal(carriedOutline.actor.kind === 'agent' && carriedOutline.actor.runId, second.runId);
    // The continuation starts at draft: outline/research were carried, not redone.
    const continuationStates = provider.requests.slice(before).map(request => collaborationState(request)).filter(state => state !== null);
    assert.ok(continuationStates.length > 0);
    assert.deepEqual(continuationStates[0]!.completedStages, ['research', 'outline']);
    assert.equal(continuationStates[0]!.nextStage, 'draft');
    assert.equal(continuationStates.filter(state => state.stage === 'outline').length, 0);
    assert.equal(continuationStates.some(state => state.stage === 'draft'), true);
    // fact_check is never carried: it stays with the project-level gate.
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${second.runId}:fact_check`).length, 0);
  } finally { f.close(); }
});

it('does not carry stages from a completed run or into another session', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'autonomous');
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.status, 'completed');
    const sessionId = f.storage.getRun(first.runId)!.sessionId;

    const sameSession = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, sessionId, userInstruction: '再写一篇' });
    const sameSessionStates = provider.requests.map(request => collaborationState(request)).filter(state => state !== null);
    const sameSessionStart = sameSessionStates.findLast(state => state.completedStages.length === 0);
    assert.ok(sameSessionStart, 'a completed run never carries: the next run starts empty');
    assert.equal(sameSessionStart!.nextStage, 'research');

    const otherSession = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, userInstruction: '换一个话题' });
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${otherSession.runId}:research`).length >= 0, true);
    const otherRunMarkers = f.storage.listArtifactVersions('p', 'report', `workflow:${otherSession.runId}:outline`);
    assert.ok(otherRunMarkers.length > 0, 'the new session runs its own pipeline');
    assert.equal(otherRunMarkers.every(marker => marker.actor.kind === 'agent' && marker.actor.runId === otherSession.runId), true);
  } finally { f.close(); }
});

it('saves a streamed outline verbatim through the harness without a second model request', async () => {
  const parts = ['# 安静的提纲\n\n', '一、窗边的观察。\n\n', '二、收回目光，留一点余味。'];
  let inspect = () => {};
  class TextOutline extends CollaborationProvider {
    outlineRequests = 0;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage !== 'outline') { yield* super.providerStream(request); return; }
      this.requests.push(request); this.outlineRequests++;
      for (const delta of parts) { yield { type: 'text_delta', delta }; inspect(); }
      yield { type: 'completed', finishReason: 'stop' };
    }
  }
  const provider = new TextOutline(); const f = setup(provider, 'co_creation');
  const samples: string[] = [];
  inspect = () => {
    const run = f.storage.listRuns('p')[0]!;
    samples.push(f.app.getLiveReply('p', run.sessionId, run.id)!.text);
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 0);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(provider.outlineRequests, 1);
    const request = provider.requests.find(r => collaborationState(r)?.stage === 'outline')!;
    assert.equal(request.parameters.toolChoice, 'auto');
    assert.deepEqual(request.tools?.map(t => t.name).sort(), ['assess_writing_readiness', 'read_artifact_version']);
    assert.deepEqual(samples, parts.map((_, i) => parts.slice(0, i + 1).join('')));
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main')[0]?.content, parts.join(''));
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 0);
    const save = f.storage.listRunEvents(result.runId).find(e => e.type === 'tool.requested' && e.payload.actor === 'outline');
    assert.equal(save?.payload.origin, 'harness_text_output');
  } finally { f.close(); }
});

it('does not confuse a short first-person article with a generation status message', async () => {
  class PersonalText extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (['draft', 'central_revision', 'language_review'].includes(collaborationState(request)?.stage ?? '')) {
        yield { type: 'text_delta', delta: '我会把散乱的日子整理好。' };
        yield { type: 'completed', finishReason: 'stop' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new PersonalText());
  try { assert.equal((await f.app.runDraft(f.input)).ok, true); } finally { f.close(); }
});

it('reassesses the next stage before dispatch and asks about a newly discovered research gap', async () => {
  class ResearchGap extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'director' && state.nextStage === 'outline' && !state.ready) {
        yield { type: 'tool_call_delta', index: 0, id: 'research-gap', name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'needs_input', reason: '研究发现指定事件缺少发生经过，尚不能确定提纲。', questions: ['你想写的那次经历具体发生了什么？如果不写真实经历，也可以改为纯观察。'] }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new ResearchGap());
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.status, 'waiting_user');
    assert.equal(f.storage.getRun(result.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 0, 'must ask before outline, not at final fact check');
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 0);
  } finally { f.close(); }
});

it('finishes durably when the director finishes instead of requesting another model acknowledgement', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true);
    assert.equal(provider.requests.filter(r => collaborationState(r)?.finished).length, 0, 'a saved finish decision must not re-enter the model loop');
    assert.equal(f.storage.listRunEvents(result.runId).filter(e => e.type === 'run.completed').length, 1);
  } finally { f.close(); }
});

it('returns fact findings to the director before asking the author to fix agent work', async () => {
  let directorReviewed = false;
  class ResolveFacts extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request) as any;
      if (state?.actor === 'director' && state.factCheck?.status === 'blocked') {
        directorReviewed = true;
        yield { type: 'tool_call_delta', index: 0, id: 'specific-user-choice', name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'needs_input', reason: '已核对当前稿件和写作约定，需要作者决定是否保留这一真实数据。', questions: ['这处增长数据是你希望保留的真实信息吗？如果不是，我会去掉它。'] }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new ResolveFacts(true));
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(directorReviewed, true, 'failed assessment must not bypass director and manufacture a material request');
    const wait = f.storage.listRunEvents(result.runId).findLast(e => e.type === 'run.waiting_user');
    assert.match(JSON.stringify(wait?.payload), /是你希望保留的真实信息/u);
    assert.equal(f.storage.getFactCheckStatus('p').status, 'blocked', 'routing must not waive publication checks');
  } finally { f.close(); }
});

it('repairs an agent-introduced unsupported detail internally and rechecks the new body without author homework', async () => {
  class InternalRepair extends CollaborationProvider {
    checks = 0;
    reworked = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request) as any;
      if (state?.actor === 'director' && state.ready && state.factCheck?.status === 'blocked' && !this.reworked) {
        this.reworked = true;
        yield { type: 'tool_call_delta', index: 0, id: 'repair-own-detail', name: 'director_decide', argumentsDelta: JSON.stringify({ action: 'rework', stage: 'central_revision', reason: '增长99%是主笔自行加入的无来源数字，不是作者要求。删除该细节，保留原方向与其他正文，再独立核查。', questions: [] }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      if (state?.stage === 'fact_check') {
        const first = this.checks++ === 0;
        yield { type: 'tool_call_delta', index: 0, id: `fact-${this.checks}`, name: 'submit_fact_check', argumentsDelta: JSON.stringify(first ? { claims: [{ claimId: 'C001', claimText: '增长99%', claimType: 'number', location: 'body', status: 'UNSUPPORTED', risk: 'red', supportScope: 'none', matchedEvidenceId: null, sourceReference: null, evidenceSummary: '主笔自行加入，材料不支持', recommendedAction: '删去无依据数字，不改变作者方向' }], noFactualClaimsReason: '' } : { claims: [], noFactualClaimsReason: '无依据数字已移除，只有主观感受。' }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      if (['draft', 'central_revision', 'language_review'].includes(state?.stage)) {
        yield { type: 'text_delta', delta: this.reworked ? '# 安静\n\n安静让我觉得轻松。' : '# 安静\n\n安静让我觉得轻松，效率增长99%。' };
        yield { type: 'completed', finishReason: 'stop' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new InternalRepair(); const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.checks, 2);
    assert.equal(f.storage.listRunEvents(result.runId).some(e => e.type === 'run.waiting_user'), false);
    const body = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.latestBodyVersionId!)!;
    assert.doesNotMatch(body.content, /99%/);
    assert.equal(f.storage.getFactCheckStatus('p').snapshot?.bodyVersionId, body.id);
    assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 1);
  } finally { f.close(); }
});

for (const targetStage of ['outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review']) {
it('streams public ' + targetStage + ' before saving with stable identity', async () => {
  // Language review must preserve the previous body, not replace it with a test outline.
  const partial = targetStage === 'language_review' ? '# 安静\n\n我喜欢' : '# 大纲\n\n第一段';
  const tail = targetStage === 'language_review' ? '这样的安静，central_revision' : '，第二段。';
  const full = partial + tail;
  let inspect: (request: ModelRequest, phase: string) => void = () => {};
  class StreamingOutlineProvider extends CollaborationProvider {
    outlined = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor !== targetStage) { yield* super.providerStream(request); return; }
      if (!this.outlined) {
        this.outlined = true;
        yield { type: 'text_delta', delta: partial };
        inspect(request, 'partial');
        yield { type: 'text_delta', delta: tail };
        inspect(request, 'full');
        yield { type: 'completed', finishReason: 'stop' }; return;
      }
      assert.fail('a completed public text must be saved locally, not requested again for serialization');
    }
  }
  const f = setup(new StreamingOutlineProvider(), 'autonomous', 0, 'deep');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'stream-test', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: f.input.budget } });
  const samples: string[] = [];
  let previewId = '';
  inspect = (request, phase) => {
    const run = f.storage.listRuns('p')[0]!;
    const preview = f.app.getLiveReply('p', run.sessionId, run.id);
    assert.ok(preview, `${phase}: outline output must already be visible`);
    assert.equal(preview.text, phase === 'partial' ? partial : full);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${run.id}:${targetStage}`).length, 0, 'preview must never commit');
    previewId ||= preview.id!;
    assert.equal(preview.id, previewId);
    samples.push(phase);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.deepEqual(samples, ['partial', 'full']);
    assert.equal(f.app.getLiveReply('p', result.sessionId, result.runId), null);
    await bridge.selectSession('p', result.sessionId);
    const timeline = bridge.getSnapshot().timelineBySession[result.sessionId]!;
    const saved = timeline.filter(item => item.kind === 'message' && item.id === previewId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.id, previewId, 'saved output must reuse the same presentation identity');
  } finally { bridge.dispose(); f.close(); }
});

}

it('only advertises director dispatch after readiness including resumed segments', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation');
  try {
    const run = await f.app.runDraft(f.input);
    await f.app.resumeDraft({ ...f.input, runId: run.runId, operationId: 'ready-resume', decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    let pending = 0, ready = 0;
    for (const request of provider.requests) {
      const state = collaborationState(request);
      if (state?.actor !== 'director') continue;
      const names = request.tools?.map(tool => tool.name) ?? [];
      if (state.ready) { ready++; assert.ok(names.includes('director_decide')); }
      else { pending++; assert.ok(!names.includes('director_decide'), 'must not offer dispatch before readiness'); assert.ok(names.includes('assess_writing_readiness')); }
    }
    assert.ok(pending >= 2 && ready >= 2);
  } finally { f.close(); }
});

it('continues a multi-confirmation workflow beyond its cumulative limit without regenerating saved stages', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  const input = { ...f.input, budget: { ...f.input.budget, maxModelRequests: 15 } };
  try {
    const run = await f.app.runDraft(input);
    for (let i = 0; i < 4; i++) {
      await f.app.resumeDraft({ ...input, runId: run.runId, operationId: 'segment-' + i, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
      assert.equal(f.storage.getRun(run.runId)!.status, 'waiting_user');
    }
    assert.ok(f.storage.getRun(run.runId)!.usage.modelRequests > 15);
    assert.ok(getPublicationCandidates(f.storage, 'p'));
    for (const stage of ['research', 'outline', 'draft']) assert.equal(f.storage.listArtifactVersions('p', 'report', 'workflow:' + run.runId + ':' + stage).length, 1);
  } finally { f.close(); }
});

it('asks for each co-creation confirmation once at the end of the saved result, including after refresh', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'checkpoint-copy', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: f.input.budget } });
  try {
    const result = await f.app.runDraft(f.input);
    await bridge.selectSession('p', result.sessionId);
    for (const [index, phrase] of ['这个方向可以吗？', '初稿这样写可以吗？', '编辑审校的建议你认可吗？', '读者审校的建议你认可吗？'].entries()) {
      if (index > 0) await f.app.resumeDraft({ ...f.input, runId: result.runId, operationId: `inline-confirm-${index}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
      await bridge.refresh();
      const check = () => {
        const timeline = bridge.getSnapshot().timelineBySession[result.sessionId]!;
        const questions = timeline.filter(item => item.kind === 'message' && item.body.includes(phrase));
        assert.equal(questions.length, 1, JSON.stringify({ phrase, run: f.storage.getRun(result.runId)?.stopReason, waiting: f.storage.listRunEvents(result.runId).filter(e => e.type === 'run.waiting_user').map(e => e.payload) }));
        assert.ok(questions[0]?.kind === 'message' && questions[0].body.startsWith('**') && questions[0].body.includes('已保存**'), 'question belongs to the saved result, not an extra card or message');
        assert.equal(timeline.filter(item => item.kind === 'tool' && item.audience === 'conversation' && item.label === '等待你的确认').length, 0);
      };
      check();
      await bridge.refresh();
      check();
    }
  } finally { bridge.dispose(); f.close(); }
});

it('reuses version-bound material reads across confirmations without exhausting a 15-material run', async () => {
  class MaterialProvider extends CollaborationProvider {
    materials: { id: string; contentVersionId: string }[] = [];
    repeated = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request) as ReturnType<typeof collaborationState> & { materials: { materialId: string }[] };
      if (state!.actor === 'title') { yield* super.providerStream(request); return; }
      const seen = new Set([...state!.materials.map(m => m.materialId), ...request.messages.flatMap(m => m.role === 'tool' && m.name === 'read_material' ? [JSON.parse(m.content).result?.materialId] : [])]);
      const unread = this.materials.filter(m => !seen.has(m.id));
      const reread = state!.actor === 'research' && !this.repeated;
      if (unread.length || reread) {
        this.requests.push(structuredClone(request));
        if (reread) this.repeated = true;
        for (const [index, m] of (reread ? this.materials.slice(0, 1) : unread).entries()) yield { type: 'tool_call_delta', index, id: `material-${request.requestId}-${index}`, name: 'read_material', argumentsDelta: JSON.stringify({ materialId: m.id, contentVersionId: m.contentVersionId, offset: 0, maxChars: 1000 }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new MaterialProvider();
  const f = setup(provider, 'co_creation', 15);
  provider.materials = f.storage.listMaterials('p');
  try {
    const first = await f.app.runDraft(f.input);
    for (let i = 0; i < 4; i++) {
      assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user', JSON.stringify(f.storage.listRunEvents(first.runId).slice(-3)));
      await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: `material-resume-${i}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    }
    assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user');
    assert.ok(getPublicationCandidates(f.storage, 'p'), 'reached title selection without increasing budget');
    const reads = f.storage.listRunEvents(first.runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'read_material');
    assert.equal(reads.length, 15, 'complete version-bound material caches must not be read again by another expert');
    for (const request of provider.requests) {
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
      assert.ok(state.materials.length <= 15, 'injected material slices must not accumulate duplicate copies');
    }
  } finally { f.close(); }
});

it('retains an unfinished expert assignment after transport-only retry instead of dispatching it again', async () => {
  class TimeoutProvider extends CollaborationProvider {
    timedOut = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'review_editor' && !this.timedOut) {
        this.timedOut = true;
        yield { type: 'error', error: { code: 'TIMEOUT', message: 'fixture transport timeout', retryable: true } }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new TimeoutProvider();
  const f = setup(provider);
  try {
    const first = await f.app.runDraft(f.input);
    assert.ok(f.storage.listRunEvents(first.runId).some(e => e.type === 'request.outcome_unknown'));
    const result = await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: 'transport-retry', decision: 'retry_unknown', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    const assignments = f.storage.listRunEvents(first.runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.result?.collaboration?.actor === 'review_editor');
    assert.equal(assignments.length, 1, 'transport recovery must retain the committed task assignment and its bound inputs');
  } finally { f.close(); }
});

it('desktop bridge retry preserves the timed-out outline task and saved research instead of adding a synthetic instruction', async () => {
  class OutlineTimeoutProvider extends CollaborationProvider {
    failed = false;
    afterRetryActors: string[] = [];
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const current = collaborationState(request);
      if (this.failed && current) this.afterRetryActors.push(current.actor);
      if (current?.actor === 'outline' && !this.failed) {
        this.failed = true;
        yield { type: 'error', error: { code: 'TIMEOUT', message: 'isolated timeout', retryable: true } }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new OutlineTimeoutProvider();
  const f = setup(provider, 'co_creation');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'retry-test', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: f.input.budget } });
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(first.ok, false);
    const oldResearch = f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).map(v => v.id);
    assert.equal(oldResearch.length, 1);
    await bridge.selectSession('p', first.sessionId);
    await bridge.resumeRun(first.runId, 'retry_unknown', { operationId: 'desktop-retry' });
    const deadline = Date.now() + 10000;
    while (f.storage.getRun(first.runId)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('retry did not settle');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Recovery may validate saved input versions first; it must not regenerate
    // research or dispatch an already assigned specialist a second time.
    assert.ok(provider.afterRetryActors.includes('outline'));
    assert.ok(!provider.afterRetryActors.includes('research'));
    const events = f.storage.listRunEvents(first.runId);
    assert.equal(events.filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.result?.collaboration?.actor === 'outline').length, 1);
    assert.deepEqual(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).map(v => v.id), oldResearch);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
  } finally { bridge.dispose(); f.close(); }
});

for (const cancel of [false, true]) it(`desktop recovers a protected expert without redispatching saved work (cancel=${cancel})`, async () => {
  class LimitedProvider extends CollaborationProvider {
    looping = true;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'outline' && this.looping) {
        // Exercise the general call allowance, not the text-save repetition guard.
        yield { type: 'tool_call_delta', index: 0, id: `read-loop-${this.requests.length}`, name: 'read_artifact_version', argumentsDelta: JSON.stringify({versionId: collaborationState(request)!.inputVersionIds[0]}) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new LimitedProvider();
  const f = setup(provider, 'co_creation');
  const input = { ...f.input, budget: { ...f.input.budget, maxModelRequests: 12 } };
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'protected-retry', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: input.budget } });
  try {
    const first = await f.app.runDraft(input);
    assert.equal(f.storage.getRun(first.runId)?.status, 'budget_exhausted');
    await bridge.selectSession('p', first.sessionId);
    assert.ok(bridge.getSnapshot().recoverableRuns.some(r => r.runId === first.runId));
    if (cancel) {
      await bridge.cancelRun(first.runId);
      assert.equal(f.storage.getRun(first.runId)?.status, 'cancelled');
      assert.ok(!bridge.getSnapshot().recoverableRuns.some(r => r.runId === first.runId));
      assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).length, 1);
      return;
    }
    provider.looping = false;
    await bridge.resumeRun(first.runId, 'resume', { operationId: 'continue-protected' });
    const deadline = Date.now() + 10000;
    while (f.storage.getRun(first.runId)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('resume did not settle');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    const events = f.storage.listRunEvents(first.runId);
    await bridge.refresh();
    assert.ok(bridge.getSnapshot().runRecords.find(r => r.id === first.runId)!.modelRequests <= 12, 'current allowance must not display lifetime usage against a per-segment limit');
    assert.equal(events.filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.result?.collaboration?.actor === 'outline').length, 1);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).length, 1);
  } finally { bridge.dispose(); f.close(); }
});

it('stops duplicate language output and explicitly retries only that expert, keeping saved stages', async () => {
  class RejectedLanguage extends CollaborationProvider {
    reject = true; actors: string[] = [];
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request)!; this.actors.push(state.actor);
      if (state.actor === 'language_review' && this.reject) {
        yield {type:'text_delta', delta:'审校完成。\n\n文章整体清晰，可以发布。'};
        yield {type:'completed', finishReason:'stop'}; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new RejectedLanguage(); const f = setup(provider);
  const bridge = createApplicationBridge({ service:f.app, workspaceId:'text-save-retry', model:{model:'mock',providerLabel:'test',credentialReference:null,parameters:{},budget:f.input.budget} });
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'STAGE_OUTPUT_NOT_SAVED');
    assert.equal(provider.actors.filter(a => a === 'language_review').length, 2);
    const body = f.storage.inspectProject('p')!.latestBodyVersionId;
    await bridge.selectSession('p',first.sessionId);
    assert.equal(bridge.getSnapshot().recoverableRuns[0]?.stopReason,'STAGE_OUTPUT_NOT_SAVED');
    const rows = bridge.getSnapshot().timelineBySession[first.sessionId] ?? [];
    assert.ok(rows.some(row=>row.kind==='tool' && row.label==='自动重写已暂停'));
    assert.ok(!rows.some(row=>row.kind==='tool' && row.detail.includes('存在结果未知的外部请求')));
    const resumedAt = provider.actors.length; provider.reject = false;
    await bridge.resumeRun(first.runId,'resume',{operationId:'retry-text-save'});
    const deadline = Date.now()+10000;
    while(f.storage.getRun(first.runId)?.status === 'running') {
      if(Date.now()>deadline) throw new Error('stage retry did not settle');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    // Recovery may revalidate persisted inputs; it must not rerun saved experts.
    assert.ok(provider.actors.slice(resumedAt).includes('language_review'));
    assert.ok(!provider.actors.slice(resumedAt).some(a=>['research','outline','draft','review_editor','central_revision'].includes(a)));
    assert.notEqual(f.storage.inspectProject('p')!.latestBodyVersionId,body);
    assert.equal(f.storage.listArtifactVersions('p','report',`workflow:${first.runId}:research`).length,1);
    assert.equal(f.storage.listRunEvents(first.runId).filter(e=>e.type==='tool.completed' && (e.payload.result as any)?.result?.collaboration?.actor==='language_review').length,1);
  } finally {bridge.dispose();f.close();}
});

it('fact specialist contract explicitly separates uncertain evidence from schema status', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider);
  try {
    await f.app.runDraft(f.input);
    const request = provider.requests.find(r => collaborationState(r)?.stage === 'fact_check')!;
    assert.ok(request);
    assert.match(request.messages[0]!.content, /NEEDS_USER_SOURCE/);
    assert.match(request.messages[0]!.content, /UNSUPPORTED/);
    assert.match(request.messages[0]!.content, /passed_with_minor_notes/);
    assert.match(request.messages[0]!.content, /claimType.*strong_assertion.*other/);
    assert.deepEqual((collaborationState(request) as any).validEvidenceIds, []);
    assert.equal(request.parameters.toolChoice, 'required');
    const director = provider.requests.find(r => collaborationState(r)?.actor === 'director' && !collaborationState(r)?.ready)!;
    assert.equal(director.parameters.toolChoice, 'required', 'readiness must be a tool call, not repeated prose about readiness');
  } finally { f.close(); }
});

it('gives precise repair guidance for dispatch questions without silently discarding them', async () => {
  class QuestionProvider extends CollaborationProvider {
    attempted = false;
    failureContent = '';
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'director' && state.ready && !this.attempted) {
        this.attempted = true;
        yield { type: 'tool_call_delta', index: 0, id: 'bad-question', name: 'director_decide', argumentsDelta: JSON.stringify({ action: 'dispatch', stage: state.nextStage, reason: '安排研究', questions: ['（暂留）'] }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      const failure = request.messages.find(m => m.role === 'tool' && m.name === 'director_decide' && m.content.includes('DIRECTOR_UNRESOLVED_QUESTIONS'));
      if (failure) {
        this.failureContent = failure.content;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new QuestionProvider();
  const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(provider.failureContent, /questions=\[\]/u);
    assert.match(provider.failureContent, /action=ask/u);
    assert.equal(f.storage.listRunEvents(result.runId).filter(e => e.type === 'tool.failed' && (e.payload.result as any)?.error?.code === 'DIRECTOR_UNRESOLVED_QUESTIONS').length, 1);
  } finally { f.close(); }
});

it('waits for co-author title selection before fact-checking and preserves that choice', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let index = 0; index < 4; index++) {
      const project = f.storage.inspectProject('p')!;
      await f.app.resumeDraft({ ...f.input, expectedProjectRevision: project.revision, runId: first.runId, operationId: `continue-${index}`, decision: 'resume', userInstruction: '继续' }).result;
    }
    assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user');
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null, 'a generated heading is not a user selection');
    assert.ok(getPublicationCandidates(f.storage, 'p'));
    const candidate = getPublicationCandidates(f.storage, 'p')!;
    choosePublicationCandidate(f.storage, 'p', 'choose', '确认标题：安静', candidate.id, 1);
    const titleVersion = f.storage.inspectProject('p')!.currentTitleVersionId;
    const result = await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, runId: first.runId, operationId: 'after-title', decision: 'resume', userInstruction: '标题已确认，请继续核查' }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, titleVersion, 'fact checking must not replace selected title');
  } finally { f.close(); }
});

it('uses an isolated title expert when the final body has no explicit title instead of treating its opening paragraph as a title', async () => {
  class MissingTitleProvider extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'title') {
        this.requests.push(structuredClone(request));
        assert.match(request.messages[0]!.content, /ACTOR=title/u);
        assert.ok(request.tools?.some(tool => tool.name === 'submit_publication_candidates'));
        assert.equal(request.tools?.some(tool => tool.name === 'submit_writing_stage'), false);
        yield { type: 'tool_call_delta', index: 0, id: 'title-candidates', name: 'submit_publication_candidates', argumentsDelta: JSON.stringify({ candidates: [
          { title: '把安静留在窗边', opening: null, distributionCopy: null, rationale: '忠实概括正文的观察' },
          { title: '安静不是空白', opening: null, distributionCopy: null, rationale: '强调正文的核心判断' },
        ] }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      if (state?.stage && ['draft', 'central_revision', 'language_review'].includes(state.stage)) {
        this.requests.push(structuredClone(request));
        yield { type: 'text_delta', delta: '我喜欢这样的安静。它不是退场，而是把注意力重新放回眼前。\n\n窗边的光慢慢移动，房间也跟着有了层次。' };
        yield { type: 'completed', finishReason: 'stop' };
        return;
      }
      yield* super.providerStream(request);
    }
  }

  const provider = new MissingTitleProvider();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let index = 0; index < 4; index++) {
      await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision,
        runId: first.runId, operationId: `missing-title-${index}`, decision: 'resume', userInstruction: '继续' }).result;
    }
    const bodyId = f.storage.inspectProject('p')!.latestBodyVersionId!;
    const body = f.storage.getArtifactVersion(bodyId)!.content;
    const candidates = getPublicationCandidates(f.storage, 'p')!;
    assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user');
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null);
    assert.equal(candidates.bodyVersionId, bodyId);
    assert.deepEqual(candidates.candidates.map(candidate => candidate.title), ['把安静留在窗边', '安静不是空白']);
    assert.equal(candidates.candidates.some(candidate => candidate.title === body.split(/\r?\n/u)[0]), false);
    assert.ok(provider.requests.some(request => collaborationState(request)?.actor === 'title'));
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').at(-1)!.content, body, 'title preparation must not rewrite the body');
  } finally { f.close(); }
});

it('continues the same waiting workflow after the user selects the publication title in main chat', async () => {
  let candidateId = '';
  class TitleConversationProvider extends CollaborationProvider {
    selected = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (request.messages.some(m => m.role === 'user' && m.content.includes('\nCOLLABORATION_STATE='))) { yield* super.providerStream(request); return; }
      const name = this.selected ? 'respond_author' : 'choose_publication';
      const args = this.selected ? { reply: '已确认标题，将继续原写作任务的核查。' } : { candidateVersionId: candidateId, index: 1 };
      this.selected = true;
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const f = setup(new TitleConversationProvider(), 'co_creation');
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    const first = await f.app.runDraft(f.input);
    for (let n = 0; n < 4; n++) await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      runId: first.runId, operationId: `advance-${n}`, decision: 'resume', userInstruction: '继续' }).result;
    candidateId = getPublicationCandidates(f.storage, 'p')!.id;
    bridge = createApplicationBridge({ service: f.app, workspaceId: 'title-handoff', initialProjectId: 'p', model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: 'test' }, pollIntervalMs: 10 });
    assert.equal(bridge.getSnapshot().selectedSessionId, first.sessionId);
    await bridge.sendMessage('就用第一个吧', { operationId: 'chat-title-selection' });
    for (let n = 0; n < 200 && f.storage.getRun(first.runId)!.status !== 'completed'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.storage.getRun(first.runId)!.status, 'completed');
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 3, 'selection resumes only the pending fact check, not drafting');
  } finally { bridge?.dispose(); f.close(); }
});

it("uses real director decisions and independent same-draft reviews before completion", async () => {
  const provider = new CollaborationProvider(); const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    const editor = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=review_editor"))!;
    const reader = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=review_reader"))!;
    assert.ok(editor); assert.ok(reader);
    for (const request of provider.requests) {
      const role = collaborationState(request)?.actor;
      if (role) assert.ok(request.messages[0]!.content.includes(buildExpertInstructions(role)), `${role} must receive migrated professional instructions`);
    }
    assert.equal(JSON.stringify(reader.messages).includes("SECRET_OPINION_review_editor"), false);
    const revision = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=central_revision"))!;
    assert.match(revision.messages[1]!.content, /taskInstruction.*综合独立意见/u);
    assert.equal(reader.tools?.some((tool) => tool.name === "director_decide"), false);
    for (const request of provider.requests.filter((request) => collaborationState(request)?.actor !== "director")) {
      assert.match(request.messages[1]!.content, /taskInstruction/u);
      assert.match(request.messages[1]!.content, /expectedArtifact/u);
      assert.doesNotMatch(request.messages[0]!.content, /你是 Writing Agent 的主笔|并非已隔离|每个新开始或恢复的执行段/u);
      assert.doesNotMatch(request.messages[1]!.content, /必须先用 read_material/u);
    }
    const languageRequest = provider.requests.find((request) => collaborationState(request)?.stage === "language_review")!;
    assert.match(languageRequest.messages[0]!.content, /完整.*正文/u);
    assert.match(languageRequest.messages[0]!.content, /不是.*评审报告/u);
    const decisions = f.storage.listRunEvents(result.runId).filter((event) => event.type === "tool.completed" && (event.payload.result as any)?.toolName === "director_decide");
    assert.ok(decisions.length >= 9);
    const savedRequests = f.storage.listRequestSnapshots(result.runId);
    const savedReader = savedRequests.find((snapshot) => collaborationState(snapshot.request)?.stage === "review_reader")!;
    assert.ok(savedReader);
    assert.match(savedReader.request.messages[1]!.content, /taskInstruction.*expectedArtifact/u);
    assert.equal(JSON.stringify(savedReader.request.messages).includes("SECRET_OPINION_review_editor"), false);
    assert.deepEqual(savedReader.toolSchemas.map((tool) => tool.name), savedReader.request.tools!.map((tool) => tool.name));
    const savedEditor = savedRequests.find((snapshot) => collaborationState(snapshot.request)?.stage === "review_editor")!;
    assert.deepEqual(collaborationState(savedEditor.request)?.inputVersionIds, collaborationState(savedReader.request)?.inputVersionIds);
    assert.equal(f.storage.getRun(result.runId)?.status, "completed");
  } finally { f.close(); }
});

it("rejects wrong director versions and premature finish without writing", async () => {
  class WrongDirector extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request)!;
      const prior = request.messages.filter((m) => m.role === "tool" && m.name === "director_decide");
      if (prior.length >= 2) {
        yield { type: "tool_call_delta", index: 0, id: "ask", name: "director_decide", argumentsDelta: JSON.stringify({ action: "ask", stage: null, reason: "需要用户确认写作方向", questions: ["请确认文章方向。"], inputVersionIds: state.inputVersionIds }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      for await (const event of super.providerStream(request)) {
        if (event.type === "tool_call_delta" && event.name === "director_decide") {
          const args = JSON.parse(event.argumentsDelta ?? "{}");
          if (prior.length === 0) args.inputVersionIds = ["wrong-version"];
          else { args.action = "finish"; args.stage = null; }
          yield { ...event, argumentsDelta: JSON.stringify(args) };
        } else yield event;
      }
    }
  }
  const f = setup(new WrongDirector());
  try {
    const result = await f.app.runDraft(f.input);
    const codes = f.storage.listRunEvents(result.runId).filter((e) => e.type === "tool.failed").map((e) => (e.payload.result as any).error.code);
    assert.deepEqual(codes, ["DIRECTOR_INPUT_VERSION_MISMATCH", "DIRECTOR_FINISH_BLOCKED"]);
    assert.equal(f.storage.listArtifactVersions("p", "body", "main").length, 0);
    assert.equal(f.storage.getRun(result.runId)?.status, "waiting_user");
  } finally { f.close(); }
});

it("reworks an outline on the same resumed run and asks for confirmation before any draft", async () => {
  class ReworkProvider extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      for await (const event of super.providerStream(request)) {
        if (event.type === "tool_call_delta" && event.name === "director_decide" && request.messages.some((m) => m.role === "user" && m.content.includes("改成对比结构"))) {
          const args = JSON.parse(event.argumentsDelta ?? "{}");
          if (args.stage === "draft") {
            const failed = request.messages.some((m) => m.role === "tool" && m.name === "director_decide" && JSON.parse(m.content).error?.code === "OUTLINE_REWORK_REQUIRED");
            if (failed) { args.action = "rework"; args.stage = "outline"; }
          }
          yield { ...event, argumentsDelta: JSON.stringify(args) };
        } else yield event;
      }
    }
  }
  const provider = new ReworkProvider(); const f = setup(provider, "co_creation");
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.status, "waiting_user");
    const serviceAfterRestart = new WritingApplicationService({ storage: f.storage, provider });
    const project = f.storage.inspectProject("p")!;
    const resumed = await serviceAfterRestart.resumeDraft({ ...f.input, expectedProjectRevision: project.revision, runId: first.runId, operationId: "resume-rework", decision: "resume", userInstruction: "提纲改成对比结构" }).result;
    assert.equal(resumed.runId, first.runId);
    assert.equal(f.storage.getRun(first.runId)?.status, "waiting_user", JSON.stringify(resumed));
    assert.equal(f.storage.listArtifactVersions("p", "outline", "main").length, 2);
    assert.equal(f.storage.listArtifactVersions("p", "body", "main").length, 0);
    assert.equal(f.storage.getRun(first.runId)?.usage.majorRevisions, 1);
    const events = f.storage.listRunEvents(first.runId);
    assert.ok(events.some((e) => (e.payload.result as any)?.error?.code === "OUTLINE_REWORK_REQUIRED"));
    const rework = events.find((e) => (e.payload.result as any)?.result?.collaboration?.status === "rework");
    assert.ok((rework?.payload.result as any).result.collaboration.invalidatedStages.includes("fact_check"));
  } finally { f.close(); }
});

it("rejects review cross-reads and body-write tools while preserving the common draft", async () => {
  class IntrusiveReview extends CollaborationProvider {
    injected = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === "review_reader" && !this.injected) {
        this.injected = true;
        for (const [index, call] of [{ name: "read_artifact_version", args: { versionId: "other-review" } }, { name: "submit_writing_stage", args: { stage: "draft", content: "# Unauthorized rewrite" } }].entries()) yield { type: "tool_call_delta", index, id: `attack-${index}`, name: call.name, argumentsDelta: JSON.stringify(call.args) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new IntrusiveReview());
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true);
    const denied = f.storage.listRunEvents(result.runId).filter(e => e.type === 'request.failed' && (e.payload.error as any)?.code === 'MODEL_RESPONSE_INVALID');
    assert.equal(denied.length, 1, 'the unoffered write rejects the entire batch before even its cross-read executes');
    assert.equal(f.storage.listArtifactVersions("p", "body", "main").length, 3);
    const reviewInputs = f.storage.listRunEvents(result.runId).map((e) => (e.payload.result as any)?.result?.collaboration).filter((c) => c?.status === "dispatched" && c.actor.startsWith("review_"));
    assert.deepEqual(reviewInputs[0].inputVersionIds, reviewInputs[1].inputVersionIds);
  } finally { f.close(); }
});

it("never completes a writing run with blocked facts", async () => {
  const f = setup(new CollaborationProvider(true));
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, false);
    assert.equal(f.storage.getRun(result.runId)?.status, "waiting_user", JSON.stringify(result));
    assert.equal(f.storage.getRun(result.runId)?.stopReason, "WRITING_INPUT_REQUIRED");
    assert.equal(f.storage.listRunEvents(result.runId).some((event) => event.type === "run.completed"), false);
    assert.match(JSON.stringify(f.storage.listRunEvents(result.runId).find((event) => event.type === "run.waiting_user")?.payload.questions), /增长99%/u);
    const questions = f.storage.listRunEvents(result.runId).find((event) => event.type === "run.waiting_user")!.payload.questions as string[];
    assert.ok(questions.length <= 2);
    assert.doesNotMatch(questions.join(""), /\{"claimText"/u);
    assert.match(questions[0]!, /关于「增长99%」/u);
  } finally { f.close(); }
});

it("reworks the blocked current body with its fact findings after authorized user edits, then checks the new body", async () => {
  let resumed = false; let blockedBody = ""; let oldDraft = "";
  class FactRework extends CollaborationProvider {
    attemptedWrongDispatch = false;
    reworked = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      const ready = state?.ready || request.messages.some((message) => message.role === "tool" && message.name === "assess_writing_readiness" && JSON.parse(message.content).result?.status === "ready");
      if (resumed && state?.actor === "director" && ready && state.nextStage === "fact_check" && !this.reworked) {
        assert.match(request.messages[0]!.content, /rework central_revision/u);
        assert.match(request.messages[1]!.content, /请删去增长99%的句子/u);
        const wrong = !this.attemptedWrongDispatch;
        if (!wrong) {
          assert.match(JSON.stringify(request.messages), /rework.*central_revision/u);
          this.reworked = true;
        }
        this.attemptedWrongDispatch = true;
        yield { type: "tool_call_delta", index: 0, id: `correct-rework-${wrong}`, name: "director_decide", argumentsDelta: JSON.stringify({ action: wrong ? "dispatch" : "rework", stage: wrong ? "language_review" : "central_revision", reason: "按用户授权删除增长99%的句子，保留其他正文。", questions: [] }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      if (resumed && state?.stage === "central_revision") {
        assert.ok(state.inputVersionIds.includes(blockedBody));
        assert.equal(state.inputVersionIds.includes(oldDraft), false);
        assert.match(request.messages[1]!.content, /增长99%.*提供数据来源/u);
        const read = new Set(request.messages.flatMap((message) => message.role === "tool" && message.name === "read_artifact_version" ? [JSON.parse(message.content).result?.versionId] : []));
        const findings = (JSON.parse(request.messages[1]!.content.split("\nCOLLABORATION_STATE=")[1]!) as any).artifacts.find((item: any) => item.kind === "report")?.id;
        if (findings && !read.has(findings)) {
          yield { type: 'tool_call_delta', index: 0, id: 'read-rework-findings', name: 'read_artifact_version', argumentsDelta: JSON.stringify({ versionId: findings }) };
          yield { type: 'completed', finishReason: 'tool_calls' }; return;
        }
      }
      if (resumed && (state?.stage === "central_revision" || state?.stage === "language_review")) {
        yield { type: "text_delta", delta: "# 安静\n\n已按授权删去数字，只表达我的感受。" };
        yield { type: "completed", finishReason: "stop" }; return;
      }
      if (resumed && state?.stage === "fact_check") {
        assert.equal(state.inputVersionIds.includes(blockedBody), false);
        yield { type: "tool_call_delta", index: 0, id: "recheck-new-body", name: "submit_fact_check", argumentsDelta: JSON.stringify({ claims: [], noFactualClaimsReason: "数字已删，仅个人感受。" }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new FactRework(true));
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.status, "waiting_user");
    blockedBody = f.storage.inspectProject("p")!.latestBodyVersionId!;
    oldDraft = f.storage.listArtifactVersions("p", "body", "main")[0]!.id;
    resumed = true;
    const next = await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, runId: first.runId, operationId: "authorize-fact-edit", decision: "resume", userInstruction: "请删去增长99%的句子，先修改正文后重新核查，无需再问同一授权。" }).result;
    assert.equal(next.ok, true, JSON.stringify({ next, failures: f.storage.listRunEvents(first.runId).filter((event) => event.type === "tool.failed").slice(-3).map((event) => event.payload) }));
    assert.equal(next.runId, first.runId);
    assert.equal(f.storage.getRun(first.runId)?.usage.majorRevisions, 1);
    assert.notEqual(f.storage.inspectProject("p")!.latestBodyVersionId, blockedBody);
    assert.equal(f.storage.getFactCheckStatus("p").status, "passed");
  } finally { f.close(); }
});

it("keeps director and expert calls inside one budget and discards cancelled expert output", async () => {
  const bounded = setup(new CollaborationProvider());
  try {
    const result = await bounded.app.runDraft({ ...bounded.input, budget: { ...bounded.input.budget, maxModelRequests: 3 } });
    assert.equal(result.ok, false);
    assert.equal(bounded.storage.getRun(result.runId)?.status, "budget_exhausted");
    assert.equal(result.modelRequestCount, 3);
    assert.equal(bounded.storage.listRuns("p").length, 1);
  } finally { bounded.close(); }
  let entered!: () => void; let release!: () => void;
  const expertEntered = new Promise<void>((resolve) => { entered = resolve; });
  const finishExpert = new Promise<void>((resolve) => { release = resolve; });
  class DelayedExpert extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === "research") { entered(); await finishExpert; }
      yield* super.providerStream(request);
    }
  }
  const cancelled = setup(new DelayedExpert());
  try {
    const handle = cancelled.app.startDraft(cancelled.input);
    await expertEntered;
    handle.cancel("cancel-expert"); release();
    const result = await handle.result;
    assert.equal(result.ok, false);
    assert.equal(cancelled.storage.getRun(result.runId)?.status, "cancelled");
    assert.equal(cancelled.storage.listArtifactVersions("p", "evidence", "main").length, 0);
  } finally { release(); cancelled.close(); }
});

it("stops an over-budget rework before invalidating completed artifacts", async () => {
  class ReworkWithoutBudget extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      for await (const event of super.providerStream(request)) {
        if (event.type === "tool_call_delta" && event.name === "director_decide" && collaborationState(request)?.nextStage === "draft") {
          const args = JSON.parse(event.argumentsDelta ?? "{}"); args.action = "rework"; args.stage = "outline";
          yield { ...event, argumentsDelta: JSON.stringify(args) };
        } else yield event;
      }
    }
  }
  const f = setup(new ReworkWithoutBudget());
  try {
    const result = await f.app.runDraft({ ...f.input, budget: { ...f.input.budget, maxMajorRevisions: 0 } });
    assert.equal(result.ok, false);
    assert.equal(f.storage.getRun(result.runId)?.status, "budget_exhausted");
    assert.equal(f.storage.listArtifactVersions("p", "report", `workflow-invalidated:${result.runId}`).length, 0);
  } finally { f.close(); }
});

it("rejects reworking an uncompleted stage in a new run before charging revision budget", async () => {
  class PrematureRework extends CollaborationProvider {
    attempted = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      const ready = state?.ready || request.messages.some((message) => message.role === "tool" && message.name === "assess_writing_readiness" && JSON.parse(message.content).result?.status === "ready");
      if (state?.actor === "director" && ready) {
        assert.match(request.messages[0]!.content, /项目已有正文或旧run事实blocked.*不代表本run完成过阶段/u);
        const args = this.attempted ? { action: "ask", stage: null, reason: "需要确认文章方向", questions: ["是否保留当前叙述视角？"] } : { action: "rework", stage: "central_revision", reason: "编辑项目已有正文", questions: [] };
        this.attempted = true;
        yield { type: "tool_call_delta", index: 0, id: `premature-${args.action}`, name: "director_decide", argumentsDelta: JSON.stringify(args) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new PrematureRework());
  try {
    const previous = f.storage.commitArtifactVersion({ operationId: "previous-run-body", projectId: "p", expectedProjectRevision: f.storage.inspectProject("p")!.revision, kind: "body", logicalKey: "main", baseVersionId: null, requestSnapshotId: null, content: "# 已有稿件\n\n这是新run开始前的正文。", reason: "previous run", actor: { kind: "user", id: "u" } });
    assert.equal(previous.ok, true);
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, userInstruction: "请修改当前已有稿件。" });
    assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 0);
    assert.equal(f.storage.listArtifactVersions("p", "report", `workflow-invalidated:${result.runId}`).length, 0);
    const failed = f.storage.listRunEvents(result.runId).find((event) => (event.payload.result as any)?.error?.code === "DIRECTOR_REWORK_NOT_AVAILABLE");
    assert.match((failed?.payload.result as any)?.error?.message ?? "", /nextStage=research.*new run/u);
    assert.equal(f.storage.listRunEvents(result.runId).some((event) => event.payload.toolName === "director_rework"), false);
  } finally { f.close(); }
});

it("waits before rework mutates stages or revision budget when the body was edited externally", async () => {
  let edit!: () => void;
  class StaleRework extends CollaborationProvider {
    edited = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      for await (const event of super.providerStream(request)) {
        if (event.type === "tool_call_delta" && event.name === "director_decide" && collaborationState(request)?.nextStage === "language_review") {
          if (!this.edited) { this.edited = true; edit(); }
          const args = JSON.parse(event.argumentsDelta ?? "{}"); args.action = "rework"; args.stage = "central_revision";
          yield { ...event, argumentsDelta: JSON.stringify(args) };
        } else yield event;
      }
    }
  }
  const f = setup(new StaleRework());
  edit = () => {
    const project = f.storage.inspectProject("p")!;
    assert.equal(f.app.saveBody({ operationId: "external-before-rework", projectId: "p", expectedProjectRevision: project.revision, baseBodyVersionId: project.latestBodyVersionId!, content: "# 用户新稿\n\n保留正文。", reason: "manual", actor: { kind: "user", id: "u" } }).ok, true);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.status, "waiting_user");
    assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 0);
    assert.equal(f.storage.listArtifactVersions("p", "report", `workflow-invalidated:${result.runId}`).length, 0);
  } finally { f.close(); }
});

it("binds omitted director input versions automatically and rejects technical metadata as a user gap", async () => {
  class AutoBindingDirector extends CollaborationProvider {
    injected = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (!this.injected) {
        this.injected = true;
        yield { type: "tool_call_delta", index: 0, id: "internal-gap", name: "assess_writing_readiness", argumentsDelta: JSON.stringify({ status: "needs_input", reason: "COLLABORATION_STATE inputVersionIds为空", questions: ["请提供正确inputVersionIds或UUID？"] }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      for await (const event of super.providerStream(request)) {
        if (event.type === "tool_call_delta" && event.name === "director_decide") {
          const args = JSON.parse(event.argumentsDelta ?? "{}"); delete args.inputVersionIds;
          yield { ...event, argumentsDelta: JSON.stringify(args) };
        } else yield event;
      }
    }
  }
  const f = setup(new AutoBindingDirector());
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    const events = f.storage.listRunEvents(result.runId);
    assert.equal(events.some((e) => e.type === "run.waiting_user"), false);
    assert.ok(events.some((e) => (e.payload.result as any)?.error?.code === "INTERNAL_METADATA_NOT_USER_GAP"));
    const assignments = events.map((e) => (e.payload.result as any)?.result?.collaboration).filter(Boolean);
    assert.deepEqual(assignments[0].inputVersionIds, []);
    assert.ok(assignments.some((a) => a.stage === "outline" && a.inputVersionIds.length === 1));
  } finally { f.close(); }
});

it("pauses immediately on an expert's real gap and never executes its later submission", async () => {
  class ExpertGap extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === "draft") {
        yield { type: "tool_call_delta", index: 0, id: "expert-gap", name: "assess_writing_readiness", argumentsDelta: JSON.stringify({ status: "needs_input", reason: "缺少作者要描述的具体场景", questions: ["请描述一次真实的安静场景。"] }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new ExpertGap());
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.status, "waiting_user");
    assert.equal(f.storage.listRuns("p").length, 1);
    assert.equal(f.storage.listArtifactVersions("p", "body", "main").length, 0);
    assert.equal(f.storage.listRunEvents(result.runId).some((e) => e.payload.callId === "must-not-write"), false);
  } finally { f.close(); }
});

it("retires an old editing baseline after a new draft and binds fact checking to the sole current body", async () => {
  const f = setup(new CollaborationProvider());
  try {
    const project = f.storage.inspectProject("p")!;
    const old = f.storage.commitArtifactVersion({ operationId: "old-report", projectId: "p", expectedProjectRevision: project.revision, kind: "body", logicalKey: "main", baseVersionId: null, requestSnapshotId: null, content: "本稿语言底子良好。建议优先处理措辞。整体可保留。", reason: "previous failed run", actor: { kind: "user", id: "u" } });
    assert.equal(old.ok, true, JSON.stringify(old)); if (!old.ok) return;
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, userInstruction: "请重新形成完整文章，不把此前审校报告当成稿件。" });
    assert.equal(result.ok, true, JSON.stringify(result));
    const snapshots = f.storage.listRequestSnapshots(result.runId);
    const fact = snapshots.find((snapshot) => collaborationState(snapshot.request)?.stage === "fact_check")!;
    assert.ok(fact);
    assert.equal(JSON.stringify(fact.request.messages).includes(old.result.versionId), false);
    const state = JSON.parse(fact.request.messages[1]!.content.split("\nCOLLABORATION_STATE=")[1]!);
    assert.equal(state.artifacts.filter((artifact: any) => artifact.kind === "body").length, 1);
    assert.equal(state.currentBodyVersionId, f.storage.inspectProject("p")!.latestBodyVersionId);
    assert.match(fact.request.messages[0]!.content, /唯一.*核查对象/u);
    const lateDirector = snapshots.filter((snapshot) => collaborationState(snapshot.request)?.actor === "director").at(-1)!;
    assert.equal(JSON.stringify(lateDirector.request.messages).includes(old.result.versionId), false);
  } finally { f.close(); }
});

it("refuses to overwrite a concurrent user body edit after specialist dispatch", async () => {
  let edit!: () => void;
  class ConcurrentEdit extends CollaborationProvider {
    edited = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === "language_review") {
        if (!this.edited) { this.edited = true; edit(); }
        else {
          yield { type: "tool_call_delta", index: 0, id: "concurrent-edit-question", name: "assess_writing_readiness", argumentsDelta: JSON.stringify({ status: "needs_input", reason: "用户已保存新正文，需要确认修改范围", questions: ["请确认是否基于你刚保存的新正文继续润色？"] }) };
          yield { type: "completed", finishReason: "tool_calls" }; return;
        }
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new ConcurrentEdit());
  edit = () => {
    const project = f.storage.inspectProject("p")!;
    const saved = f.app.saveBody({ operationId: "user-edit-inflight", projectId: "p", expectedProjectRevision: project.revision, baseBodyVersionId: project.latestBodyVersionId!, content: "# 用户新稿\n\n保留我的手动修改。", reason: "user editing", actor: { kind: "user", id: "u" } });
    assert.equal(saved.ok, true);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, false);
    assert.match(f.storage.getArtifactVersion(f.storage.inspectProject("p")!.latestBodyVersionId!)!.content, /保留我的手动修改/u);
    assert.ok(f.storage.listRunEvents(result.runId).some((e) => ['BASE_VERSION_CONFLICT', 'WRITING_READINESS_REQUIRED', 'TOOL_PERMISSION_DENIED'].includes((e.payload.result as any)?.error?.code)), 'a concurrent edit must revoke write permission, invalidate admission or fail write CAS');
  } finally { f.close(); }
});

it("rejects fact output when its bound body changed during the expert request", async () => {
  let edit!: () => void;
  class FactEdit extends CollaborationProvider {
    edited = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === "fact_check") {
        if (!this.edited) { this.edited = true; edit(); }
        else {
          yield { type: "tool_call_delta", index: 0, id: "fact-edit-question", name: "assess_writing_readiness", argumentsDelta: JSON.stringify({ status: "needs_input", reason: "核查期间正文已更新", questions: ["请确认以刚保存的正文重新核查？"] }) };
          yield { type: "completed", finishReason: "tool_calls" }; return;
        }
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new FactEdit());
  edit = () => {
    const project = f.storage.inspectProject("p")!;
    assert.equal(f.app.saveBody({ operationId: "edit-during-fact", projectId: "p", expectedProjectRevision: project.revision, baseBodyVersionId: project.latestBodyVersionId!, content: "# 新数据\n\n增长99%。", reason: "manual", actor: { kind: "user", id: "u" } }).ok, true);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, false);
    assert.notEqual(f.storage.getFactCheckStatus("p").status, "passed");
  } finally { f.close(); }
});

it("reconstructs a legacy run baseline from pre-start history, not the resumed current pointer", async () => {
  for (const changedAfterStart of [false, true]) {
  const f = setup(new CollaborationProvider());
  try {
    const prior = f.storage.commitArtifactVersion({ operationId: "legacy-body", projectId: "p", expectedProjectRevision: f.storage.inspectProject("p")!.revision, kind: "body", logicalKey: "main", baseVersionId: null, requestSnapshotId: null, content: "# 旧基线\n\n旧稿。", reason: "old body", actor: { kind: "user", id: "u" } });
    assert.equal(prior.ok, true); if (!prior.ok) return;
    f.storage.createSession({ sessionId: "legacy-session", projectId: "p", purpose: "writing-pack:draft" });
    f.storage.startRun({ runId: "legacy-run", sessionId: "legacy-session", projectId: "p", planVersion: "writing-pack-v1", budget: f.input.budget });
    if (changedAfterStart) assert.equal(f.app.saveBody({ operationId: "legacy-later-edit", projectId: "p", expectedProjectRevision: f.storage.inspectProject("p")!.revision, baseBodyVersionId: prior.result.versionId, content: "# 用户新正文\n\n这个新版本未经旧run授权。", reason: "manual edit", actor: { kind: "user", id: "u" } }).ok, true);
    f.storage.pauseRun({ projectId: "p", runId: "legacy-run", operationId: "pause-legacy", reason: "CO_CREATION_CHECKPOINT" });
    const result = await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, runId: "legacy-run", operationId: "resume-legacy", decision: "resume", userInstruction: "基于中断前的稿件继续完善。" }).result;
    if (changedAfterStart) {
      assert.equal(result.ok, false);
      assert.equal(f.storage.getRun("legacy-run")!.status, "waiting_user");
      assert.match(f.storage.getArtifactVersion(f.storage.inspectProject("p")!.latestBodyVersionId!)!.content, /未经旧run授权/u);
      continue;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    const assignment = f.storage.listRunEvents("legacy-run").map((event) => (event.payload.result as any)?.result?.collaboration).find((item) => item?.stage === "draft");
    assert.equal(assignment.expectedBodyVersionId, prior.result.versionId);
  } finally { f.close(); }
  }
});
