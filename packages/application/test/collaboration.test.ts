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
import { directorFixtureTurn, editorialPlanFixture, factPreparationFixtureEvents, publicStageFixtureEvents, readerSimulationFixtureEvents, revisionComparisonFixture } from './collaboration-fixture.js';
import type { ReviewFinding } from '../src/review-closure.js';
import { withCheckpointIntent, withIntentFixture } from './intent-fixture.js';
import { deliveredInlineMaterialIds, inlineMaterialContext } from '../src/material-context.js';
import { getConversationIntakeState } from '../src/conversation-intake.js';
import { parseEvidenceLedger, type ArtifactVersion } from '../../writing-core/src/index.js';
import { expandResearchEvidence } from '../src/research-evidence.js';
import { saveProjectStyleSelection } from '../src/style-selection.js';
import { styleStatistics, STYLE_APPLICATION_POLICY } from '../../writing-core/src/style-package.js';

export class CollaborationProvider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  constructor(readonly blocked = false) { super("collaboration-mock", "1.0.0", { protocol: "mock", tools: "supported", streaming: "supported", usage: "unknown" }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const reader = readerSimulationFixtureEvents(request);
    if (reader) { yield* reader; return; }
    const extraction = factPreparationFixtureEvents(request);
    if (extraction) { yield* extraction; return; }
    if (collaborationState(request)?.revisionReturn) { yield* directorFixtureTurn(request)!; return; }
    if (!request.messages.some(m => m.content.includes('COLLABORATION_STATE='))) {
      if (request.tools?.some(t => t.name === 'respond_author')) {
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'respond_author', argumentsDelta: JSON.stringify({ reply: '我们先讨论当前这一条，不交接下一位。' }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: '我们先讨论当前这一条，不交接下一位。' };
        yield { type: 'completed', finishReason: 'stop' };
      }
      return;
    }
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

for (const interruptedCommit of [false, true]) for (const action of ['resume_checkpoint', 'full_writing', 'fact_check', 'continue_title'] as const) it(`recovers persisted ${action} after process replacement without duplicate handoff (commit interrupted=${interruptedCommit})`, async () => {
  class HandoffProvider extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const tool = request.tools?.find(t => ['request_author_fact_check', 'request_author_full_writing', 'choose_publication'].includes(t.name));
      if (tool) {
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: tool.name,
          argumentsDelta: JSON.stringify(tool.name === 'choose_publication' ? { index: 1 } : {}) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new HandoffProvider();
  const f = setup(provider, action === 'resume_checkpoint' || action === 'continue_title' ? 'co_creation' : 'autonomous');
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    const first = await f.app.runDraft(f.input);
    if (action === 'continue_title') {
      for (let index = 0; index < 6; index++) await f.app.resumeDraft(withCheckpointIntent(f.storage, {
        ...f.input, runId: first.runId, operationId: `title-stage-${index}`, decision: 'resume', userInstruction: '继续',
        expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
      assert.equal(f.storage.getRun(first.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
    }
    const sessionId = f.storage.getRun(first.runId)!.sessionId;
    const text = { resume_checkpoint: '认同', full_writing: '请根据当前材料生成一份完整稿件',
      fact_check: '正文别动，只重新做一次事实核查', continue_title: '就用第一个吧' }[action];
    const source = f.app.startAuthorTurn({ projectId: 'p', sessionId, model: 'mock', parameters: {}, userInstruction: text });
    const finishRun = f.storage.finishRun.bind(f.storage);
    if (interruptedCommit) f.storage.finishRun = input => input.runId === source.runId && input.status === 'completed'
      ? f.storage.getRun(source.runId)! : finishRun(input);
    assert.equal((await source.result).ok, true);
    f.storage.finishRun = finishRun;
    if (interruptedCommit) {
      f.storage.recoverProjectRuns('p');
      assert.equal(f.storage.getRun(source.runId)?.status, 'interrupted');
    }
    const afterAuthor = provider.requests.length;
    const restarted = new WritingApplicationService({ storage: f.storage, provider: withIntentFixture(provider) });
    const model = { model: 'mock', parameters: {}, providerLabel: 'test', credentialReference: null, budget: f.input.budget };
    bridge = createApplicationBridge({ service: restarted, model, workspaceId: 'test' });
    for (let i = 0; i < 1000; i++) {
      await new Promise(r => setTimeout(r, 5));
      await bridge.refresh();
      if (!f.storage.listRuns('p').some(r => r.status === 'running')) break;
    }
    assert.ok(provider.requests.length > afterAuthor);
    const consumed = f.storage.listEvents('p').filter(e => ['run.started', 'run.resumed'].includes(e.type) && e.operationId.startsWith('workflow-handoff:'));
    assert.equal(consumed.length, 1);
    const count = provider.requests.length;
    bridge.dispose();
    bridge = createApplicationBridge({ service: new WritingApplicationService({ storage: f.storage, provider: withIntentFixture(provider) }), model, workspaceId: 'test' });
    await bridge.refresh();
    assert.equal(provider.requests.length, count);
    if (action === 'resume_checkpoint') assert.equal(f.storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'draft');
  } finally { bridge?.dispose(); f.close(); }
});

for (const parallelEnabled of [false, true]) it(`full workflow scopes external fact tools to checker only (enabled=${parallelEnabled})`, async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider);
  try {
    const app = new WritingApplicationService({ storage: f.storage, provider,
      factSearchConfiguration: () => ({ parallelEnabled, tavilyEnabled: false }) });
    const result = await app.runDraft(f.input);
    assert.equal(result.ok, true);
    const checks = provider.requests.filter(request => collaborationState(request)?.stage === 'fact_check');
    assert.ok(checks.length > 0);
    for (const request of provider.requests) {
      const expected = parallelEnabled && collaborationState(request)?.stage === 'fact_check' && !request.tools?.some(t => t.name === 'prepare_fact_check');
      assert.equal(request.tools?.some(tool => tool.name === 'search_fact_sources') ?? false, expected);
      assert.equal(request.tools?.some(tool => tool.name === 'read_fact_source') ?? false, expected);
      assert.equal(request.tools?.some(tool => tool.name === 'search_research_sources') ?? false,
        parallelEnabled && collaborationState(request)?.stage === 'research');
    }
    const verification = checks.find(request => (collaborationState(request) as any)?.factPhase === 'verify')!;
    assert.match(verification.messages[0]!.content, parallelEnabled ? /需要联网.*公开事实/u : /未启用外部搜索.*未联网/u);
  } finally { f.close(); }
});

it('optional front research uses configured Tavily before the outline and keeps final quota intact', async () => {
  class ResearchProvider extends CollaborationProvider {
    searches = 0;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'research' && this.searches < 2) {
        this.searches++; this.requests.push(request);
        assert.ok(request.tools?.some(t => t.name === 'search_research_sources'));
        yield { type: 'tool_call_delta', index: 0, id: `front-search-${this.searches}`, name: 'search_research_sources', argumentsDelta: JSON.stringify({ query: `主题关键公开背景 ${this.searches}` }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      if (collaborationState(request)?.actor === 'research' && this.searches > 0) {
        assert.ok(request.messages.some(m => m.role === 'tool' && m.content.includes('公开背景摘录')));
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new ResearchProvider(), f = setup(provider);
  const original = globalThis.fetch;
  let queries = 0;
  globalThis.fetch = async () => { queries++; return Response.json({ results: [{ url: 'https://example.com/fact', content: '公开背景摘录' }] }); };
  try {
    const app = new WritingApplicationService({ storage: f.storage, provider, factSearchConfiguration: () => ({
      parallelEnabled: false, tavilyEnabled: true, authorizationMode: 'enabled_services', getTavilyKey: async () => 'synthetic' }) });
    const result = await app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(queries, 2);
    assert.equal(f.storage.listRunEvents(result.runId).filter(e => e.type === 'tool.requested' && e.payload.toolName === 'search_research_sources').length, 2);
    const states = provider.requests.map(r => JSON.parse(r.messages.find(m => m.role === 'user')!.content.split('\nCOLLABORATION_STATE=')[1] ?? '{}'));
    assert.equal(states.find(s => s.factPhase === 'verify').searchBudget.used, 0);
  } finally { globalThis.fetch = original; f.close(); }
});

function setup(provider: CollaborationProvider, interactionMode: "autonomous" | "co_creation" = "autonomous", materialCount = 0, mode: 'quick' | 'deep' = 'quick', materialContent?: string, sourceKind: 'pasted_text' | 'web_snapshot' = 'pasted_text') {
  const path = mkdtempSync(join(tmpdir(), "writing-collaboration-"));
  const storage = openWorkspaceStorage({ workspacePath: path });
  const app = new WritingApplicationService({ storage, provider: withIntentFixture(provider) });
  const actor = { kind: "user", id: "u" } as const;
  app.createProject({ operationId: "project", projectId: "p", name: "test", mode, actor });
  for (let i = 0; i < materialCount; i++) {
    const imported = app.importMaterial({ operationId: `material-${i}`, projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision,
      materialId: `m-${i}`, displayName: `需求对话 ${i + 1}`, sourceKind, sourceReference: 'conversation', role: 'illustrative', trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: materialContent ?? `写安静的观察，要求 ${i}`, actor });
    assert.equal(imported.ok, true, JSON.stringify(imported));
  }
  const saved = app.saveWritingBrief({ operationId: "brief", projectId: "p", expectedProjectRevision: storage.inspectProject("p")!.revision, baseVersionId: null, actor, brief: { schemaVersion: 1, topic: "安静", genre: "narrative_observation", audience: "读者", lengthTarget: { targetCharacters: 800 }, materialIds: Array.from({ length: materialCount }, (_, i) => `m-${i}`), constraints: [], interactionMode, authorAuthorization: { voice: "克制", styleReference: null, styleDecision: "user_confirmed", directionDecision: "user_confirmed", firsthandMaterialIds: [] }, platform: null, publicationGoal: "not_applicable", confirmationStatus: "confirmed" } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const project = storage.inspectProject("p")!;
  return { storage, app, input: { projectId: "p", expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, model: "mock", parameters: {}, budget: { maxModelRequests: 60, maxToolCalls: 80, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } }, close() { storage.close(); rmSync(path, { recursive: true, force: true }); } };
}

for (const version of [2, 3] as const) it(`uses v${version} project style across writing stages without leaking samples into fact checks or reader simulations`, async () => {
  const provider = new CollaborationProvider(); const f = setup(provider);
  const marker = '独特的风格测试标记';
  try {
    const quote = '一段有前后关系的句式。'.repeat(40) + '\n\n末尾的落点。';
    const card = version === 3 ? marker.repeat(420) + '指南末尾条件' : marker;
    saveProjectStyleSelection(f.storage, 'p', { id: 'style', version: 1, name: '克制观察', card,
      package: { version, statistics: styleStatistics([{ id: 's', title: '样文', text: quote }]),
        patterns: [{ kind: 'structure', instruction: '先观察后解释' }], snippets: [{ sampleId: 's', paragraphId: 'p1', kind: 'opening', quote, explanation: '写法解释标记', application: '换题迁移标记' }] } }, 'style-select');
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const stage of ['outline', 'draft', 'central_revision']) {
      const requests = provider.requests.filter(r => collaborationState(r)?.stage === stage);
      assert.ok(requests.length > 0, stage);
      assert.ok(requests.every(r => r.messages.some(m => m.content.includes(card) && m.content.includes(quote) && m.content.includes('换题迁移标记'))), stage);
      assert.ok(requests.every(r => r.messages.some(m => m.role === 'system' && m.content.includes(STYLE_APPLICATION_POLICY))), stage);
      assert.ok(requests.every(r => r.messages.some(m => m.role === 'system' && m.content.includes(stage === 'outline' ? '内部评估不进提纲' : '面向读者的解释与向作者汇报写作过程'))), stage);
    }
    const audit = provider.requests.filter(r => collaborationState(r)?.stage === 'language_review');
    assert.ok(audit.length > 0);
    assert.ok(audit.every(r => !JSON.stringify(r.messages).includes(marker)));
    const facts = provider.requests.filter(r => collaborationState(r)?.stage === 'fact_check');
    assert.ok(facts.length > 0);
    assert.ok(facts.every(r => !JSON.stringify(r.messages).includes(marker)));
    const reader = provider.requests.filter(r => collaborationState(r)?.stage === 'review_reader');
    assert.ok(reader.length > 0);
    assert.ok(reader.every(r => !JSON.stringify(r.messages).includes(marker)));
    const editor = provider.requests.filter(r => collaborationState(r)?.stage === 'review_editor');
    assert.ok(editor.length > 0);
    assert.ok(editor.every(r => !JSON.stringify(r.messages).includes(marker)));
    const gate = f.app.getProjectProjection('p').factCheck.status;
    f.app.selectProjectStyle('p', null, 'clear-after-completion');
    assert.equal(f.app.getProjectProjection('p').factCheck.status, gate, 'style selection alone must not invalidate unchanged body facts');
  } finally { f.close(); }
});

it('confirmed stage handoffs retain the style through title generation', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider, 'co_creation');
  try {
    const card = '标题应短、具体，保留独特测试标记'.repeat(240) + '标题指南末尾';
    saveProjectStyleSelection(f.storage, 'p', { id: 's', version: 1, name: '标题风格', card,
      package: { version: 3, statistics: styleStatistics([{ id: 's', title: '标题示范', text: '连续标题示例' }]), patterns: [],
        snippets: [{ sampleId: 's', paragraphId: 'p1', kind: 'title', quote: '连续标题示例', explanation: '标题写法分析', application: '标题迁移条件' }] } }, 'style');
    const first = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision });
    for (let index = 0; index < 7 && !provider.requests.some(r => collaborationState(r)?.stage === 'title'); index++) {
      await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: `style-continue-${index}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
    }
    const requests = provider.requests.filter(r => collaborationState(r)?.stage === 'title');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(r => r.messages.some(m => m.content.includes(card) && m.content.includes('连续标题示例') && m.content.includes('标题迁移条件'))));
  } finally { f.close(); }
});

it('provides short authorized materials on the first request without tool-read round trips', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation', 4);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.status, 'waiting_user');
    assert.equal(f.storage.listRunEvents(result.runId).findLast(e=>e.type==='run.waiting_user')?.payload.stage, 'outline');
    const first = collaborationState(provider.requests[0]!)!;
    assert.equal(first.materials.length, 4);
    assert.equal(f.storage.listRunEvents(result.runId).filter(e=>e.type==='tool.requested'&&e.payload.toolName==='read_material').length, 0);
    const research = provider.requests.find(r=>collaborationState(r)?.actor==='research')!;
    assert.ok(!research.tools?.some(t=>t.name==='read_artifact_version'), 'no artifact reader when only materials are available');
  } finally { f.close(); }
});

it('bounds inline context without truncation or silently crediting missing or changed inputs', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider, 'co_creation', 1);
  try {
    const material = f.storage.listMaterials('p')[0]!;
    assert.deepEqual(inlineMaterialContext([{ ...material, content: '字'.repeat(6001) }]), []);
    assert.equal(inlineMaterialContext(Array.from({ length: 3 }, (_, i) => ({ ...material, id: String(i), content: '字'.repeat(6000) }))).length, 2);
    const unicode = inlineMaterialContext([{ ...material, content: '🌿'.repeat(4000) }])[0] as Record<string, unknown>;
    assert.equal(unicode.nextOffset, 4000);
    assert.equal(unicode.content, '🌿'.repeat(4000));
    assert.equal(unicode.instructionAuthority, 'none');
    assert.ok(!('sourceReference' in unicode), 'do not disclose local source paths');
    const result = await f.app.runDraft(f.input);
    const event = f.storage.listRunEvents(result.runId).find(e => e.type === 'request.dispatch_attempted')!;
    const snapshot = f.storage.getRequestSnapshot(event.payload.snapshotId as string)!;
    const proofStore = { listRunEvents: () => [event], getRequestSnapshot: () => snapshot };
    assert.deepEqual(deliveredInlineMaterialIds(proofStore, result.runId, [material]), [material.id]);
    assert.deepEqual(deliveredInlineMaterialIds({ ...proofStore, listRunEvents: () => [] }, result.runId, [material]), []);
    assert.deepEqual(deliveredInlineMaterialIds({ ...proofStore, getRequestSnapshot: () => ({ ...snapshot, runId: 'other' }) }, result.runId, [material]), []);
    assert.deepEqual(deliveredInlineMaterialIds(proofStore, result.runId, []), []);
    for (const patch of [
      { content: '新内容' }, { contentVersionId: 'new-version' }, { role: 'source_verified' as const },
      { trustLabel: 'external_untrusted' as const }, { projectId: 'other-project' },
    ]) assert.deepEqual(deliveredInlineMaterialIds(proofStore, result.runId, [{ ...material, ...patch }]), [], JSON.stringify(patch));
    for (const patch of [{ offset: 1 }, { nextOffset: 1 }, { totalChars: 1 }, { truncated: true }, { delivery: 'partial' }, { permissionScope: 'public' }, { instructionAuthority: 'system' }]) {
      const altered = structuredClone(snapshot);
      const message = altered.request.messages.find(m => m.role === 'user')!;
      const [prefix, json] = message.content.split('\nCOLLABORATION_STATE=');
      const state = JSON.parse(json!); Object.assign(state.materials[0], patch);
      Object.assign(message, { content: `${prefix}\nCOLLABORATION_STATE=${JSON.stringify(state)}` });
      assert.deepEqual(deliveredInlineMaterialIds({ ...proofStore, getRequestSnapshot: () => altered }, result.runId, [material]), [], JSON.stringify(patch));
    }
  } finally { f.close(); }
});

for (const missingReadiness of [false, true]) it(`combined dispatch still rejects missing input or readiness (missing readiness=${missingReadiness})`, async () => {
  const provider = new class extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request)!;
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'director_decide', argumentsDelta: JSON.stringify({
        action: 'dispatch', stage: state.nextStage, reason: '开始研究', questions: [],
        ...(!missingReadiness ? { readinessReason: '声称已读全部材料' } : {}),
      }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }();
  const f = setup(provider, 'co_creation', 1, 'quick', '长材料'.repeat(2100));
  try {
    const result = await f.app.runDraft({ ...f.input, budget: { ...f.input.budget, maxModelRequests: 1 } });
    const failed = f.storage.listRunEvents(result.runId).find(e => e.type === 'tool.failed');
    assert.equal((failed?.payload.result as any)?.error?.code, missingReadiness ? 'WRITING_READINESS_REQUIRED' : 'READINESS_MATERIAL_READ_REQUIRED');
    assert.equal(f.storage.listArtifactVersions('p', 'evidence', 'ledger').length, 0);
  } finally { f.close(); }
});

it('combines a version-checked readiness decision and dispatch without skipping author checkpoints', async () => {
  class CombinedProvider extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'director' && !state.ready) {
        this.requests.push(structuredClone(request));
        yield {type:'tool_call_delta',index:0,id:request.requestId,name:'director_decide',argumentsDelta:JSON.stringify({
          action:'dispatch',stage:state.nextStage,reason:'按已确认方向完成当前阶段。',questions:[],readinessReason:'当前材料足够，无待作者补充的问题。',
        })};
        yield {type:'completed',finishReason:'tool_calls'}; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new CombinedProvider(); const f=setup(provider,'co_creation',4);
  try {
    const result=await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.status,'waiting_user');
    assert.equal(provider.requests.length,4, 'two director decisions plus research and outline');
    assert.equal(f.storage.listArtifactVersions('p','report',`workflow:${result.runId}:draft`).length,0);
    assert.throws(()=>f.app.resumeDraft({...f.input,runId:result.runId,operationId:'unapproved',decision:'resume',userInstruction:'我不认可，先讨论',expectedProjectRevision:f.storage.inspectProject('p')!.revision}), { code: 'CHECKPOINT_DECISION_REQUIRED' });
  } finally {f.close();}
});

const compactResearch = () => ({
  sources: [{ source_id: 'S1', source_title: '材料原文', source_publisher: '用户提供', accessed_at: '本次运行', source_url: 'http://example.com/article' }],
  claims: Array.from({ length: 20 }, (_, i) => ({ source_id: 'S1', claim_type: 'other', claim_text: `仅支持观察${i + 1}`,
    source_quote: `原文限定句${i + 1}`, reliability: 'medium', use_boundary: '只支持所述范围，不能推断效果。', verification_status: 'user_provided' })),
  notes: '关键事实仍需独立核查，不外推。',
});

class CompactResearchProvider extends CollaborationProvider {
  constructor(readonly content: unknown) { super(); }
  protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    if (collaborationState(request)?.actor === 'research') {
      this.requests.push(structuredClone(request));
      yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: 'research', content: this.content })!;
      return;
    }
    yield* super.providerStream(request);
  }
}

it('bounds expanded research size without truncating or allocating the whole amplified ledger', () => {
  const content = compactResearch();
  content.sources[0]!.source_title = '来源'.repeat(100_000);
  assert.throws(() => expandResearchEvidence(content), /size|large/i);
});

it('assigns deterministic evidence IDs around explicit IDs and preserves independent sources', () => {
  const content = compactResearch();
  content.sources.push({ ...content.sources[0]!, source_id: 'S2', source_title: '另一来源', source_url: 'https://example.com/second' });
  const mixed = { ...content, claims: content.claims.slice(0, 3).map((c, i) => ({ ...c,
    ...(i === 1 ? { evidence_id: 'E001', source_id: 'S2' } : {}) })) };
  const expanded = expandResearchEvidence(mixed) as any;
  assert.deepEqual(expandResearchEvidence(mixed), expanded, 'retry expansion is stable');
  assert.deepEqual(expanded.claims.map((c: any) => c.evidence_id), ['E002', 'E001', 'E003']);
  assert.deepEqual(expanded.claims.map((c: any) => c.source_url), ['http://example.com/article', 'https://example.com/second', 'http://example.com/article']);
  assert.equal(parseEvidenceLedger(JSON.stringify(expanded)).evidenceIds.size, 3);
});

for (const asString of [false, true]) it(`expands compact research without losing evidence or bypassing outline confirmation (string=${asString})`, async () => {
  const compact = compactResearch();
  const provider = new CompactResearchProvider(asString ? JSON.stringify(compact) : compact);
  const f = setup(provider, 'co_creation');
  try {
    const result = await f.app.runDraft(f.input);
    const evidence = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.currentEvidenceVersionId!)!;
    assert.ok(evidence, 'compact research must be saved');
    const { source_id, ...source } = compact.sources[0]!;
    const claims = compact.claims.map(({ source_id: ref, ...claim }, i) => ({ ...source, ...claim, evidence_id: `E${String(i + 1).padStart(3, '0')}` }));
    const expected = { claims, notes: compact.notes, editorialPlan: editorialPlanFixture(claims.map(claim => claim.evidence_id)) };
    assert.deepEqual(JSON.parse(evidence.content), expected);
    assert.equal(parseEvidenceLedger(evidence.content).evidenceIds.size, 20);
    assert.equal(f.storage.getRun(result.runId)?.status, 'waiting_user');
    assert.equal(f.storage.listRunEvents(result.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'outline');
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 0);
    assert.notEqual(f.storage.getFactCheckStatus('p').status, 'passed');
    const research = provider.requests.find(r => collaborationState(r)?.actor === 'research')!;
    assert.match(JSON.stringify(research.tools?.find(t => t.name === 'submit_writing_stage')?.inputSchema), /source_id/);
    assert.ok(JSON.stringify({ stage: 'research', content: compact }).length < JSON.stringify({ stage: 'research', content: JSON.stringify(expected) }).length * 0.8);
    const next = provider.requests.find(r => collaborationState(r)?.actor === 'outline')!;
    assert.ok(next.messages.some(m => m.content.includes('E020')), 'downstream receives canonical evidence IDs');
  } finally { f.close(); }
});

for (const defect of ['unknown-source', 'duplicate-source', 'empty-quote', 'missing-boundary', 'duplicate-evidence', 'bad-url']) it(`rejects compact research with ${defect} without saving partial evidence`, async () => {
  const content: any = compactResearch();
  if (defect === 'unknown-source') content.claims[0].source_id = 'missing';
  if (defect === 'duplicate-source') content.sources.push({ ...content.sources[0] });
  if (defect === 'empty-quote') content.claims[0].source_quote = '';
  if (defect === 'missing-boundary') delete content.claims[0].use_boundary;
  if (defect === 'duplicate-evidence') { content.claims[0].evidence_id = 'E001'; content.claims[1].evidence_id = 'E001'; }
  if (defect === 'bad-url') content.sources[0].source_url = 'file:///private';
  const f = setup(new CompactResearchProvider(content), 'co_creation');
  try {
    const result = await f.app.runDraft({ ...f.input, budget: { ...f.input.budget, maxModelRequests: 4 } });
    assert.equal(f.storage.inspectProject('p')!.currentEvidenceVersionId, null);
    assert.notEqual(f.storage.getRun(result.runId)?.status, 'completed');
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 0);
  } finally { f.close(); }
});

it('allows empty compact research and explicit illustrative evidence without inventing verified sources', async () => {
  for (const content of [
    { sources: [], claims: [], notes: '只有主观感受，无外部事实。' },
    { ...compactResearch(), claims: [{ ...compactResearch().claims[0]!, evidence_id: 'E042', source_quote: '', verification_status: 'illustrative' }] },
  ]) {
    const f = setup(new CompactResearchProvider(content), 'co_creation');
    try {
      await f.app.runDraft(f.input);
      const saved = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.currentEvidenceVersionId!);
      assert.ok(saved);
      const ledger = JSON.parse(saved.content);
      if (content.claims.length) {
        assert.equal(ledger.claims[0].evidence_id, 'E042');
        assert.equal(ledger.claims[0].verification_status, 'illustrative');
        assert.equal(ledger.claims[0].source_quote, '');
      } else assert.deepEqual(ledger, { claims: [], notes: content.notes, editorialPlan: editorialPlanFixture([]) });
    } finally { f.close(); }
  }
});

it('scopes research to supplied evidence without demanding unavailable searches or doing the outline', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider, 'co_creation', 1);
  try {
    await f.app.runDraft(f.input);
    const request = provider.requests.find(r => collaborationState(r)?.actor === 'research')!;
    const system = request.messages[0]!.content;
    assert.match(system, /材料整理模式/);
    assert.match(system, /没有外部搜索工具/);
    assert.match(system, /关键.*缺口.*(?:暂停|提问)/);
    assert.match(system, /排除.*notes/);
    assert.match(system, /不.*(?:开头|结尾).*提纲/);
    assert.doesNotMatch(system, /主动寻找最强反证|对准备进入正文的外部事实逐项核查|director_decide省略inputVersionIds/);
    assert.ok(!request.tools?.some(t => t.name === 'search_fact_sources'));
    const schema = request.tools?.find(tool => tool.name === 'submit_writing_stage')?.inputSchema as {
      properties: { content: { anyOf: { type: string; required?: string[] }[] } };
    };
    const researchContent = schema.properties.content.anyOf.find(option => option.type === 'object');
    assert.ok(researchContent?.required?.includes('editorialPlan'), 'provider-visible schema must require the editorial plan');
    assert.deepEqual(request.parameters, { toolChoice: 'required' }, 'no model effort or token limit change');
  } finally { f.close(); }
});

it('fact check uses selected facts and evidence, without repeating writing instructions or original materials', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider, 'autonomous', 1);
  try {
    const result = await f.app.runDraft({ ...f.input, userInstruction: '数字如有冲突请标明，保留我的判断。' });
    assert.equal(result.ok, true);
    const request = provider.requests.find(r => collaborationState(r)?.actor === 'fact_check')!;
    const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    assert.equal(state.materialCatalog, undefined);
    assert.equal(state.factPhase, 'verify');
    assert.equal(state.artifacts.find((a: any) => a.kind === 'body').content.projection, 'fact_article_catalog');
    assert.ok(request.tools?.some(t => t.name === 'read_fact_article'));
    assert.equal(typeof state.artifacts.find((a: any) => a.kind === 'evidence').content, 'object');
    assert.equal(state.authorAuthorization, undefined);
    assert.ok(Array.isArray(state.preparedClaims));
    assert.match(request.messages[0]!.content, /重要、易错或疑似错误/u);
    assert.ok(request.messages[0]!.content.length < 1400);
    assert.doesNotMatch(request.messages[1]!.content, /必须先用 read_material|约 800 字符/);
    assert.ok(!request.tools?.some(t => t.name === 'read_artifact_version'), 'no reread tool when bound artifacts already provided in full');
    assert.equal(request.tools?.some(t => t.name === 'read_material'), false, 'specialist compares prepared facts, not the original writing packet');
  } finally { f.close(); }
});

it('projects evidence and original sources for non-blind downstream experts, with on-demand source access', async () => {
  class RevisionReadProvider extends CompactResearchProvider {
    readEvidence = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (!this.readEvidence && state?.actor === 'central_revision') {
        this.readEvidence = true;
        this.requests.push(structuredClone(request));
        const evidence = state.artifacts!.find(artifact => artifact.kind === 'evidence')!;
        yield { type: 'tool_call_delta', index: 0, id: 'revision-read-evidence', name: 'read_artifact_version', argumentsDelta: JSON.stringify({ versionId: evidence.id }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const research = compactResearch();
  const provider = new RevisionReadProvider({ ...research, claims: research.claims.slice(0, 1) });
  const f = setup(provider, 'autonomous', 1, 'quick', '外部资料原文', 'web_snapshot');
  try {
    assert.equal((await f.app.runDraft(f.input)).ok, true);
    for (const actor of ['outline', 'draft', 'central_revision']) {
      const request = provider.requests.find(r => collaborationState(r)?.actor === actor)!;
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
      assert.equal(typeof state.artifacts.find((a: any) => a.kind === 'evidence').content, 'object', actor);
      assert.ok(Array.isArray(state.materialCatalog), actor);
      assert.ok(request.tools?.some(t => t.name === 'read_material'), `${actor} can read omitted material if needed`);
      assert.ok(request.tools?.some(t => t.name === 'read_artifact_version'), `${actor}: projected evidence remains readable on demand`);
    }
    const language = provider.requests.find(request => collaborationState(request)?.actor === 'language_review')!;
    const auditEvidence = collaborationState(language)!.artifacts?.find(artifact => artifact.kind === 'evidence')?.content as { claims: { source_quote: string }[] };
    assert.equal(auditEvidence.claims[0]!.source_quote, research.claims[0]!.source_quote);
    assert.deepEqual(language.tools ?? [], []);
    assert.equal(language.parameters.toolChoice, 'none');
    assert.doesNotMatch(language.messages[1]!.content, /外部资料原文|editorialPlan/u);
    const revisionRead = provider.requests.find(request => collaborationState(request)?.actor === 'central_revision' &&
      request.messages.some(message => message.role === 'tool' && message.name === 'read_artifact_version'))!;
    const response = revisionRead.messages.find(message => message.role === 'tool' && message.name === 'read_artifact_version')!;
    const evidence = JSON.parse(response.content).result;
    assert.equal(evidence.requestProjection, 'lossless_evidence_table', 'a narrowed plan must not be counted as a complete read');
    assert.equal(evidence.content.editorialPlan, undefined, 'reading evidence must not restore internal plans');
    assert.equal(evidence.content.claimRows[0][evidence.content.claimFields.indexOf('source_quote')], research.claims[0]!.source_quote);
    const editor = provider.requests.find(r => collaborationState(r)?.actor === 'review_editor')!;
    assert.equal(editor.tools, undefined);
    assert.deepEqual(collaborationState(editor)?.artifacts?.map(a => a.kind), ['body']);
  } finally { f.close(); }
});

it('keeps pasted external originals on demand while carrying complete author material into writing', async () => {
  const external = '外部网页复制全文哨兵，只在按需读取时可见。';
  const firsthand = '作者亲历全文哨兵。我走过窗边，听到脚步声。';
  const requirement = '作者写作要求全文哨兵。保留结尾，不加操作步骤。';
  class ReadPastedSource extends CollaborationProvider {
    sourceVersionId = '';
    sourceRead = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage === 'outline' && !this.sourceRead) {
        this.sourceRead = true;
        this.requests.push(structuredClone(request));
        assert.ok(request.tools?.some(tool => tool.name === 'read_material'));
        yield { type: 'tool_call_delta', index: 0, id: 'read-pasted-external', name: 'read_material',
          argumentsDelta: JSON.stringify({ materialId: 'pasted-external', contentVersionId: this.sourceVersionId, offset: 0, maxChars: 1000 }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new ReadPastedSource();
  const f = setup(provider);
  try {
    const actor = { kind: 'user', id: 'u' } as const;
    const materials = [
      { materialId: 'pasted-external', content: external, role: 'illustrative', trustLabel: 'external_untrusted' },
      { materialId: 'firsthand', content: firsthand, role: 'user_firsthand', trustLabel: 'user_provided_untrusted' },
      { materialId: 'intake-user-requirement', content: requirement, role: 'illustrative', trustLabel: 'user_provided_untrusted' },
    ] as const;
    for (const material of materials) {
      assert.equal(f.app.importMaterial({ ...material, operationId: `import:${material.materialId}`, projectId: 'p', actor,
        expectedProjectRevision: f.storage.inspectProject('p')!.revision, displayName: material.materialId,
        sourceKind: 'pasted_text', sourceReference: 'test fixture', permissionScope: 'project_only' }).ok, true);
    }
    provider.sourceVersionId = f.storage.listMaterials('p').find(material => material.id === 'pasted-external')!.contentVersionId;
    const briefId = f.storage.inspectProject('p')!.currentBriefVersionId!;
    const brief = f.storage.getWritingBriefVersion(briefId)!.brief;
    assert.equal(f.app.saveWritingBrief({ operationId: 'bind-source-and-author', projectId: 'p', actor,
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, baseVersionId: briefId,
      brief: { ...brief, materialIds: materials.map(material => material.materialId),
        authorAuthorization: { ...brief.authorAuthorization, firsthandMaterialIds: ['firsthand'] } } }).ok, true);
    const project = f.storage.inspectProject('p')!;
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId! });
    assert.equal(result.ok, true, JSON.stringify(result));
    const requests = provider.requests.filter(request => ['outline', 'draft'].includes(collaborationState(request)?.stage ?? ''));
    assert.deepEqual([...new Set(requests.map(request => collaborationState(request)?.stage))], ['outline', 'draft']);
    for (const request of requests) {
      const userMessage = request.messages.find(message => message.role === 'user')!.content;
      assert.ok(userMessage.includes(firsthand));
      assert.ok(userMessage.includes(requirement));
      assert.ok(!userMessage.includes(external), 'source bodies stay out of writing input even after a different scope reads them');
      assert.ok(request.tools?.some(tool => tool.name === 'read_material'));
    }
    const followup = requests.find(request => request.messages.some(message => message.role === 'tool' && message.name === 'read_material'))!;
    const read = followup.messages.find(message => message.role === 'tool' && message.name === 'read_material')!;
    const envelope = JSON.parse(read.content);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.content, external);
    assert.equal(envelope.result.contentVersionId, provider.sourceVersionId);
  } finally { f.close(); }
});

it('keeps director dispatch lean while specialists still receive the complete version-bound article', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider);
  try {
    assert.equal((await f.app.runDraft(f.input)).ok, true);
    const request = provider.requests.find(r => {
      const s: any = collaborationState(r);
      return s?.actor === 'director' && s.artifacts.some((a: any) => a.kind === 'body');
    })!;
    const state: any = collaborationState(request);
    const body = state.artifacts.find((a: any) => a.kind === 'body');
    assert.equal(body.content.projection, 'artifact_catalog', 'dispatch must not resend the whole article');
    assert.equal(body.content.contentAvailableVia, 'read_artifact_version');
    assert.ok(request.tools?.some(t => t.name === 'read_artifact_version'));
    for (const actor of ['review_editor', 'central_revision', 'language_review']) {
      const s: any = collaborationState(provider.requests.find(r => collaborationState(r)?.actor === actor)!);
      assert.match(s.artifacts.find((a: any) => a.kind === 'body').content, /我喜欢这样的安静/);
    }
    const readers = provider.requests.filter(r => r.messages[0]?.content.startsWith('READER_SIMULATION_V1='));
    assert.equal(readers.length, 3);
    for (const reader of readers) {
      assert.match(reader.messages[1]!.content, /我喜欢这样的安静/);
      assert.doesNotMatch(reader.messages[1]!.content, /evidence|materialCatalog|SECRET_OPINION/);
      assert.equal(reader.tools?.length ?? 0, 0);
    }
  } finally { f.close(); }
});

it('cold editor receives the bound draft and reader fields without assignment, style, evidence or tool history', async () => {
  class ColdReadProvider extends CompactResearchProvider {
    readOutline = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (!this.readOutline && state?.actor === 'director' && state.nextStage === 'draft') {
        this.readOutline = true;
        const outline = state.artifacts!.find(a => a.kind === 'outline')!;
        yield { type: 'tool_call_delta', index: 0, id: 'cold-history', name: 'read_artifact_version', argumentsDelta: JSON.stringify({ versionId: outline.id }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new ColdReadProvider({ sources: [], claims: [], notes: '研究内容哨兵' });
  const f = setup(provider, 'autonomous', 1, 'quick', '素材内容哨兵');
  try {
    saveProjectStyleSelection(f.storage, 'p', { id: 'cold-style', version: 1, name: '风格名称哨兵', card: '风格内容哨兵',
      package: { version: 3, statistics: styleStatistics([{ id: 'sample', title: '样文', text: '样文内容哨兵' }]), patterns: [],
        snippets: [{ sampleId: 'sample', paragraphId: 'p1', kind: 'opening', quote: '样文内容哨兵', explanation: '样文解释哨兵', application: '样文用法哨兵' }] } }, 'cold-style');
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, userInstruction: '原始用户消息哨兵' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const events = f.storage.listRunEvents(result.runId);
    assert.ok(events.some(event => event.type === 'tool.completed' && (event.payload.result as any)?.toolName === 'read_artifact_version'));
    const editor = provider.requests.find(r => collaborationState(r)?.actor === 'review_editor')!;
    const state = collaborationState(editor)!;
    const draft = f.storage.listArtifactVersions('p', 'body', 'main')[0]!;
    assert.deepEqual(state.artifacts, [{ id: draft.id, kind: 'body', content: draft.content }]);
    assert.deepEqual(state.inputVersionIds, [draft.id]);
    assert.deepEqual(editor.messages.map(message => message.role), ['system', 'user']);
    assert.equal(editor.tools, undefined);
    assert.equal(editor.parameters.toolChoice, 'none');
    assert.match(editor.messages[1]!.content, /"audience":"读者"/u);
    assert.doesNotMatch(JSON.stringify(editor.messages), /哨兵|按输入版本推进|editorialPlan|read_artifact_version|"kind":"outline"/u);
    const review = f.storage.listArtifactVersions('p', 'review', `review_editor:${result.runId}`)[0]!;
    assert.equal(JSON.parse(review.content).bodyVersionId, draft.id);
  } finally { f.close(); }
});

it('publication reviewer receives the same draft and exact source quotes without inherited editorial opinions', async () => {
  const sourceText = '授权来源完整原文哨兵。受访者在实验中判断是否采信自报工时。';
  const quote = '受访者在实验中判断是否采信自报工时。';
  const base = compactResearch();
  const plan = editorialPlanFixture(['E001']);
  plan.angles[0]!.angle = '选题计划私有哨兵';
  plan.angles[1]!.angle = '淘汰切口私有哨兵';
  class PublicationProvider extends CompactResearchProvider {
    sourceVersionId = '';
    sourceRead = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'review_publish' && !this.sourceRead) {
        this.sourceRead = true;
        this.requests.push(structuredClone(request));
        yield { type: 'tool_call_delta', index: 0, id: 'publish-read-source', name: 'read_material',
          argumentsDelta: JSON.stringify({ materialId: 'publication-source', contentVersionId: this.sourceVersionId, offset: 0, maxChars: 1000 }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new PublicationProvider({ ...base, editorialPlan: plan, notes: '研究解读私有哨兵',
    claims: [{ ...base.claims[0]!, evidence_id: 'E001', claim_text: '研究主张私有哨兵', source_quote: quote, use_boundary: '只测是否采信自报工时，不能推广为主管对员工的总体信任。' }] });
  const f = setup(provider, 'autonomous', 0, 'deep');
  try {
    const actor = { kind: 'user', id: 'u' } as const;
    for (const materialId of ['publication-source', 'unbound-publication-source']) {
      assert.equal(f.app.importMaterial({ projectId: 'p', operationId: `add-${materialId}`, materialId, actor,
        expectedProjectRevision: f.storage.inspectProject('p')!.revision, displayName: materialId,
        sourceKind: 'pasted_text', sourceReference: 'fixture', role: 'illustrative', trustLabel: 'external_untrusted', permissionScope: 'project_only',
        content: materialId === 'publication-source' ? sourceText : '未授权来源私有哨兵' }).ok, true);
    }
    provider.sourceVersionId = f.storage.listMaterials('p').find(material => material.id === 'publication-source')!.contentVersionId;
    saveProjectStyleSelection(f.storage, 'p', { id: 'publication-style', version: 1, name: '隔离风格', card: '风格私有哨兵' }, 'publish-style');
    const briefId = f.storage.inspectProject('p')!.currentBriefVersionId!;
    const brief = f.storage.getWritingBriefVersion(briefId)!.brief;
    assert.equal(f.app.saveWritingBrief({ projectId: 'p', actor, operationId: 'bind-publication-source', baseVersionId: briefId,
      expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      brief: { ...brief, materialIds: ['publication-source'], audience: '普通职场读者', platform: '微信公众号', constraints: ['全文要求私有哨兵'] } }).ok, true);
    const project = f.storage.inspectProject('p')!;
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, userInstruction: '本次要求私有哨兵' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const reviews = provider.requests.filter(request => collaborationState(request)?.actor === 'review_publish');
    assert.equal(reviews.length, 2);
    const first = reviews[0]!;
    const state = collaborationState(first)!;
    const draft = f.storage.listArtifactVersions('p', 'body', 'main')[0]!;
    assert.deepEqual(state.artifacts?.find(artifact => artifact.kind === 'body'), { id: draft.id, kind: 'body', content: draft.content });
    const evidence = state.artifacts?.find(artifact => artifact.kind === 'evidence')!.content as { claims: Record<string, string>[] };
    assert.equal(evidence.claims[0]!.source_quote, quote);
    assert.equal(evidence.claims[0]!.source_title, base.sources[0]!.source_title);
    assert.equal(evidence.claims[0]!.source_publisher, base.sources[0]!.source_publisher);
    assert.equal(evidence.claims[0]!.source_url, base.sources[0]!.source_url);
    assert.match(evidence.claims[0]!.use_boundary!, /自报工时/u);
    assert.deepEqual(first.messages.map(message => message.role), ['system', 'user']);
    assert.match(first.messages[1]!.content, /普通职场读者.*微信公众号/u);
    assert.doesNotMatch(JSON.stringify(first.messages), /私有哨兵|按输入版本推进|SECRET_OPINION_review_editor|editorialPlan|claim_text|全文哨兵|unbound-publication-source/u);
    assert.ok(!first.messages[1]!.content.includes(sourceText));
    assert.deepEqual(first.tools?.map(tool => tool.name).sort(), ['assess_writing_readiness', 'read_material']);
    const read = reviews[1]!.messages.find(message => message.role === 'tool' && message.name === 'read_material')!;
    assert.equal(JSON.parse(read.content).result.content, sourceText);
    const finalReview = provider.requests.find(request => collaborationState(request)?.actor === 'language_review')!;
    const finalState = JSON.parse(finalReview.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    assert.ok(finalState.sourceSlices.some((slice: { content: string }) => slice.content.includes(sourceText)), 'terminal review receives the exact source excerpt actually read by publication review');
    assert.doesNotMatch(JSON.stringify(finalState), /选题计划私有哨兵|淘汰切口私有哨兵|SECRET_OPINION_review_editor/u);
    for (const stage of ['review_editor', 'review_publish']) {
      const saved: ArtifactVersion = f.storage.listArtifactVersions('p', 'review', `${stage}:${result.runId}`)[0]!;
      assert.equal(JSON.parse(saved.content).bodyVersionId, draft.id);
    }
    for (const stage of ['central_revision', 'language_review']) {
      for (const request of provider.requests.filter(request => {
        const state = collaborationState(request);
        return state?.stage === stage || state?.actor === 'director' && state.nextStage === stage;
      })) {
        const message = request.messages[1]!.content;
        assert.doesNotMatch(message, /淘汰切口私有哨兵/u);
        assert.equal(message.includes('选题计划私有哨兵'), stage === 'central_revision');
      }
    }
  } finally { f.close(); }
});

for (const stage of ['review_editor', 'review_publish'] as const) {
it(`pauses ${stage} before requesting a review of a draft changed by the author`, async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'autonomous', 0, stage === 'review_publish' ? 'deep' : 'quick');
  try {
    const settle = f.storage.settleRuntimeOperation.bind(f.storage);
    let authorBodyId: string | null = null;
    f.storage.settleRuntimeOperation = input => {
      const settled = settle(input);
      const assignment = (input.eventPayload.result as { result?: { collaboration?: { stage?: string; status?: string } } } | undefined)?.result?.collaboration;
      if (authorBodyId === null && assignment?.stage === stage && assignment.status === 'dispatched') {
        const project = f.storage.inspectProject('p')!;
        assert.ok(project.latestBodyVersionId);
        const saved = f.app.saveBody({ projectId: 'p', operationId: 'edit-before-review-request', expectedProjectRevision: project.revision,
          baseBodyVersionId: project.latestBodyVersionId, content: '# 作者改稿\n\n审校请求前由作者保存。', reason: 'manual', actor: { kind: 'user', id: 'u' } });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        authorBodyId = f.storage.inspectProject('p')!.latestBodyVersionId;
      }
      return settled;
    };
    const result = await f.app.runDraft(f.input);
    assert.ok(authorBodyId);
    assert.equal(result.ok, false);
    assert.equal(f.storage.getRun(result.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, authorBodyId);
    assert.ok(!provider.requests.some(request => collaborationState(request)?.stage === stage));
    assert.equal(f.storage.listArtifactVersions('p', 'review', `${stage}:${result.runId}`).length, 0);
  } finally { f.close(); }
});
}

it('autonomous language review may retain a better draft and persists its comparison separately', async () => {
  class RetainDraft extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'language_review') {
        this.requests.push(structuredClone(request));
        const body = state.artifacts!.find(a => a.id === state.revisionComparison!.originalVersionId)!.content as string;
        const comparison = revisionComparisonFixture(state, body, true);
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage, content: body, comparison })!;
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new RetainDraft());
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    const [draft, revised, final] = f.storage.listArtifactVersions('p', 'body', 'main');
    assert.equal(final!.content, draft!.content);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, final!.id);
    const comparisons = f.storage.listArtifactVersions('p', 'report', `revision-comparison:${result.runId}`);
    assert.equal(comparisons.length, 1);
    const report = JSON.parse(comparisons[0]!.content);
    assert.equal(report.selectedVersionId, draft!.id);
    assert.equal(report.revisedVersionId, revised!.id);
    assert.equal(report.finalVersionId, final!.id);
    assert.equal(report.losses.length, 1);
    assert.ok(draft!.content.includes(report.losses[0].before));
    assert.ok(revised!.content.includes(report.losses[0].after));
    assert.doesNotMatch(final!.content, /selectedVersionId|保留初稿中已经清楚的表达/u);
    assert.equal(f.storage.getFactCheckStatus('p').snapshot?.bodyVersionId, final!.id);
  } finally { f.close(); }
});

const closureOriginal = '这项实验说明，使用 AI 的员工普遍更难被主管信任。';
const closureNote = '这是内部核查说明，交付前还需确认。';
const closureIncomplete = '这项实验表明，使用 AI 的员工总体更难获得主管信任。';
const closureFixed = '这项实验中，参与者判断的是是否采信员工自报的工时。';
const closureNewError = '研究团队同时测量了员工的晋升速度。';

class ClosureScenarioProvider extends CompactResearchProvider {
  revisions = 0;
  audits = 0;
  returnedFindingId: string | undefined;
  prematureDispatch = false;
  deferReturn = false;
  deferStage: 'central_revision' | 'language_review' | undefined;
  beforeAudit?: () => void;
  constructor(readonly scenario: 'existing' | 'new' | 'accept') {
    const ledger = compactResearch();
    super({ ...ledger, claims: [{ ...ledger.claims[0]!, evidence_id: 'E001',
      claim_text: '实验让参与者判断是否采信自报工时。', source_quote: closureFixed,
      use_boundary: '只涉及自报工时，未测量总体信任或晋升速度。' }] });
  }
  protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const state = collaborationState(request);
    if (this.deferStage && state?.actor === 'director' && state.nextStage === this.deferStage && !state.revisionReturn) {
      this.deferStage = undefined;
      this.requests.push(structuredClone(request));
      yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'synthetic restart window', retryable: true, retryAfterMs: 3_600_000 } };
      return;
    }
    if (state?.revisionReturn && (this.prematureDispatch || this.deferReturn)) {
      this.requests.push(structuredClone(request));
      if (this.deferReturn) {
        this.deferReturn = false;
        yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'synthetic restart window', retryable: true, retryAfterMs: 3_600_000 } };
        return;
      }
      this.prematureDispatch = false;
      yield { type: 'tool_call_delta', index: 0, id: 'premature-fact', name: 'director_decide',
        argumentsDelta: JSON.stringify({ action: 'dispatch', stage: 'fact_check', reason: '模拟错误推进。', questions: [] }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    let args: Record<string, unknown> | undefined;
    if (state?.stage === 'draft') {
      args = { stage: state.stage, content: `# 安静\n\n${closureOriginal}\n\n${closureNote}` };
    } else if (state?.stage === 'review_editor') {
      const findings: ReviewFinding[] = [
        { quote: closureOriginal, kind: 'attribution', severity: 'required', issue: '概括了未经验证的总体信任。', repairTarget: '写准实验观察对象。', evidenceIds: [] },
        { quote: closureNote, kind: 'process_note', severity: 'required', issue: '工作备注进入正文。', repairTarget: '删除工作备注。', evidenceIds: [] },
      ];
      args = { stage: state.stage, content: '必须修改：改准实验的观察对象，删除工作备注。', findings };
    } else if (state?.stage === 'central_revision') {
      const initial = ++this.revisions === 1;
      const rewritten = initial && this.scenario === 'existing' ? closureIncomplete : closureFixed;
      const content = `# 安静\n\n${rewritten}${initial && this.scenario === 'new' ? `\n\n${closureNewError}` : ''}`;
      const resolutions = state.reviewClosure!.findings.map(finding => {
        if (finding.quote === closureNewError) this.returnedFindingId = finding.id;
        return finding.quote === closureOriginal
          ? { findingId: finding.id, action: 'rewrite', afterQuote: rewritten, reason: '重写研究描述。' }
          : { findingId: finding.id, action: 'remove', afterQuote: null, reason: '删除不应出现的句子。' };
      });
      args = { stage: state.stage, content, resolutions };
    } else if (state?.stage === 'language_review') {
      const initial = ++this.audits === 1;
      if (initial) this.beforeAudit?.();
      const returnRevision = initial && this.scenario !== 'accept';
      const revised = state.artifacts!.find(artifact => artifact.id === state.revisionComparison!.revisedVersionId)!.content as string;
      const content = returnRevision ? this.scenario === 'existing' ? '需要修订' : revised.replace('# 安静', '# 安靖')
        : `${revised}\n\n说清研究问的是什么，读者才知道该相信到哪一步。`;
      const checks = state.reviewClosure!.findings.map(finding => {
        const unresolved = initial && this.scenario === 'existing' && finding.quote === closureOriginal;
        return { findingId: finding.id, verdict: unresolved ? 'unresolved' : 'resolved',
          quote: finding.quote === closureOriginal ? unresolved ? closureIncomplete : closureFixed : null,
          reason: unresolved ? '仍把采信自报工时说成总体信任。' : '逐项核对本稿，发现已处理。' };
      });
      const newFindings: ReviewFinding[] = initial && this.scenario === 'new' ? [
        { quote: closureNewError, kind: 'attribution', severity: 'required', issue: '来源没有测晋升速度。', repairTarget: '删除凭空加入的测量指标。', evidenceIds: ['E001'] },
      ] : [];
      args = { stage: state.stage, content, audit: { checks, newFindings } };
      if (returnRevision) {
        this.requests.push(structuredClone(request));
        const { stage: _stage, ...output } = args;
        yield { type: 'text_delta', delta: JSON.stringify(output) };
        yield { type: 'completed', finishReason: 'stop' };
        return;
      }
    }
    if (args) {
      this.requests.push(structuredClone(request));
      yield* publicStageFixtureEvents(request, 'submit_writing_stage', args)!;
      return;
    }
    yield* super.providerStream(request);
  }
}

for (const scenario of ['existing', 'new'] as const) {
it(`returns ${scenario} editorial blockers to central revision before saving or fact-checking`, async () => {
  const provider = new ClosureScenarioProvider(scenario);
  provider.prematureDispatch = scenario === 'existing';
  const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.revisions, 2);
    assert.equal(provider.audits, 2);
    const events = f.storage.listRunEvents(result.runId);
    const report = f.storage.listArtifactVersions('p', 'report', `revision-return:${result.runId}`)[0]!;
    const marker = f.storage.listArtifactVersions('p', 'report', `workflow:${result.runId}:language_review`)[0]!;
    const bodies = f.storage.listArtifactVersions('p', 'body', 'main');
    assert.equal(bodies.length, 4, 'draft, first revision, reworked revision, and final only');
    assert.equal(JSON.parse(report.content).bodyVersionId, bodies[1]!.id);
    const returnArgs = events.find(event => event.type === 'tool.requested' && event.payload.actor === 'language_review')?.payload.arguments as Record<string, unknown>;
    assert.equal(returnArgs.content, scenario === 'existing' ? '需要修订' : bodies[1]!.content.replace('# 安静', '# 安靖'));
    assert.equal(returnArgs.comparison, undefined);
    assert.ok(bodies.every(body => !body.content.includes('需要修订') && !body.content.includes('# 安靖')), 'return text is never saved as manuscript content');
    assert.ok(marker.createdEventSeq > bodies[2]!.createdEventSeq, 'no final-review marker before the reworked manuscript');
    assert.equal(events.filter(event => event.type === 'run.waiting_user').length, 0);
    assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 1);
    const rework = events.find(event => event.type === 'tool.requested' && event.payload.toolName === 'director_rework')!;
    assert.ok(rework.projectSeq > report.createdEventSeq && rework.projectSeq < bodies[2]!.createdEventSeq);
    assert.equal(rework.payload.stage, 'central_revision');
    if (scenario === 'existing') assert.ok(events.some(event => event.type === 'tool.failed' && JSON.stringify(event.payload).includes('REVISION_REPAIR_REQUIRED')));
    if (scenario === 'new') assert.equal(provider.returnedFindingId, `${report.id}:1`);
    const comparison = f.storage.listArtifactVersions('p', 'report', `revision-comparison:${result.runId}`);
    const auditRequest = provider.requests.find(request => collaborationState(request)?.actor === 'language_review')!;
    const auditFindings = collaborationState(auditRequest)!.reviewClosure!.findings;
    assert.ok(auditFindings.length > 0);
    assert.ok(auditFindings.every(finding => !Object.hasOwn(finding, 'issue') && !Object.hasOwn(finding, 'repairTarget')), 'independent final audit receives locations, not prior reviewers repair answers');
    assert.equal(comparison.length, 1);
    assert.equal(JSON.parse(comparison[0]!.content).audit.requiresRevision, false);
    assert.equal(f.storage.getFactCheckStatus('p').snapshot?.bodyVersionId, bodies[3]!.id);
    assert.doesNotMatch(bodies[3]!.content, /总体更难|晋升速度|内部核查说明/u);
    const projected = f.app.getProjectProjection('p').revisionComparisons!;
    assert.equal(projected.length, 1, 'the unresolved return has no comparison');
    assert.equal(projected[0]!.finalVersionId, bodies[3]!.id);
    assert.equal(Object.hasOwn(projected[0]!, 'audit'), false);

  } finally { f.close(); }
});
}

it('preserves an author edit made during the terminal audit', async () => {
  const provider = new ClosureScenarioProvider('existing');
  const f = setup(provider);
  try {
    let authorBodyId: string | null = null;
    provider.beforeAudit = () => {
      const project = f.storage.inspectProject('p')!;
      assert.ok(project.latestBodyVersionId);
      const saved = f.app.saveBody({ projectId: 'p', operationId: 'edit-during-audit', expectedProjectRevision: project.revision,
        baseBodyVersionId: project.latestBodyVersionId, content: '# 作者稿\n\n作者在终审期间自行编辑。', reason: 'manual', actor: { kind: 'user', id: 'u' } });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      authorBodyId = f.storage.inspectProject('p')!.latestBodyVersionId;
    };
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, false);
    assert.ok(authorBodyId);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, authorBodyId);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 3);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `revision-return:${result.runId}`).length, 0);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${result.runId}:language_review`).length, 0);
  } finally { f.close(); }
});

it('resumes a persisted terminal return after a write exception without skipping the repair', async t => {
  const provider = new ClosureScenarioProvider('existing');
  provider.deferReturn = true;
  const f = setup(provider);
  try {
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    let injected = false;
    f.storage.commitArtifactVersion = command => {
      const result = commit(command);
      if (result.ok && !injected && command.reason === 'revision-required') {
        injected = true;
        throw new Error('interrupted after saving terminal return');
      }
      return result;
    };
    const first = await f.app.runDraft(f.input);
    assert.ok(injected);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'PROVIDER_RETRY_DEFERRED');
    assert.equal(provider.audits, 1);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 2);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:language_review`).length, 0);
    const returns = () => f.storage.listArtifactVersions('p', 'report', `revision-return:${first.runId}`);
    assert.equal(returns().length, 1);
    const wait = f.storage.listRunEvents(first.runId).findLast(event => event.type === 'run.waiting_user')!;
    t.mock.method(Date, 'now', () => Number(wait.payload.retryNotBefore) + 1);
    const reopened = new WritingApplicationService({ storage: f.storage, provider: withIntentFixture(provider) });
    const result = await reopened.resumeDraft({ ...f.input, runId: first.runId, operationId: 'resume-after-terminal-return', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(returns().length, 1);
    assert.equal(provider.audits, 2, 'terminal audit resumes only after repairing the persisted return');
    assert.equal(provider.revisions, 2);
    assert.equal(f.storage.getRun(first.runId)?.usage.majorRevisions, 1);
  } finally { f.close(); }
});

it('carries an unresolved terminal return and reworks before repeating its audit in a new run', async () => {
  const provider = new ClosureScenarioProvider('existing');
  provider.deferReturn = true;
  const f = setup(provider);
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'PROVIDER_RETRY_DEFERRED');
    const report = f.storage.listArtifactVersions('p', 'report', `revision-return:${first.runId}`)[0]!;
    f.app.cancelDraft({ projectId: 'p', runId: first.runId, operationId: 'cancel-with-return', reason: 'user_stop' });
    const before = provider.requests.length;
    const second = await f.app.runDraft({ ...f.input, sessionId: f.storage.getRun(first.runId)!.sessionId,
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, userInstruction: '继续' });
    assert.equal(second.ok, true, JSON.stringify(second));
    const states = provider.requests.slice(before).map(collaborationState);
    assert.equal(states.find(state => state?.actor === 'director')?.revisionReturn?.reportId, report.id);
    assert.equal(states.find(state => state?.actor !== 'director' && state?.stage)?.stage, 'central_revision');
    assert.equal(provider.revisions, 2);
    assert.equal(provider.audits, 2);
    assert.equal(f.storage.getRun(second.runId)?.usage.majorRevisions, 1);
  } finally { f.close(); }
});

for (const carryAgain of [false, true]) it(`continues after durable rework invalidation without reviving the terminal assignment (new run=${carryAgain})`, async () => {
  const provider = new ClosureScenarioProvider('new');
  const f = setup(provider);
  try {
    let runInput: Parameters<WritingApplicationService['runDraft']>[0] = f.input;
    if (carryAgain) {
      provider.deferStage = 'language_review';
      const ancestor = await f.app.runDraft(runInput);
      assert.equal(f.storage.getRun(ancestor.runId)?.stopReason, 'PROVIDER_RETRY_DEFERRED');
      assert.equal(provider.audits, 0);
      f.app.cancelDraft({ projectId: 'p', runId: ancestor.runId, operationId: 'cancel-before-audit', reason: 'user_stop' });
      runInput = { ...runInput, sessionId: f.storage.getRun(ancestor.runId)!.sessionId,
        expectedProjectRevision: f.storage.inspectProject('p')!.revision, userInstruction: '继续' };
    }
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    let invalidationSeq: number | undefined;
    f.storage.commitArtifactVersion = command => {
      const result = commit(command);
      if (result.ok && invalidationSeq === undefined && command.reason === 'workflow-rework:central_revision') {
        invalidationSeq = f.storage.getArtifactVersion(result.result.versionId)!.createdEventSeq;
        if (carryAgain) provider.deferStage = 'central_revision';
        throw new Error('interrupted after consuming the terminal return');
      }
      return result;
    };
    const interrupted = await f.app.runDraft(runInput);
    assert.ok(invalidationSeq);
    const report = f.storage.listArtifactVersions('p', 'report', `revision-return:${interrupted.runId}`)[0]!;
    const beforeCarry = provider.requests.length;
    let result = interrupted;
    if (carryAgain) {
      assert.equal(f.storage.getRun(interrupted.runId)?.stopReason, 'PROVIDER_RETRY_DEFERRED');
      assert.equal(provider.audits, 1);
      f.app.cancelDraft({ projectId: 'p', runId: interrupted.runId, operationId: 'cancel-after-consuming-return', reason: 'user_stop' });
      result = await f.app.runDraft({ ...runInput, expectedProjectRevision: f.storage.inspectProject('p')!.revision });
      assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 0, 'do not charge again for the carried repair');
      const repair = provider.requests.slice(beforeCarry).map(collaborationState).find(state => state?.stage === 'central_revision');
      assert.ok(repair?.artifacts?.some(artifact => artifact.id === JSON.parse(report.content).bodyVersionId &&
        typeof artifact.content === 'string' && artifact.content.includes(closureNewError)), 'repair the returned body, not the earlier draft');
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.returnedFindingId, `${report.id}:1`);
    assert.equal(provider.audits, 2);
    assert.equal(provider.revisions, 2);
    assert.equal(f.storage.getRun(interrupted.runId)?.usage.majorRevisions, 1);
    const subsequent = f.storage.listRunEvents(result.runId).filter(event => event.projectSeq > invalidationSeq!);
    assert.ok(subsequent.some(event => event.type === 'tool.requested' && event.payload.actor === 'central_revision'));
    assert.equal(subsequent.filter(event => event.type === 'run.waiting_user').length, 0);
  } finally { f.close(); }
});

for (const [stage, tamper] of [['central_revision', false], ['central_revision', true], ['language_review', true]] as const) {
it(`validates persisted ${stage} closure before repairing an interrupted marker (tampered=${tamper})`, async () => {
  const provider = new ClosureScenarioProvider('accept');
  const f = setup(provider);
  try {
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    const readEvents = f.storage.listRunEvents.bind(f.storage);
    let committedBodyId: string | null = null;
    let interruptedOperationId = '';
    f.storage.commitArtifactVersion = command => {
      const result = commit(command);
      if (result.ok && committedBodyId === null && command.reason === `workflow:${stage}`) {
        committedBodyId = result.result.versionId;
        interruptedOperationId = command.operationId.replace(/:artifact$/u, '');
        throw new Error('interrupted before writing the stage marker');
      }
      return result;
    };
    if (tamper) f.storage.listRunEvents = runId => readEvents(runId).map(event => {
      if (event.type !== 'tool.requested' || event.operationId !== interruptedOperationId) return event;
      const args = event.payload.arguments as Record<string, unknown>;
      const invalid = stage === 'central_revision' ? { resolutions: [] } : { audit: { checks: [], newFindings: [] } };
      return { ...event, payload: { ...event.payload, arguments: { ...args, ...invalid } } };
    });
    const result = await f.app.runDraft(f.input);
    assert.ok(committedBodyId);
    const markers = f.storage.listArtifactVersions('p', 'report', `workflow:${result.runId}:${stage}`);
    if (tamper) {
      assert.equal(result.ok, false);
      assert.equal(markers.length, 0, 'invalid persisted metadata must not authorize a recovered stage marker');
      assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, committedBodyId);
      assert.ok(!provider.requests.some(request => collaborationState(request)?.stage === 'fact_check'));
    } else {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(provider.revisions, 1, 'reconciliation does not regenerate the already saved revision');
      assert.equal(markers.length, 1);
      assert.equal(JSON.parse(markers[0]!.content).artifactVersionId, committedBodyId);
      assert.equal(JSON.parse(markers[0]!.content).resolutions.length, 2);
    }
  } finally { f.close(); }
});
}

for (const afterCommit of [false, true]) {
it(`recovers an unchanged central revision interrupted ${afterCommit ? 'after' : 'before'} marker commit`, async () => {
  class KeepCentralBody extends CollaborationProvider {
    revisions = 0;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.stage === 'central_revision') {
        this.revisions++;
        this.requests.push(structuredClone(request));
        const content = state.artifacts!.find(artifact => artifact.kind === 'body')!.content;
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage, content, resolutions: [] })!;
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new KeepCentralBody();
  const f = setup(provider);
  try {
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    let injected = false;
    let sawBodyNoChange = false;
    let markerAttemptedBeforeBody = false;
    f.storage.commitArtifactVersion = command => {
      if (!injected && command.reason === 'workflow-stage-complete:central_revision') {
        markerAttemptedBeforeBody = !sawBodyNoChange;
        injected = true;
        if (afterCommit) assert.equal(commit(command).ok, true);
        throw new Error('interrupted while saving unchanged central revision');
      }
      const result = commit(command);
      if (command.reason === 'workflow:central_revision' && result.ok && result.result.status === 'no_change') sawBodyNoChange = true;
      return result;
    };
    const result = await f.app.runDraft(f.input);
    assert.ok(injected);
    assert.equal(markerAttemptedBeforeBody, false, 'an active tool.requested receipt alone cannot authorize marking the stage before its body commit runs');
    assert.ok(sawBodyNoChange);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.revisions, afterCommit ? 1 : 2,
      afterCommit ? 'a durable marker is reconciled without regeneration' : 'no durable stage result permits a retry, not speculative recovery');
    const bodies = f.storage.listArtifactVersions('p', 'body', 'main');
    assert.equal(bodies.length, 2, 'unchanged revision must not create a duplicate body version');
    const markers = f.storage.listArtifactVersions('p', 'report', `workflow:${result.runId}:central_revision`);
    assert.equal(markers.length, 1);
    const marker = JSON.parse(markers[0]!.content);
    assert.equal(marker.artifactVersionId, bodies[0]!.id);
    assert.deepEqual(marker.resolutions, []);
    assert.equal(marker.reviewVersionIds.length, 1);
    assert.equal(f.storage.getFactCheckStatus('p').snapshot?.bodyVersionId, bodies[1]!.id);
  } finally { f.close(); }
});
}

for (const cut of ['workflow:language_review', 'revision-comparison', 'workflow-stage-complete:language_review']) {
it(`recovers language review without another model response after committing ${cut}`, async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider);
  try {
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    let committedFinalId: string | null = null;
    f.storage.commitArtifactVersion = command => {
      const result = commit(command);
      if (result.ok && committedFinalId === null && command.reason === cut) {
        committedFinalId = f.storage.inspectProject('p')!.latestBodyVersionId;
        throw new Error('synthetic failure after a successful durable write');
      }
      return result;
    };
    const first = await f.app.runDraft(f.input);
    assert.ok(committedFinalId, 'the test must fail after a durable language-stage write');
    const result = first.ok ? first : await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: 'resume-after-language-save', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.requests.filter(request => collaborationState(request)?.stage === 'language_review').length, 1);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, committedFinalId);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 3);
    const reports = f.storage.listArtifactVersions('p', 'report', `revision-comparison:${first.runId}`);
    const markers = f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:language_review`);
    assert.equal(reports.length, 1);
    assert.equal(markers.length, 1);
    assert.equal(JSON.parse(reports[0]!.content).finalVersionId, committedFinalId);
    assert.equal(JSON.parse(markers[0]!.content).artifactVersionId, committedFinalId);
    assert.equal(f.storage.getFactCheckStatus('p').snapshot?.bodyVersionId, committedFinalId);
    const bridge = createApplicationBridge({ service: f.app, workspaceId: 'recovered-comparison', model: {
      model: 'mock', parameters: {}, providerLabel: 'test', credentialReference: null, budget: f.input.budget } });
    try {
      const projection = f.app.getProjectProjection('p').revisionComparisons!;
      assert.equal(projection.length, 1);
      assert.equal(projection[0]!.finalVersionId, committedFinalId);
      if (cut === 'revision-comparison') {
        const getVersion = f.storage.getArtifactVersion.bind(f.storage);
        for (const id of [reports[0]!.id, markers[0]!.id]) {
          f.storage.getArtifactVersion = versionId => {
            const version = getVersion(versionId);
            return version?.id === id && version.actor.kind === 'agent'
              ? { ...version, actor: { ...version.actor, id: 'writing-pack/review_publish' } } : version;
          };
          assert.deepEqual(f.app.getProjectProjection('p').revisionComparisons, []);
        }
        f.storage.getArtifactVersion = getVersion;
      }
      const savedBody = f.storage.getArtifactVersion(committedFinalId!)!;
      await bridge.selectSession('p', first.sessionId);
      const check = () => {
        const timeline = bridge.getSnapshot().timelineBySession[first.sessionId]!;
        const matches = timeline.filter(item => item.kind === 'message' && item.body.startsWith('**修订对照**'));
        assert.equal(matches.length, 1);
        const comparison = matches[0]!;
        assert.equal(comparison.kind, 'message');
        if (comparison.kind !== 'message') return;
        assert.match(comparison.body, /采用集中修订稿。/u);
        assert.ok(comparison.body.includes(projection[0]!.reason));
        for (const gain of projection[0]!.gains) {
          assert.ok([gain.before, gain.after].every(quote => quote.split(/\r?\n/u).every(line => comparison.body.includes(line))));
          assert.ok(comparison.body.includes(gain.why));
        }
        assert.doesNotMatch(comparison.body, /selectedVersionId|"audit"|"retainedQuotes"/u);
        const previous = timeline[timeline.indexOf(comparison) - 1];
        assert.ok(previous?.kind === 'message' && previous.stage === 'language_review' && previous.body.includes(savedBody.content));
      };
      check();
      const project = f.storage.inspectProject('p')!;
      assert.ok(f.app.saveBody({ projectId: 'p', operationId: 'new-author-body-after-recovery',
        expectedProjectRevision: project.revision, baseBodyVersionId: committedFinalId!, content: '# 作者另存的稿件',
        reason: 'manual', actor: { kind: 'user', id: 'u' } }).ok);
      await bridge.refresh();
      check();
      assert.equal(f.app.getProjectProjection('p').revisionComparisons?.[0]?.finalVersionId, committedFinalId);
      assert.notEqual(f.app.getProjectProjection('p').currentBody?.id, committedFinalId);
    } finally { bridge.dispose(); }
  } finally { f.close(); }
});
}

it('does not recover a partial language review over an intervening author edit', async () => {
  const f = setup(new CollaborationProvider());
  try {
    const commit = f.storage.commitArtifactVersion.bind(f.storage);
    let authorVersionId: string | null = null;
    let comparisonBodyId: string | null = null;
    f.storage.commitArtifactVersion = command => {
      const result = commit(command);
      if (result.ok && authorVersionId === null && command.reason === 'revision-comparison') {
        const project = f.storage.inspectProject('p')!;
        comparisonBodyId = project.latestBodyVersionId;
        assert.ok(comparisonBodyId);
        const saved = f.app.saveBody({ projectId: 'p', operationId: 'author-edit-after-comparison',
          expectedProjectRevision: project.revision, baseBodyVersionId: comparisonBodyId,
          content: '# 安静\n\n作者手工更新的正文。', reason: 'manual', actor: { kind: 'user', id: 'u' } });
        assert.equal(saved.ok, true, JSON.stringify(saved));
        authorVersionId = f.storage.inspectProject('p')!.latestBodyVersionId;
        throw new Error('synthetic failure after comparison and concurrent author save');
      }
      return result;
    };
    const first = await f.app.runDraft(f.input);
    assert.equal(first.ok, false);
    assert.ok(authorVersionId && comparisonBodyId && authorVersionId !== comparisonBodyId);
    const resumed = await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: 'resume-with-author-edit', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(resumed.ok, false);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, authorVersionId);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 4);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:language_review`).length, 0);
    const reports = f.storage.listArtifactVersions('p', 'report', `revision-comparison:${first.runId}`);
    assert.equal(reports.length, 1);
    assert.equal(JSON.parse(reports[0]!.content).finalVersionId, comparisonBodyId);
    assert.deepEqual(f.app.getProjectProjection('p').revisionComparisons, [], 'a comparison without a completed stage is never shown');
  } finally { f.close(); }
});

it('co-creation language review rejects a return to the draft after the author confirms the revision', async () => {
  class AttemptRollback extends CollaborationProvider {
    attempted = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (!this.attempted && state?.actor === 'language_review') {
        this.attempted = true;
        const comparison = state.revisionComparison!;
        assert.deepEqual(comparison.allowedSelectionIds, [comparison.revisedVersionId]);
        const content = state.artifacts!.find(a => a.id === comparison.originalVersionId)!.content as string;
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage, content, comparison: revisionComparisonFixture(state, content, true) })!;
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new AttemptRollback();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let checkpoint = 0; checkpoint < 5; checkpoint++) await f.app.resumeDraft(withCheckpointIntent(f.storage, {
      ...f.input, runId: first.runId, operationId: `confirm-revision-${checkpoint}`, decision: 'resume', userInstruction: '继续',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision,
    })).result;
    assert.ok(provider.attempted);
    const events = f.storage.listRunEvents(first.runId);
    assert.ok(events.some(event => event.type === 'tool.failed' && JSON.stringify(event.payload).includes('REVISION_SELECTION_NOT_ALLOWED')));
    assert.equal(events.findLast(event => event.type === 'run.waiting_user')?.payload.stage, 'language_review');
    const [draft, revised, final] = f.storage.listArtifactVersions('p', 'body', 'main');
    const reports = f.storage.listArtifactVersions('p', 'report', `revision-comparison:${first.runId}`);
    assert.equal(reports.length, 1);
    assert.equal(JSON.parse(reports[0]!.content).selectedVersionId, revised!.id);
    assert.notEqual(final!.content, draft!.content);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 3);
  } finally { f.close(); }
});

for (const resumeStage of ['review_publish', 'language_review'] as const) {
it(`resumes legacy ${resumeStage} with no editorial plan or manufactured comparison`, async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'autonomous', 0, resumeStage === 'review_publish' ? 'deep' : 'quick');
  const runId = 'legacy-no-editorial-plan';
  try {
    f.storage.createSession({ sessionId: 'legacy-editorial-session', projectId: 'p', purpose: 'writing-pack:draft' });
    f.storage.startRun({ runId, sessionId: 'legacy-editorial-session', projectId: 'p', planVersion: 'writing-pack-v1', budget: f.input.budget, expectedBodyVersionId: null });
    const actor = { kind: 'agent', id: 'old-writing-pack', runId } as const;
    const commit = (kind: 'evidence' | 'outline' | 'body' | 'review' | 'report', logicalKey: string, content: string, operationId: string) => {
      const baseVersionId = f.storage.listArtifactVersions('p', kind, logicalKey).at(-1)?.id ?? null;
      const saved = f.storage.commitArtifactVersion({ projectId: 'p', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
        operationId, kind, logicalKey, content, baseVersionId, requestSnapshotId: null, reason: 'legacy workflow', actor });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      return saved.result.versionId;
    };
    let draftId = '';
    let legacyEvidenceId = '';
    const completed = ['research', 'outline', 'draft', 'review_editor', 'review_reader', 'central_revision'] as const;
    for (const stage of resumeStage === 'review_publish' ? completed.slice(0, 4) : completed) {
      const review = stage === 'review_editor' || stage === 'review_reader';
      const kind = stage === 'research' ? 'evidence' : stage === 'outline' ? 'outline' : review ? 'review' : 'body';
      const content = stage === 'research' ? '{"claims":[],"notes":"旧流程，仅表达个人感受"}'
        : stage === 'outline' ? '# 旧提纲\n\n观察。'
          : review ? JSON.stringify({ schemaVersion: 'writing-review-v1', reviewType: stage, runId, bodyVersionId: draftId, content: '旧审校意见' })
            : `# 安静\n\n旧版${stage}正文。`;
      const artifactVersionId = commit(kind, review ? `${stage}:${runId}` : 'main', content, `old-artifact:${stage}`);
      if (stage === 'draft') draftId = artifactVersionId;
      if (stage === 'research') legacyEvidenceId = artifactVersionId;
      commit('report', `workflow:${runId}:${stage}`, JSON.stringify({ schemaVersion: 'writing-workflow-stage-v1', runId, stage, artifactVersionId }), `old-marker:${stage}`);
    }
    f.storage.recoverProjectRuns('p');
    const result = await f.app.resumeDraft({ ...f.input, runId, operationId: 'resume-old-language', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (resumeStage === 'review_publish') {
      const publish = provider.requests.find(request => collaborationState(request)?.actor === resumeStage)!;
      const input = collaborationState(publish)!;
      assert.deepEqual(input.artifacts?.find(artifact => artifact.kind === 'evidence')?.content, { claims: [] });
      assert.deepEqual(input.inputVersionIds, [draftId, legacyEvidenceId]);
      assert.doesNotMatch(publish.messages[1]!.content, /旧审校意见|旧流程，仅表达个人感受/u);
    }
    const language = provider.requests.find(request => collaborationState(request)?.actor === 'language_review')!;
    assert.equal(collaborationState(language)?.revisionComparison, undefined);
    assert.ok(!language.tools?.some(tool => tool.name === 'submit_writing_stage'), 'legacy request keeps prose delivery');
    const completedStages = resumeStage === 'review_publish' ? completed.slice(0, 4) : completed;
    assert.ok(!provider.requests.some(request => completedStages.some(stage => stage === collaborationState(request)?.actor)));
    assert.equal(f.storage.inspectProject('p')!.currentEvidenceVersionId, legacyEvidenceId);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `revision-comparison:${runId}`).length, 0);
  } finally { f.close(); }
});
}

it('restores referenced discussion through a real scoped tool without exposing reviews to independent reviewers', async () => {
  class DiscussionProvider extends CollaborationProvider {
    read = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const s: any = collaborationState(request);
      if (s?.actor?.startsWith('review_')) assert.ok(!request.tools?.some(t => t.name === 'read_review_discussion'));
      if (s?.actor === 'central_revision' && !this.read) {
        const entry = s.authorReviewDiscussion.find((item: any) => item.contentAvailableVia === 'read_review_discussion');
        assert.ok(entry, 'older assistant report must be indexed, not repeated');
        this.read = true;
        yield { type: 'tool_call_delta', index: 0, id: 'read-prior-discussion', name: 'read_review_discussion', argumentsDelta: JSON.stringify({ sequence: entry.sequence }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      if (s?.actor === 'central_revision' && this.read) {
        const result = request.messages.find(m => m.role === 'tool' && m.name === 'read_review_discussion');
        assert.ok(result);
        const envelope = JSON.parse(result.content);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.result.item.content, '我们先讨论当前这一条，不交接下一位。');
        assert.equal(envelope.result.instructionAuthority, 'none');
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new DiscussionProvider(); const f = setup(provider);
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.app.startAuthorTurn({ projectId: 'p', sessionId: 'discussion', model: 'mock', parameters: {},
        userInstruction: `这次只讨论第${i + 1}段，不修改正文。` }).result).ok, true);
    }
    const result = await f.app.runDraft({ ...f.input, sessionId: 'discussion', expectedProjectRevision: f.storage.inspectProject('p')!.revision });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(provider.read, true);
  } finally { f.close(); }
});

it('omits only an exact generated brief echo and keeps additional author instructions', async () => {
  for (const suffix of ['', '\n但请保留第二段，不改我的结论。']) {
    const provider = new CollaborationProvider(); const f = setup(provider, 'co_creation');
    try {
      const summary = getConversationIntakeState(f.storage, 'p').summary;
      await f.app.runDraft({ ...f.input, userInstruction: `按刚才确认的方向继续：${summary}${suffix}` });
      const request = provider.requests.find(r => collaborationState(r)?.actor === 'research')!;
      const text = request.messages.find(m => m.role === 'user')!.content;
      if (suffix) assert.ok(text.includes(summary + suffix), 'never trim substantive user edits by a prefix match');
      else assert.ok(!text.includes(summary), 'brief is already supplied in the canonical prompt');
      assert.match(text, /主题：安静/);
      assert.match(text, /约 800 字符/);
    } finally { f.close(); }
  }
});

it('checks original author words without inheriting research scaffolding or intake-generated constraints', async () => {
  const ledger = compactResearch();
  ledger.claims = ledger.claims.slice(0, 1);
  const plan = editorialPlanFixture(['E001']);
  plan.angles[0]!.angle = 'RESEARCH_SCAFFOLD_SENTINEL';
  const provider = new CompactResearchProvider({ ...ledger, editorialPlan: plan });
  const f = setup(provider, 'co_creation', 1, 'quick', '作者原话：比较两个人物的区别。');
  try {
    const before = f.storage.inspectProject('p')!;
    const brief = f.storage.getWritingBriefVersion(before.currentBriefVersionId!)!.brief;
    assert.ok(f.app.saveWritingBrief({ projectId: 'p', operationId: 'generated-brief', expectedProjectRevision: before.revision,
      baseVersionId: before.currentBriefVersionId, actor: { kind: 'user', id: 'conversation-user' },
      brief: { ...brief, constraints: ['INTAKE_SCAFFOLD_SENTINEL'] } }).ok);
    const project = f.storage.inspectProject('p')!;
    await f.app.runDraft({ ...f.input, expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId! });
    const request = provider.requests.find(r => collaborationState(r)?.actor === 'outline')!;
    assert.match(request.messages[1]!.content, /作者原话：比较两个人物的区别/u);
    assert.doesNotMatch(request.messages[1]!.content, /RESEARCH_SCAFFOLD_SENTINEL|INTAKE_SCAFFOLD_SENTINEL|taskInstruction/u);
    assert.ok((collaborationState(request) as any).artifacts[0].content);
    assert.ok(request.tools?.find(t => t.name === 'submit_writing_stage')?.inputSchema);
  } finally { f.close(); }
});

it('scales outline and research guidance to the article without imposing a truncating save limit', async () => {
  const provider=new CollaborationProvider(); const f=setup(provider,'co_creation');
  try {
    await f.app.runDraft(f.input);
    const outline=provider.requests.find(r=>collaborationState(r)?.actor==='outline')!;
    const research=provider.requests.find(r=>collaborationState(r)?.actor==='research')!;
    assert.match(outline.messages[0]!.content,/提纲.*篇幅|篇幅.*提纲/u);
    assert.match(research.messages[0]!.content,/只入账与候选相关的材料.*能解释原因、呈现差异或限制结论/u);
    const state=JSON.parse(outline.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    assert.equal(state.outputGuidance.articleTargetCharacters,800);
    assert.ok(state.outputGuidance.outlineTargetCharacters<=800);
    assert.match(outline.messages[0]!.content,/不.*证据编号/);
    assert.match(outline.messages[0]!.content,/不截断|不是.*硬.*上限/);
  } finally {f.close();}
});

it('delivers anti-filler guidance through real stage requests while retaining explicit author constraints', async () => {
  const provider = new CollaborationProvider(), f = setup(provider, 'autonomous', 1, 'deep',
    '别为你干的蠢事赋予意义。人喜欢找理由求自洽，反复想却迈不出一步。我看见了，我还在里面。');
  try {
    const briefId = f.storage.inspectProject('p')!.currentBriefVersionId!;
    const brief = f.storage.getWritingBriefVersion(briefId)!.brief;
    const constraints = ['作者明确要求：不写操作步骤，不虚构亲历，也不强行给积极结尾。'];
    assert.equal(f.app.saveWritingBrief({ operationId: 'short-essay-direction', projectId: 'p',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, baseVersionId: briefId,
      actor: { kind: 'user', id: 'u' }, brief: { ...brief, lengthTarget: { targetCharacters: 2500 }, constraints } }).ok, true);
    const project = f.storage.inspectProject('p')!;
    const result = await f.app.runDraft({ ...f.input, expectedProjectRevision: project.revision,
      expectedBriefVersionId: project.currentBriefVersionId! });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const actor of ['director', 'draft', 'central_revision']) {
      const request = provider.requests.find(r => collaborationState(r)?.actor === actor)!;
      assert.match(request.messages[0]!.content, /不得为了.*字数.*扩写/u, actor);
      assert.match(request.messages.find(m => m.role === 'user')!.content, /不写操作步骤.*不虚构亲历/u, actor);
    }
    assert.match(provider.requests.find(r => collaborationState(r)?.actor === 'review_editor')!.messages[0]!.content,
      /不因没有故事、反方、金句或短段而扣分/u);
    assert.match(provider.requests.find(r => collaborationState(r)?.actor === 'review_publish')!.messages[0]!.content,
      /逐条核对研究究竟测了谁.*免责声明不能代替改准断言/su);
    const outline = provider.requests.find(r => collaborationState(r)?.actor === 'outline')!;
    assert.match(outline.messages[0]!.content, /每一部分新增的信息/u);
    // This is a delivery/contract check, not a claim that a scripted provider writes better prose.
    const bodies = f.storage.listArtifactVersions('p', 'body', 'main');
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every(body => typeof body.content === 'string' && body.content.length < 2500));
    assert.deepEqual(f.storage.getWritingBriefVersion(project.currentBriefVersionId!)!.brief.constraints, constraints);
  } finally { f.close(); }
});

it('requires a separate author decision after each independent review, including after restart', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation', 0, 'deep');
  try {
    const first = await f.app.runDraft(f.input);
    const stages = ['outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review'];
    for (let index = 0; index < stages.length; index++) {
      if (index > 0) {
        const restarted = new WritingApplicationService({ storage: f.storage, provider });
        await restarted.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: `stepwise-${index}`,
          decision: 'resume', userInstruction: 'ok', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
      }
      const wait = f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1);
      assert.equal(wait?.payload.stage, stages[index]);
      assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
      const next = stages[index + 1] ?? 'fact_check';
      assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:${next}`).length, 0,
        `must not execute ${next} before the current expert is accepted`);
      if (stages[index]!.startsWith('review_')) {
        assert.throws(() => f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: `not-confirmed-${index}`,
          decision: 'resume', userInstruction: '我不同意第二条，先解释一下', expectedProjectRevision: f.storage.inspectProject('p')!.revision }),
          /CHECKPOINT_DECISION_REQUIRED|checkpoint/i);
        assert.equal(f.storage.getRun(first.runId)?.status, 'waiting_user');
      }
    }
  } finally { f.close(); }
});

it('treats a short affirmative outline reply as confirmation, not a rework request', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const outlineWait = f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1);
    assert.equal(outlineWait?.payload.stage, 'outline');
    await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'confirm-outline-naturally',
      decision: 'resume', userInstruction: '方向可以', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 1,
      '短确认语（"方向可以"）不得触发提纲返工重写');
    const nextWait = f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1);
    assert.equal(nextWait?.payload.stage, 'draft', '确认提纲后应进入初稿确认点');
  } finally { f.close(); }
});

for (const phrase of ['认同', '认可；', '我觉得你说的这些都挺对的，往下做吧']) it(`reader approval through the real bridge resumes the same saved workflow: ${phrase}`, async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'semantic-reader', model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: null } });
  try {
    const first = await f.app.runDraft(f.input);
    for (let n = 0; n < 3; n++) await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId,
      operationId: `semantic-prep-${n}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
    assert.equal(f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user').at(-1)?.payload.stage, 'review_reader');
    const savedReview = f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:review_reader`).map(v => v.id);
    await bridge.selectSession('p', first.sessionId);
    const turn = await bridge.sendMessage(phrase);
    const deadline = Date.now() + 10000;
    while (!f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:central_revision`).length || f.storage.getRun(first.runId)?.status === 'running') {
      assert.ok(Date.now() < deadline, JSON.stringify(f.storage.listRunEvents(turn.runId).slice(-3)));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.storage.getRun(turn.runId)?.status, 'completed');
    assert.deepEqual(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:review_reader`).map(v => v.id), savedReview, 'accepted review must not be replayed');
    assert.equal(f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.resumed').at(-1)?.payload.displayInstruction, phrase);
    const report = JSON.parse(f.storage.listArtifactVersions('p', 'report', `author-turn:${turn.runId}`)[0]!.content);
    assert.equal(report.requestedAction, 'resume_checkpoint');
    assert.doesNotMatch(report.reply, /明确认可后|这样调整可以吗/);
  } finally { bridge.dispose(); f.close(); }
});

for (const phrase of ['不同意', '还没确认', '认可第一点，但第二点为什么要改？', '先别交给下一位，解释一下']) it(`semantic objections never advance or rewrite a pending stage: ${phrase}`, async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'semantic-objection', model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: null } });
  try {
    const first = await f.app.runDraft(f.input);
    const before = f.storage.listRunEvents(first.runId).length;
    await bridge.selectSession('p', first.sessionId);
    const turn = await bridge.sendMessage(phrase);
    const deadline = Date.now() + 5000;
    while (f.storage.getRun(turn.runId)?.status === 'running') {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.storage.getRun(turn.runId)?.status, 'completed');
    assert.equal(f.storage.listRunEvents(first.runId).length, before);
    assert.equal(f.storage.inspectProject('p')!.latestBodyVersionId, null);
  } finally { bridge.dispose(); f.close(); }
});

it('does not accept a receipt after its checkpoint or body changes', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const approved = withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'stale-intent', decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision });
    f.storage.resumeRun({ projectId: 'p', runId: first.runId, operationId: 'change-question', decision: 'resume' });
    f.storage.pauseRun({ projectId: 'p', runId: first.runId, operationId: 'new-question', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'outline', nextStage: 'draft' } });
    assert.throws(() => f.app.resumeDraft(approved), /checkpoint/i);
    assert.equal(f.storage.getRun(first.runId)?.status, 'waiting_user');
  } finally { f.close(); }
});

it('does not accept a checkpoint receipt after the bound body version changes', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const approved = withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'body-bound-intent', decision: 'resume', userInstruction: '继续' });
    const project = f.storage.inspectProject('p')!;
    const changed = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'external-body-change', expectedProjectRevision: project.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: project.latestBodyVersionId, content: '# 外部修改\n\n回执之后正文已变化。', reason: 'user edit', actor: { kind: 'user', id: 'u' } });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.throws(() => f.app.resumeDraft({ ...approved, operationId: 'resume-stale-body', expectedProjectRevision: f.storage.inspectProject('p')!.revision }), /checkpoint/i);
    assert.equal(f.storage.getRun(first.runId)?.status, 'waiting_user');
  } finally { f.close(); }
});

it('keeps a version-bound approval valid after an unrelated completed message in the same conversation', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const approved = withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'old-approval', decision: 'resume', userInstruction: '继续' });
    f.storage.startRun({ projectId: 'p', sessionId: first.sessionId, runId: 'later-note', planVersion: 'test', displayInstruction: '记下：稍后检查语气' });
    f.storage.finishRun({ projectId: 'p', runId: 'later-note', operationId: 'later-note-saved', status: 'completed', stopReason: null });
    const resumed = await f.app.resumeDraft({ ...approved, operationId: 'resume-after-note', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(resumed.ok ? null : resumed.error.code, 'USER_CONFIRMATION_REQUIRED');
  } finally { f.close(); }
});

it('cannot reuse one approval receipt to advance a second checkpoint', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    const approved = withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'single-use-approval', decision: 'resume', userInstruction: '继续' });
    const resumed = await f.app.resumeDraft({ ...approved, operationId: 'first-use', expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(resumed.ok ? null : resumed.error.code, 'USER_CONFIRMATION_REQUIRED');
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.throws(() => f.app.resumeDraft({ ...approved, operationId: 'second-use', expectedProjectRevision: f.storage.inspectProject('p')!.revision }), /checkpoint/i);
  } finally { f.close(); }
});

it('retires resume-time read instructions when later stages replace their input versions', async () => {
  class PauseBeforeRevision extends CollaborationProvider {
    paused = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (!this.paused && state?.actor === 'director' && state.nextStage === 'central_revision') {
        this.paused = true;
        yield { type: 'tool_call_delta', index: 0, id: 'pause-before-revision', name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'needs_input', reason: '请确认集中修订范围', questions: ['是否按这些意见修订？'] }) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new PauseBeforeRevision(), f = setup(provider);
  try {
    const first = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(first.runId)?.status, 'waiting_user');
    const oldBody = f.storage.inspectProject('p')!.latestBodyVersionId!;
    await f.app.resumeDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, runId: first.runId, operationId: 'resume-version-scope', decision: 'resume', userInstruction: '按审校意见继续修订' }).result;
    const late = provider.requests.filter(r => { const s = collaborationState(r); return s?.actor === 'director' && s.nextStage === 'fact_check'; });
    assert.ok(late.length);
    for (const request of late) {
      assert.equal(JSON.stringify(request.messages).includes(oldBody), false, 'the old body must not be advertised to an actor forbidden to read it');
      assert.equal(JSON.stringify(request.messages).includes('恢复必读上下文'), false, 'read obligations must follow current stage inputs, not the frozen resume snapshot');
    }
  } finally { f.close(); }
});

for (const checkpointIndex of [0, 1, 2, 3, 4, 5, 6]) it(`recovers a missing checkpoint before any next request (checkpoint ${checkpointIndex})`, async () => {
  const provider = new CollaborationProvider(), f = setup(provider, 'co_creation', 0, 'deep');
  try {
    const first = await f.app.runDraft(f.input);
    for (let n = 0; n < checkpointIndex; n++) await f.app.resumeDraft(withCheckpointIntent(f.storage, {
      ...f.input, runId: first.runId, operationId: `crash-prep-${n}`, decision: 'resume', userInstruction: '可以',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision,
    })).result;
    const readEvents = f.storage.listRunEvents.bind(f.storage);
    const missing = readEvents(first.runId).findLast(e => e.type === 'run.waiting_user')!;
    assert.equal(missing.payload.stopReason, 'CO_CREATION_CHECKPOINT');
    f.storage.listRunEvents = id => readEvents(id).filter(e => e.id !== missing.id);
    f.storage.resumeRun({ projectId: 'p', runId: first.runId, operationId: 'simulate-crash-window', decision: 'resume' });
    f.storage.recoverProjectRuns('p');
    const before = provider.requests.length;
    const result = await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: 'recover-crash', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT', JSON.stringify(result));
    assert.equal(readEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, missing.payload.stage);
    assert.equal(provider.requests.length, before, 'repair persisted waiting state without another model call');
  } finally { f.close(); }
});

it('recovers a legacy missing language checkpoint without rerunning saved experts or starting fact check', async () => {
  const provider = new CollaborationProvider(), f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let n = 0; n < 5; n++) await f.app.resumeDraft(withCheckpointIntent(f.storage, {
      ...f.input, runId: first.runId, operationId: `legacy-prep-${n}`, decision: 'resume', userInstruction: '可以',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision,
    })).result;
    const events = f.storage.listRunEvents.bind(f.storage);
    const missing = events(first.runId).findLast(e => e.type === 'run.waiting_user')!;
    assert.equal(missing.payload.stage, 'language_review');
    // Emulate rc54: the language result exists, but no corresponding wait event.
    f.storage.listRunEvents = id => events(id).filter(e => e.id !== missing.id);
    f.storage.resumeRun({ projectId: 'p', runId: first.runId, operationId: 'legacy-resume', decision: 'resume' });
    f.storage.pauseRun({ projectId: 'p', runId: first.runId, operationId: 'legacy-failure', reason: 'TOOL_FAILURE_LOOP', payload: { tool: 'read_artifact_version', validationCode: 'TOOL_PERMISSION_DENIED' } });
    const bodies = f.storage.listArtifactVersions('p', 'body', 'main').map(v => v.id);
    const result = await f.app.resumeDraft({ ...f.input, runId: first.runId, operationId: 'legacy-retry', decision: 'resume',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision }).result;
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT', JSON.stringify(result));
    assert.equal(f.storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'language_review');
    assert.deepEqual(f.storage.listArtifactVersions('p', 'body', 'main').map(v => v.id), bodies);
    assert.equal(getPublicationCandidates(f.storage, 'p'), null);
  } finally { f.close(); }
});

it('carries saved work but never treats cancellation as checkpoint approval', async () => {
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
    // Restore the outstanding decision without spending another model request.
    const continuationStates = provider.requests.slice(before).map(request => collaborationState(request)).filter(state => state !== null);
    assert.equal(continuationStates.length, 0);
    assert.equal(f.storage.getRun(second.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(continuationStates.filter(state => state.stage === 'outline').length, 0);
    assert.equal(continuationStates.some(state => state.stage === 'draft'), false);
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
    const sameSessionStart = sameSessionStates.findLast(state => state.actor === 'director' && state.completedStages.length === 0);
    assert.ok(sameSessionStart, 'a completed run never carries: the next run starts empty');
    assert.equal(sameSessionStart!.nextStage, 'research');

    const otherSession = await f.app.runDraft({ ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, userInstruction: '换一个话题' });
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${otherSession.runId}:research`).length >= 0, true);
    const otherRunMarkers = f.storage.listArtifactVersions('p', 'report', `workflow:${otherSession.runId}:outline`);
    assert.ok(otherRunMarkers.length > 0, 'the new session runs its own pipeline');
    assert.equal(otherRunMarkers.every(marker => marker.actor.kind === 'agent' && marker.actor.runId === otherSession.runId), true);
  } finally { f.close(); }
});

it('saves the approved outline verbatim in one request without streaming its internal assessment', async () => {
  const parts = ['# 安静的提纲\n\n', '一、窗边的观察。\n\n', '二、收回目光，留一点余味。'];
  let inspect = () => {};
  class TextOutline extends CollaborationProvider {
    outlineRequests = 0;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.stage !== 'outline') { yield* super.providerStream(request); return; }
      this.requests.push(request); this.outlineRequests++;
      const response = publicStageFixtureEvents(request, 'submit_writing_stage', { stage: 'outline', content: parts.join('') })![0]!;
      assert.equal(response.type, 'tool_call_delta');
      if (response.type !== 'tool_call_delta') return;
      const { stage: _stage, ...payload } = JSON.parse(response.argumentsDelta!);
      const output = JSON.stringify(payload);
      const midpoint = Math.floor(output.length / 2);
      for (const delta of [output.slice(0, midpoint), output.slice(midpoint)]) { yield { type: 'text_delta', delta }; inspect(); }
      yield { type: 'completed', finishReason: 'stop' };
    }
  }
  const provider = new TextOutline(); const f = setup(provider, 'co_creation');
  const samples: string[] = [];
  inspect = () => {
    const run = f.storage.listRuns('p')[0]!;
    const preview = f.app.getLiveReply('p', run.sessionId, run.id);
    assert.equal(preview, null);
    samples.push('hidden');
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 0);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(f.storage.getRun(result.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(provider.outlineRequests, 1);
    const request = provider.requests.find(r => collaborationState(r)?.stage === 'outline')!;
    assert.equal(request.parameters.toolChoice, 'auto');
    assert.deepEqual(request.tools?.map(t => t.name).sort(), ['read_artifact_version', 'submit_writing_stage']);
    assert.deepEqual(samples, ['hidden', 'hidden']);
    assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main')[0]?.content, parts.join(''));
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 0);
    const save = f.storage.listRunEvents(result.runId).find(e => e.type === 'tool.requested' && e.payload.actor === 'outline');
    assert.equal(save?.payload.origin, 'harness_text_output');
  } finally { f.close(); }
});

it('does not confuse a short first-person article with a generation status message', async () => {
  class PersonalText extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const stage = collaborationState(request)?.stage ?? '';
      if (['draft', 'central_revision', 'language_review'].includes(stage)) {
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage, content: '我会把散乱的日子整理好。' })!;
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const f = setup(new PersonalText());
  try { assert.equal((await f.app.runDraft(f.input)).ok, true); } finally { f.close(); }
});

for (const canSearch of [false, true]) it(`returns an unsupported premise before drafting and routes its exact gap (search=${canSearch})`, async () => {
  const assessment = { decision: 'research', promise: '证明家庭规模服务商业布局', readerPayoff: '理解人物的商业安排',
    premises: [{ claim: '家庭安排具有商业功能', basis: 'missing', evidenceIds: [], explanation: '人数不能证明商业意图。' }],
    sections: [], reason: '现有材料只能说明规模，不能说明商业功能。', queries: ['家庭安排 商业功能 原始材料'],
    questions: ['补查仍没有支持的话，是否改为比较家庭安排本身？'] };
  class GapProvider extends CollaborationProvider {
    returned = false;
    bypassed = false;
    unavailableRework = false;
    sawResearchGap = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request) as any;
      if (state?.stage === 'outline' && !this.returned) {
        this.returned = true;
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: 'outline', content: '需要先补查。', prewriting: { ...assessment, stage_note: '供应商附加的内部备注。' } })!;
        return;
      }
      if (state?.actor === 'director' && state.prewritingReturn) {
        const args = !this.bypassed ? { action: 'dispatch', stage: 'outline', reason: '认可继续，直接出提纲。', questions: [], readinessReason: '继续。' }
          : canSearch || !this.unavailableRework ? { action: 'rework', stage: 'research', reason: '补查家庭安排的商业功能。', questions: [] }
          : { action: 'ask', stage: null, reason: assessment.reason, questions: assessment.questions };
        if (this.bypassed && !canSearch) this.unavailableRework = true;
        this.bypassed = true;
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'director_decide', argumentsDelta: JSON.stringify(args) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      if (state?.stage === 'research' && this.returned) {
        assert.match(request.messages[1]!.content, /家庭安排具有商业功能/u);
        assert.match(request.messages[1]!.content, /人数不能证明商业意图/u);
        this.sawResearchGap = true;
        const unread = state.unreadArtifactVersionIds.find((id: string) => !request.messages.some(m => m.role === 'tool' && m.name === 'read_artifact_version' && JSON.parse(m.content).result?.versionId === id));
        if (unread) {
          yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'read_artifact_version', argumentsDelta: JSON.stringify({ versionId: unread }) };
          yield { type: 'completed', finishReason: 'tool_calls' }; return;
        }
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new GapProvider(); const f = setup(provider);
  const app = new WritingApplicationService({ storage: f.storage, provider: withIntentFixture(provider),
    factSearchConfiguration: () => ({ parallelEnabled: canSearch, tavilyEnabled: false }) });
  try {
    const result = await app.runDraft(f.input);
    const codes = f.storage.listRunEvents(result.runId).filter(e => e.type === 'tool.failed').map(e => (e.payload.result as any).error.code);
    assert.ok(f.storage.listArtifactVersions('p', 'report', 'prewriting-assessment').every(v => !v.content.includes('stage_note')));
    assert.ok(codes.includes('PREWRITING_REPAIR_REQUIRED'));
    if (canSearch) {
      assert.equal(provider.sawResearchGap, true);
      assert.equal(result.ok, true, JSON.stringify({ result, codes, recent: f.storage.listRunEvents(result.runId).filter(e => e.type === 'tool.completed').slice(-6).map(e => e.payload) }));
      assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 1);
      assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 1, 'only the reassessed outline is saved');
    } else {
      assert.ok(codes.includes('PREWRITING_DISCUSSION_REQUIRED'));
      assert.equal(f.storage.getRun(result.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
      assert.equal(f.storage.listArtifactVersions('p', 'outline', 'main').length, 0);
      assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').length, 0);
      assert.equal(f.storage.getRun(result.runId)?.usage.majorRevisions, 0);
    }
  } finally { f.close(); }
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

it('finishes a passed workflow without asking the model for an inapplicable stage enum', async () => {
  class FinishStageProvider extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request);
      if (state?.actor === 'director' && state.nextStage === null && !state.finished) {
        this.requests.push(structuredClone(request));
        if (request.tools?.some(tool => tool.name === 'director_decide')) {
          // The reported failure was /stage enum validation after the final fact
          // gate passed. Its raw rejected value was not retained; use a synthetic
          // non-stage completion label to reproduce that same contract failure.
          yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'director_decide',
            argumentsDelta: JSON.stringify({ action: 'finish', stage: '完成', reason: '稿件已保存并通过核查。', questions: [] }) };
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', delta: '稿件已保存并通过核查，可以查看当前稿件。' };
          yield { type: 'completed', finishReason: 'stop' };
        }
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new FinishStageProvider(); const f = setup(provider);
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.app.getProjectProjection('p').factCheck.status, 'passed');
    const finishRequests = provider.requests.filter(request => {
      const state = collaborationState(request);
      return state?.actor === 'director' && state.nextStage === null && !state.finished;
    });
    assert.equal(finishRequests.length, 1);
    assert.equal(finishRequests[0]!.parameters.toolChoice, 'none');
    assert.deepEqual(finishRequests[0]!.tools ?? [], []);
    const finish = f.storage.listRunEvents(result.runId).findLast(event => event.type === 'tool.requested' && event.payload.toolName === 'director_decide');
    assert.equal(finish?.payload.origin, 'harness_text_output');
    assert.deepEqual(finish?.payload.arguments, { action: 'finish', stage: null, reason: '稿件已保存并通过核查，可以查看当前稿件。', questions: [] });
    assert.equal(f.storage.listRunEvents(result.runId).filter(event => event.type === 'run.completed').length, 1);
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
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage,
          content: this.reworked ? '# 安静\n\n安静让我觉得轻松。' : '# 安静\n\n安静让我觉得轻松，效率增长99%。' })!;
        return;
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

for (const targetStage of ['outline', 'draft', 'review_editor', 'review_publish', 'central_revision', 'language_review']) {
const jsonReviewOutput = targetStage === 'review_editor' || targetStage === 'review_publish' || targetStage === 'central_revision' || targetStage === 'language_review';
const savedOnly = jsonReviewOutput || targetStage === 'outline' || targetStage === 'language_review';
it(savedOnly ? `shows only the saved public ${targetStage} without exposing structured text` : 'streams public ' + targetStage + ' before saving without exposing private payloads', async () => {
  // Language review must preserve the previous body, not replace it with a test outline.
  const partial = targetStage === 'language_review' ? '# 安静\n\n我喜欢' : '# 大纲\n\n第一段';
  const tail = targetStage === 'language_review' ? '这样的安静，central_revision' : '，第二段。';
  const full = partial + tail;
  let inspect: (request: ModelRequest, phase: string) => void = () => {};
  let structuredOutput = false;
  class StreamingOutlineProvider extends CollaborationProvider {
    outlined = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (targetStage === 'central_revision' && collaborationState(request)?.actor === 'language_review') {
        // The following polish stage must preserve the custom revision in this fixture.
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: 'language_review', content: full })!;
        return;
      }
      if (collaborationState(request)?.actor !== targetStage) { yield* super.providerStream(request); return; }
      if (!this.outlined) {
        this.outlined = true;
        const response = publicStageFixtureEvents(request, 'submit_writing_stage', { stage: targetStage, content: full })?.[0];
        if (jsonReviewOutput && response?.type === 'text_delta') {
          structuredOutput = true;
          if (targetStage === 'language_review') inspect(request, 'waiting');
          const midpoint = Math.floor(response.delta.length / 2);
          yield { type: 'text_delta', delta: response.delta.slice(0, midpoint) };
          inspect(request, 'metadata-only');
          yield { type: 'text_delta', delta: response.delta.slice(midpoint) };
          inspect(request, 'metadata-only');
          yield { type: 'completed', finishReason: 'stop' };
        } else if (response?.type === 'tool_call_delta') {
          structuredOutput = true;
          if (targetStage === 'language_review') inspect(request, 'waiting');
          const { content: _content, ...metadata } = JSON.parse(response.argumentsDelta ?? '{}');
          const tool = { type: 'tool_call_delta' as const, index: 0, id: 'stream-stage', name: 'submit_writing_stage' };
          yield { ...tool, argumentsDelta: JSON.stringify(metadata).slice(0, -1) };
          inspect(request, 'metadata-only');
          yield { ...tool, argumentsDelta: `,"content":${JSON.stringify(partial).slice(0, -1)}` };
          inspect(request, 'partial');
          yield { ...tool, argumentsDelta: `${JSON.stringify(tail).slice(1)}}` };
          inspect(request, 'full');
          yield { type: 'completed', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', delta: partial };
          inspect(request, 'partial');
          yield { type: 'text_delta', delta: tail };
          inspect(request, 'full');
          yield { type: 'completed', finishReason: 'stop' };
        }
        return;
      }
      assert.fail('a completed public text must be saved locally, not requested again for serialization');
    }
  }
  const f = setup(new StreamingOutlineProvider(), 'autonomous', 0, 'deep');
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'stream-test', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: f.input.budget } });
  const samples: string[] = [];
  let waitingActivity: ReturnType<typeof f.app.getLiveActivity> = null;
  let waitingError: unknown;
  let previewId = '';
  inspect = (request, phase) => {
    const run = f.storage.listRuns('p')[0]!;
    const preview = f.app.getLiveReply('p', run.sessionId, run.id);
    if (phase === 'waiting') {
      try { waitingActivity = f.app.getLiveActivity('p', run.sessionId, run.id); }
      catch (error) { waitingError = error; }
      return;
    }
    if (phase === 'metadata-only') {
      assert.equal(preview, null, 'structured metadata must not be published as a preview');
      return;
    }
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${run.id}:${targetStage}`).length, 0, 'streaming must never commit');
    samples.push(phase);
    if (savedOnly) {
      assert.equal(preview, null, 'structured final review content is visible only after saving');
      return;
    }
    assert.ok(preview, `${phase}: outline output must already be visible`);
    assert.equal(preview.text, phase === 'partial' ? partial : full);
    const identity = structuredOutput ? preview.requestId : preview.id!;
    previewId ||= identity;
    assert.equal(identity, previewId);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(samples, jsonReviewOutput ? [] : ['partial', 'full']);
    if (targetStage === 'language_review') {
      assert.equal(waitingError, undefined);
      const activity = waitingActivity as ReturnType<typeof f.app.getLiveActivity>;
      assert.ok(activity, 'active request must be visible');
      assert.ok(activity.materials?.some(item => item.text.includes('central_revision')), `bound manuscript must be available before model prose: ${JSON.stringify(activity)}`);
      assert.doesNotMatch(activity.workPreview?.label ?? '', /正在核对的已保存内容/, 'do not duplicate the manuscript as a legacy read preview');
      const finalBody = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.latestBodyVersionId!)!;
      assert.equal(finalBody.content, full, 'hide the in-flight text without losing any of the saved article');
    }
    assert.equal(f.app.getLiveReply('p', result.sessionId, result.runId), null);
    await bridge.selectSession('p', result.sessionId);
    const timeline = bridge.getSnapshot().timelineBySession[result.sessionId]!;
    const saved = timeline.filter(item => item.kind === 'message' && (structuredOutput
      ? item.stage === targetStage && item.body.includes(full) : item.id === previewId));
    assert.equal(saved.length, 1);
    if (!structuredOutput) assert.equal(saved[0]!.id, previewId, 'saved public text must reuse the same presentation identity');
    else assert.doesNotMatch((saved[0] as { body: string }).body, /selectedVersionId|测试夹具记录|"findings"|"audit"|"resolutions"/u);
  } finally { bridge.dispose(); f.close(); }
});

}

it('advertises combined readiness dispatch and separate gap assessment including resumed segments', async () => {
  const provider = new CollaborationProvider();
  const f = setup(provider, 'co_creation');
  try {
    const run = await f.app.runDraft(f.input);
    await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: run.runId, operationId: 'ready-resume', decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
    let pending = 0, ready = 0;
    for (const request of provider.requests) {
      const state = collaborationState(request);
      if (state?.actor !== 'director') continue;
      const names = request.tools?.map(tool => tool.name) ?? [];
      if (state.ready) { ready++; assert.ok(names.includes('director_decide')); }
      else { pending++; assert.ok(names.includes('director_decide')); assert.ok(names.includes('assess_writing_readiness'));
        assert.match(request.messages[0]!.content, /readinessReason/); }
    }
    assert.ok(pending >= 2 && ready >= 2);
  } finally { f.close(); }
});

it('continues a multi-confirmation workflow beyond its cumulative limit without regenerating saved stages', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  const input = { ...f.input, budget: { ...f.input.budget, maxModelRequests: 15 } };
  try {
    const run = await f.app.runDraft(input);
    for (let i = 0; i < 6; i++) {
      await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...input, runId: run.runId, operationId: 'segment-' + i, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
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
    for (const [index, phrase] of ['这个方向可以吗？', '初稿这样写可以吗？', '编辑审校的建议你认可吗？', '这三个模拟读者的感受，你怎么看？', '集中修订后的全文这样可以吗？', '终审后的这一版你认可吗？'].entries()) {
      if (index > 0) await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: result.runId, operationId: `inline-confirm-${index}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
      if (index === 5) {
        const listEvents = f.storage.listEvents.bind(f.storage);
        const terminal = listEvents('p').find(event => event.runId === result.runId && event.type === 'tool.completed' &&
          (event.payload.result as { result?: { stage?: string } })?.result?.stage === 'language_review');
        assert.ok(terminal);
        f.storage.listEvents = projectId => listEvents(projectId).flatMap(event =>
          event.id === terminal.id ? [event, { ...event, id: event.id + ':duplicate' }] : [event]);
      }
      await bridge.refresh();
      const check = () => {
        const timeline = bridge.getSnapshot().timelineBySession[result.sessionId]!;
        const questions = timeline.filter(item => item.kind === 'message' && item.body.includes(phrase));
        assert.equal(questions.length, 1, JSON.stringify({ phrase, run: f.storage.getRun(result.runId)?.stopReason, waiting: f.storage.listRunEvents(result.runId).filter(e => e.type === 'run.waiting_user').map(e => e.payload) }));
        assert.ok(questions[0]?.kind === 'message' && questions[0].body.startsWith('**') && questions[0].body.includes('已保存**'), 'question belongs to the saved result, not an extra card or message');
        if (index === 5) {
          const comparisons = timeline.filter(item => item.kind === 'message' && item.body.startsWith('**修订对照**'));
          assert.equal(comparisons.length, 1);
          assert.ok(questions[0]?.kind === 'message' && questions[0].body.endsWith('**' + phrase + '确认后再继续标题与事实核查；需要调整可以直接说。**'));
          assert.equal(timeline.indexOf(comparisons[0]!), timeline.indexOf(questions[0]!) + 1);
        }

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
      if (['title', 'review_reader', 'review_editor', 'language_review'].includes(state!.actor)) { yield* super.providerStream(request); return; }
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
    for (let i = 0; i < 6; i++) {
      assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user', JSON.stringify(f.storage.listRunEvents(first.runId).slice(-3)));
      await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: `material-resume-${i}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
    }
    assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user');
    assert.ok(getPublicationCandidates(f.storage, 'p'), 'reached title selection without increasing budget');
    const reads = f.storage.listRunEvents(first.runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'read_material');
    assert.equal(reads.length, 0, 'all 15 short inputs are supplied inline without explicit rereads');
    assert.ok(f.storage.listRunEvents(first.runId).some(e => e.type === 'request.failed' &&
      (e.payload.error as any)?.code === 'MODEL_RESPONSE_INVALID'), 'unadvertised reread is rejected before tool execution');
    assert.ok(provider.requests.filter(r => collaborationState(r)?.actor === 'research').every(r => !r.tools?.some(t => t.name === 'read_material')));
    const finalReviews = provider.requests.filter(r => collaborationState(r)?.actor === 'language_review');
    assert.ok(finalReviews.length > 0);
    for (const review of finalReviews) {
      assert.deepEqual(review.tools ?? [], []);
      assert.equal(review.parameters.toolChoice, 'none');
      assert.equal(review.messages.some(message => message.role === 'tool' && message.name === 'read_material'), false);
    }
    for (const request of provider.requests) {
      const state = collaborationState(request)!;
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
    const result = await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: first.runId, operationId: 'transport-retry', decision: 'retry_unknown', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
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
    readOffset = 0;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'outline' && this.looping) {
        // Exercise the general call allowance using distinct valid slices,
        // not the successful-read no-progress guard.
        const material = (collaborationState(request) as any).materialCatalog.find((m: any) => m.materialId === 'm-0');
        yield { type: 'tool_call_delta', index: 0, id: `read-page-${this.readOffset}`, name: 'read_material', argumentsDelta: JSON.stringify({materialId: 'm-0', contentVersionId: material.contentVersionId, offset: this.readOffset, maxChars: 100}) };
        this.readOffset += 100;
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new LimitedProvider();
  const f = setup(provider, 'co_creation', 1, 'quick', '外部资料原文'.repeat(500), 'web_snapshot');
  const input = { ...f.input, budget: { ...f.input.budget, maxModelRequests: 12 } };
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'protected-retry', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: input.budget } });
  try {
    const first = await f.app.runDraft(input);
    assert.equal(f.storage.getRun(first.runId)?.status, 'budget_exhausted', JSON.stringify(f.storage.listRunEvents(first.runId).filter(e => e.type === 'tool.failed' || e.type === 'run.waiting_user').map(e => e.payload)));
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

it('stops invalid language JSON after bounded recovery and retries only that expert, keeping saved stages', async () => {
  class RejectedLanguage extends CollaborationProvider {
    reject = true; actors: string[] = [];
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request)!; this.actors.push(state.actor);
      if (state.actor === 'language_review' && this.reject) {
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage, content: '审校完成。\n\n文章整体清晰，可以发布。' })!;
        return;
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
    assert.ok(rows.some(row=>row.kind==='tool' && row.detail.includes('没有保存')));
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
    assert.match(request.messages[0]!.content, /中低风险忽略.*不阻断/u);
    assert.match(request.messages[0]!.content, /external_source.*callId.*URL/u);
    assert.ok(request.tools?.some(tool => tool.name === 'submit_fact_check'));
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

it('resumed collaboration fact check retires consumed pages even during schema correction without losing raw trace', async () => {
  class ContinuedFactProvider extends CollaborationProvider {
    readonly factRequests: ModelRequest[] = [];
    invalidSubmissionSent = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state: any = collaborationState(request);
      if (state?.stage !== 'fact_check' || state.factPhase !== 'verify') { yield* super.providerStream(request); return; }
      this.requests.push(structuredClone(request));
      this.factRequests.push(structuredClone(request));
      const reads = request.messages.filter(m => m.role === 'tool' && m.name === 'read_fact_article');
      const evidenceRead = request.messages.some(m => m.role === 'tool' && m.name === 'read_fact_evidence');
      const name = reads.length < 2 ? 'read_fact_article' : !evidenceRead ? 'read_fact_evidence' : 'submit_fact_check';
      const args = reads.length < 2 ? { offset: reads.length * 8, maxChars: 8 } : !evidenceRead ? { evidenceIds: [] }
        : { claims: [], noFactualClaimsReason: this.invalidSubmissionSent ? '全文只有作者的感受，无待查关键事实。' : 99 };
      if (name === 'submit_fact_check') this.invalidSubmissionSent = true;
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const provider = new ContinuedFactProvider();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let index = 0; index < 6; index++) await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input,
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, runId: first.runId, operationId: `continuation-${index}`, decision: 'resume', userInstruction: '继续' })).result;
    const candidates = getPublicationCandidates(f.storage, 'p')!;
    choosePublicationCandidate(f.storage, 'p', 'continuation-title', '就用第一个', candidates.id, 1);
    const result = await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input,
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, runId: first.runId, operationId: 'continuation-fact', decision: 'resume', userInstruction: '标题已确认，请继续核查' })).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.storage.getFactCheckStatus('p').status, 'passed');
    assert.equal(provider.factRequests.length, 5, 'two article pages, one evidence read, one invalid submission and one bounded correction');
    const secondRead = provider.factRequests[1]!.messages.find(m => m.role === 'tool' && m.name === 'read_fact_article')!;
    assert.equal(JSON.parse(secondRead.content).result.requestProjection, undefined, 'newly requested page is delivered intact');
    const activePages = provider.factRequests[2]!.messages.filter(m => m.role === 'tool' && m.name === 'read_fact_article');
    assert.ok(activePages.every(m => JSON.parse(m.content).result.text.length === 8), 'active article pages remain visible together');
    for (const request of provider.factRequests.slice(3)) {
      const reads = request.messages.filter(m => m.role === 'tool' && m.name === 'read_fact_article');
      assert.equal(JSON.parse(reads[0]!.content).result.requestProjection, 'read_receipt_not_source');
      assert.equal(JSON.parse(reads[1]!.content).result.requestProjection, 'read_receipt_not_source');
      assert.equal(JSON.parse(request.messages.find(m => m.role === 'tool' && m.name === 'read_fact_evidence')!.content).result.requestProjection, undefined);
      assert.match(request.messages[0]!.content, /不从头重读完整正文和原始素材/);
    }
    const rawReads = f.storage.listRunEvents(first.runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'read_fact_article');
    assert.equal(rawReads.length, 2);
    assert.equal((rawReads[0]!.payload.result as any).result.text.length, 8, 'request-only projection must not delete the recorded page');
    assert.equal((rawReads[0]!.payload.result as any).result.requestProjection, undefined);
  } finally { f.close(); }
});

it('waits for co-author title selection before fact-checking and preserves that choice', async () => {
  const f = setup(new CollaborationProvider(), 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let index = 0; index < 6; index++) {
      const project = f.storage.inspectProject('p')!;
      await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: project.revision, runId: first.runId, operationId: `continue-${index}`, decision: 'resume', userInstruction: '继续' })).result;
    }
    assert.equal(f.storage.getRun(first.runId)!.status, 'waiting_user');
    assert.equal(f.storage.inspectProject('p')!.currentTitleVersionId, null, 'a generated heading is not a user selection');
    assert.ok(getPublicationCandidates(f.storage, 'p'));
    const candidate = getPublicationCandidates(f.storage, 'p')!;
    choosePublicationCandidate(f.storage, 'p', 'choose', '确认标题：安静', candidate.id, 1);
    const titleVersion = f.storage.inspectProject('p')!.currentTitleVersionId;
    const result = await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision, runId: first.runId, operationId: 'after-title', decision: 'resume', userInstruction: '标题已确认，请继续核查' })).result;
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
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage,
          content: '我喜欢这样的安静。它不是退场，而是把注意力重新放回眼前。\n\n窗边的光慢慢移动，房间也跟着有了层次。' })!;
        return;
      }
      yield* super.providerStream(request);
    }
  }

  const provider = new MissingTitleProvider();
  const f = setup(provider, 'co_creation');
  try {
    const first = await f.app.runDraft(f.input);
    for (let index = 0; index < 6; index++) {
      await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision,
        runId: first.runId, operationId: `missing-title-${index}`, decision: 'resume', userInstruction: '继续' })).result;
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
      if (collaborationState(request)) { yield* super.providerStream(request); return; }
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
    for (let n = 0; n < 6; n++) await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      runId: first.runId, operationId: `advance-${n}`, decision: 'resume', userInstruction: '继续' })).result;
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
    const editor = provider.requests.find((request) => collaborationState(request)?.actor === 'review_editor')!;
    const reader = provider.requests.find((request) => request.messages[0]?.content.startsWith('READER_SIMULATION_V1='))!;
    assert.ok(editor); assert.ok(reader);
    for (const request of provider.requests) {
      const role = collaborationState(request)?.actor;
      if (role === 'review_reader') assert.match(request.messages[0]!.content, /模拟反应.*不是真实用户调研/u);
      else if (role === 'review_editor') assert.match(request.messages[0]!.content, /第一次读到本文.*原句/u);
      else if (role === 'language_review') assert.match(request.messages[0]!.content, /独立语言终审.*原始引文/u);
      else if (role === 'fact_check') assert.match(request.messages[0]!.content, /事实核查专员|写作助手.*提取/u);
      else if (role === 'outline') assert.match(request.messages[0]!.content, /作者原话.*实际引文/u);
      else if (role === 'director' && request.parameters.toolChoice === 'none') {
        assert.equal(collaborationState(request)?.nextStage, null);
        assert.match(request.messages[0]!.content, /所有阶段均已完成/u);
      }
      else if (role) assert.ok(request.messages[0]!.content.includes(buildExpertInstructions(role)), `${role} must receive migrated professional instructions`);
    }
    assert.equal(JSON.stringify(reader.messages).includes("SECRET_OPINION_review_editor"), false);
    const revision = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=central_revision"))!;
    assert.match(revision.messages[1]!.content, /taskInstruction.*综合独立意见/u);
    assert.equal(reader.tools?.some((tool) => tool.name === "director_decide") ?? false, false);
    for (const request of provider.requests.filter((request) => !['director', 'outline', 'fact_check', 'review_editor', 'review_reader', 'language_review'].includes(collaborationState(request)?.actor ?? ''))) {
      assert.match(request.messages[1]!.content, /taskInstruction/u);
      assert.match(request.messages[1]!.content, /expectedArtifact/u);
      assert.doesNotMatch(request.messages[0]!.content, /你是 Writing Agent 的主笔|并非已隔离|每个新开始或恢复的执行段/u);
      assert.doesNotMatch(request.messages[1]!.content, /必须先用 read_material/u);
    }
    const languageRequest = provider.requests.find((request) => collaborationState(request)?.stage === "language_review")!;
    const draftRequest = provider.requests.find((request) => collaborationState(request)?.stage === 'draft')!;
    assert.match(draftRequest.messages[0]!.content, /已确认主题作工作标题/u);
    assert.doesNotMatch(draftRequest.messages[0]!.content, /带真实标题/u);
    assert.match(languageRequest.messages[0]!.content, /完整.*正文/u);
    assert.match(languageRequest.messages[0]!.content, /新增.*工作备注/u);
    assert.match(languageRequest.messages[0]!.content, /保留必要归属、条件和不确定性/u);
    assert.match(languageRequest.messages[0]!.content, /内部判断只放在 audit\/comparison/u);
    const languageState = collaborationState(languageRequest) as any;
    assert.equal(languageState.bodyOutputContract.output, 'complete_article_only');
    assert.equal(languageState.bodyOutputContract.versions.length, 2);
    assert.doesNotMatch(languageRequest.messages[1]!.content, /taskInstruction|expectedArtifact|editorialPlan/u);
    const directorRequest = provider.requests.find(request => collaborationState(request)?.actor === 'director')!;
    assert.match(directorRequest.messages[0]!.content, /不要.*整理稿/u);
    const decisions = f.storage.listRunEvents(result.runId).filter((event) => event.type === "tool.completed" && (event.payload.result as any)?.toolName === "director_decide");
    assert.ok(decisions.length >= 9);
    const savedRequests = f.storage.listRequestSnapshots(result.runId);
    const savedReader = savedRequests.find((snapshot) => collaborationState(snapshot.request)?.stage === "review_reader")!;
    assert.ok(savedReader);
    assert.match(savedReader.request.messages[1]!.content, /READER_ARTICLE=/u);
    assert.equal(JSON.stringify(savedReader.request.messages).includes("SECRET_OPINION_review_editor"), false);
    assert.deepEqual(savedReader.toolSchemas, []);
    assert.equal(savedReader.request.tools?.length ?? 0, 0);
    const savedEditor = savedRequests.find((snapshot) => collaborationState(snapshot.request)?.stage === "review_editor")!;
    assert.ok(collaborationState(savedEditor.request)?.inputVersionIds.includes(collaborationState(savedReader.request)!.inputVersionIds[0]!));
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
    const resumed = await serviceAfterRestart.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: project.revision, runId: first.runId, operationId: "resume-rework", decision: "resume", userInstruction: "提纲改成对比结构" })).result;
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
    const draftId = f.storage.listArtifactVersions('p', 'body', 'main')[0]!.id;
    assert.deepEqual(reviewInputs[0].inputVersionIds, [draftId]);
    assert.ok(reviewInputs[1].inputVersionIds.includes(draftId));
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
        if (state.stage === 'language_review') {
          const comparison = state.revisionComparison!;
          assert.deepEqual(comparison.allowedSelectionIds, [comparison.revisedVersionId], 'fact repair cannot reopen the initial draft for selection');
        }
        yield* publicStageFixtureEvents(request, 'submit_writing_stage', { stage: state.stage,
          content: '# 安静\n\n已按授权删去数字，只表达我的感受。' })!;
        return;
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
    const next = await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, runId: first.runId, operationId: "authorize-fact-edit", decision: "resume", userInstruction: "请删去增长99%的句子，先修改正文后重新核查，无需再问同一授权。" })).result;
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
    assert.equal(state.artifacts.find((artifact: any) => artifact.kind === 'body').id, f.storage.inspectProject("p")!.latestBodyVersionId);
    assert.match(fact.request.messages[0]!.content, /prepare_fact_check/u);
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
    const result = await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, expectedProjectRevision: f.storage.inspectProject("p")!.revision, runId: "legacy-run", operationId: "resume-legacy", decision: "resume", userInstruction: "基于中断前的稿件继续完善。" })).result;
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

it('rejects an invalid evidence ledger at research commit and stops the blind retry loop', async () => {
  class InvalidLedger extends CollaborationProvider {
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = collaborationState(request)!;
      if (state.actor === 'research') {
        this.requests.push(structuredClone(request));
        const source = { source_id: 'S1', source_title: '材料', source_publisher: '用户提供', accessed_at: '本次运行' };
        const claim = { source_id: source.source_id, evidence_id: 'E001', claim_type: 'other', claim_text: '无引句的事实',
          source_quote: '', reliability: 'high', use_boundary: '无', verification_status: 'illustrative_only' };
        yield { type: 'tool_call_delta', index: 0, id: `invalid-ledger-${this.requests.length}`, name: 'submit_writing_stage',
          argumentsDelta: JSON.stringify({ stage: 'research', content: { sources: [source], claims: [claim],
            notes: '尝试提交没有引句的主张。', editorialPlan: editorialPlanFixture(['E001']) } }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
        return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new InvalidLedger();
  const f = setup(provider);
  const bridge = createApplicationBridge({ service: f.app, workspaceId: 'ledger-gate-loop', model: { model: 'mock', providerLabel: 'test', credentialReference: null, parameters: {}, budget: f.input.budget } });
  try {
    const first = await f.app.runDraft(f.input);
    const run = f.storage.getRun(first.runId)!;
    assert.equal(run.status, 'waiting_user');
    assert.equal(run.stopReason, 'TOOL_FAILURE_LOOP');
    const failures = f.storage.listRunEvents(first.runId)
      .filter((event) => event.type === 'tool.failed' && JSON.stringify(event.payload).includes('EVIDENCE_LEDGER_INVALID'));
    assert.equal(failures.length, 3, 'the breaker stops the loop after three identical gate rejections');
    const correction = provider.requests.flatMap(request => request.messages)
      .filter(message => message.role === 'tool' && message.name === 'submit_writing_stage')
      .map(message => JSON.parse(message.content).error?.details?.correction).find(Boolean);
    assert.match(correction, /Empty source_quote.*verification_status exactly 'illustrative'.*'illustrative_only' is not that value/u);
    assert.match(correction, /continuous source quote or omit the unsupported claim/u);
    assert.equal(f.storage.inspectProject('p')!.currentEvidenceVersionId, null, 'invalid ledger must not persist');
    await bridge.selectSession('p', first.sessionId);
    assert.equal(bridge.getSnapshot().recoverableRuns[0]?.stopReason, 'TOOL_FAILURE_LOOP');
    const rows = bridge.getSnapshot().timelineBySession[first.sessionId] ?? [];
    assert.ok(rows.some((row) => row.kind === 'tool' && row.label === '这一步未能完成'));
  } finally { bridge.dispose(); f.close(); }
});
