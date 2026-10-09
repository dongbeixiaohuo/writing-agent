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
import { publicStageFixtureEvents, factPreparationFixtureEvents, readerSimulationFixtureEvents } from './collaboration-fixture.js';
import { withCheckpointIntent, withIntentFixture } from './intent-fixture.js';
import { deliveredInlineMaterialIds, inlineMaterialContext } from '../src/material-context.js';
import { getConversationIntakeState } from '../src/conversation-intake.js';
import { parseEvidenceLedger } from '../../writing-core/src/index.js';
import { expandResearchEvidence } from '../src/research-evidence.js';

export class CollaborationProvider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  constructor(readonly blocked = false) { super("collaboration-mock", "1.0.0", { protocol: "mock", tools: "supported", streaming: "supported", usage: "unknown" }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const reader = readerSimulationFixtureEvents(request);
    if (reader) { yield* reader; return; }
    const extraction = factPreparationFixtureEvents(request);
    if (extraction) { yield* extraction; return; }
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
    }
    const verification = checks.find(request => (collaborationState(request) as any)?.factPhase === 'verify')!;
    assert.match(verification.messages[0]!.content, parallelEnabled ? /需要联网.*公开事实/u : /未启用外部搜索.*未联网/u);
  } finally { f.close(); }
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
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'submit_writing_stage', argumentsDelta: JSON.stringify({ stage: 'research', content: this.content }) };
      yield { type: 'completed', finishReason: 'tool_calls' }; return;
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
    const expected = { claims: compact.claims.map(({ source_id: ref, ...claim }, i) => ({ ...source, ...claim, evidence_id: `E${String(i + 1).padStart(3, '0')}` })), notes: compact.notes };
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
      } else assert.deepEqual(ledger, { claims: [], notes: content.notes });
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

it('projects evidence and original sources for every downstream expert, with on-demand source access', async () => {
  const provider = new CollaborationProvider(); const f = setup(provider, 'autonomous', 1, 'quick', '外部资料原文', 'web_snapshot');
  try {
    assert.equal((await f.app.runDraft(f.input)).ok, true);
    for (const actor of ['outline', 'draft', 'review_editor', 'central_revision', 'language_review']) {
      const request = provider.requests.find(r => collaborationState(r)?.actor === actor)!;
      const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
      assert.equal(typeof state.artifacts.find((a: any) => a.kind === 'evidence').content, 'object', actor);
      assert.ok(Array.isArray(state.materialCatalog), actor);
      assert.ok(request.tools?.some(t => t.name === 'read_material'), `${actor} can read omitted material if needed`);
      assert.equal(Boolean(request.tools?.some(t => t.name === 'read_artifact_version')), actor.startsWith('review_') || actor === 'language_review',
        `${actor}: exact quotes remain readable when not included by default`);
    }
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

it('scales outline and research guidance to the article without imposing a truncating save limit', async () => {
  const provider=new CollaborationProvider(); const f=setup(provider,'co_creation');
  try {
    await f.app.runDraft(f.input);
    const outline=provider.requests.find(r=>collaborationState(r)?.actor==='outline')!;
    const research=provider.requests.find(r=>collaborationState(r)?.actor==='research')!;
    assert.match(outline.messages[0]!.content,/提纲.*篇幅|篇幅.*提纲/u);
    assert.match(research.messages[0]!.content,/实际.*进入正文|正文.*需要/u);
    const state=JSON.parse(outline.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    assert.equal(state.outputGuidance.articleTargetCharacters,800);
    assert.ok(state.outputGuidance.outlineTargetCharacters<=800);
    assert.match(outline.messages[0]!.content,/不.*证据编号/);
    assert.match(outline.messages[0]!.content,/不截断|不是.*硬.*上限/);
  } finally {f.close();}
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
    assert.deepEqual(request.tools?.map(t => t.name).sort(), ['assess_writing_readiness']);
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

for (const targetStage of ['outline', 'draft', 'review_editor', 'review_publish', 'central_revision', 'language_review']) {
it('streams public ' + targetStage + ' before saving with stable identity', async () => {
  // Language review must preserve the previous body, not replace it with a test outline.
  const partial = targetStage === 'language_review' ? '# 安静\n\n我喜欢' : '# 大纲\n\n第一段';
  const tail = targetStage === 'language_review' ? '这样的安静，central_revision' : '，第二段。';
  const full = partial + tail;
  let inspect: (request: ModelRequest, phase: string) => void = () => {};
  class StreamingOutlineProvider extends CollaborationProvider {
    outlined = false;
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (targetStage === 'central_revision' && collaborationState(request)?.actor === 'language_review') {
        // The following polish stage must preserve the custom revision in this fixture.
        yield { type: 'text_delta', delta: full };
        yield { type: 'completed', finishReason: 'stop' };
        return;
      }
      if (collaborationState(request)?.actor !== targetStage) { yield* super.providerStream(request); return; }
      if (!this.outlined) {
        this.outlined = true;
        if (targetStage === 'language_review') inspect(request, 'waiting');
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
    assert.ok(preview, `${phase}: outline output must already be visible`);
    assert.equal(preview.text, phase === 'partial' ? partial : full);
    assert.equal(f.storage.listArtifactVersions('p', 'report', `workflow:${run.id}:${targetStage}`).length, 0, 'preview must never commit');
    previewId ||= preview.id!;
    assert.equal(preview.id, previewId);
    samples.push(phase);
  };
  try {
    const result = await f.app.runDraft(f.input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(samples, ['partial', 'full']);
    if (targetStage === 'language_review') {
      assert.equal(waitingError, undefined);
      const activity = waitingActivity as ReturnType<typeof f.app.getLiveActivity>;
      assert.ok(activity, 'active request must be visible');
      assert.ok(activity.materials?.some(item => item.text.includes('central_revision')), `bound manuscript must be available before model prose: ${JSON.stringify(activity)}`);
      assert.doesNotMatch(activity.workPreview?.label ?? '', /正在核对的已保存内容/, 'do not duplicate the manuscript as a legacy read preview');
    }
    assert.equal(f.app.getLiveReply('p', result.sessionId, result.runId), null);
    await bridge.selectSession('p', result.sessionId);
    const timeline = bridge.getSnapshot().timelineBySession[result.sessionId]!;
    const saved = timeline.filter(item => item.kind === 'message' && item.id === previewId);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.id, previewId, 'saved output must reuse the same presentation identity');
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
    for (const [index, phrase] of ['这个方向可以吗？', '初稿这样写可以吗？', '编辑审校的建议你认可吗？', '这三个模拟读者的感受，你怎么看？', '集中修订后的全文这样可以吗？', '润色后的这一版你认可吗？'].entries()) {
      if (index > 0) await f.app.resumeDraft(withCheckpointIntent(f.storage, { ...f.input, runId: result.runId, operationId: `inline-confirm-${index}`, decision: 'resume', userInstruction: '继续', expectedProjectRevision: f.storage.inspectProject('p')!.revision })).result;
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
      if (state!.actor === 'title' || state!.actor === 'review_reader') { yield* super.providerStream(request); return; }
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
    protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      if (collaborationState(request)?.actor === 'outline' && this.looping) {
        // Exercise the general call allowance, not the text-save repetition guard.
        const material = (collaborationState(request) as any).materialCatalog.find((m: any) => m.materialId === 'm-0');
        yield { type: 'tool_call_delta', index: 0, id: `read-loop-${this.requests.length}`, name: 'read_material', argumentsDelta: JSON.stringify({materialId: 'm-0', contentVersionId: material.contentVersionId, offset: 0, maxChars: 100}) };
        yield { type: 'completed', finishReason: 'tool_calls' }; return;
      }
      yield* super.providerStream(request);
    }
  }
  const provider = new LimitedProvider();
  const f = setup(provider, 'co_creation', 1, 'quick', '外部资料原文', 'web_snapshot');
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
    const editor = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=review_editor"))!;
    const reader = provider.requests.find((request) => request.messages[0]?.content.startsWith('READER_SIMULATION_V1='))!;
    assert.ok(editor); assert.ok(reader);
    for (const request of provider.requests) {
      const role = collaborationState(request)?.actor;
      if (role === 'review_reader') assert.match(request.messages[0]!.content, /模拟反应.*不是真实用户调研/u);
      else if (role === 'fact_check') assert.match(request.messages[0]!.content, /事实核查专员|写作助手.*提取/u);
      else if (role) assert.ok(request.messages[0]!.content.includes(buildExpertInstructions(role)), `${role} must receive migrated professional instructions`);
    }
    assert.equal(JSON.stringify(reader.messages).includes("SECRET_OPINION_review_editor"), false);
    const revision = provider.requests.find((request) => request.messages[0]?.content.includes("ACTOR=central_revision"))!;
    assert.match(revision.messages[1]!.content, /taskInstruction.*综合独立意见/u);
    assert.equal(reader.tools?.some((tool) => tool.name === "director_decide") ?? false, false);
    for (const request of provider.requests.filter((request) => !['director', 'fact_check', 'review_reader'].includes(collaborationState(request)?.actor ?? ''))) {
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
    assert.match(languageRequest.messages[0]!.content, /不是.*评审报告/u);
    assert.match(languageRequest.messages[0]!.content, /内部材料标签/u);
    assert.match(languageRequest.messages[0]!.content, /不虚构来源、不移除实质限定/u);
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
        yield { type: 'tool_call_delta', index: 0, id: `invalid-ledger-${this.requests.length}`, name: 'submit_writing_stage',
          argumentsDelta: JSON.stringify({ stage: 'research', content: '{"claims":[{"evidence_id":"E001","claim_type":"other","claim_text":"无引句的事实","source_title":"材料","source_publisher":"用户提供","source_quote":"","accessed_at":"本次运行","reliability":"high","use_boundary":"无","verification_status":"user_provided"}]}' }) };
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
    assert.equal(f.storage.inspectProject('p')!.currentEvidenceVersionId, null, 'invalid ledger must not persist');
    await bridge.selectSession('p', first.sessionId);
    assert.equal(bridge.getSnapshot().recoverableRuns[0]?.stopReason, 'TOOL_FAILURE_LOOP');
    const rows = bridge.getSnapshot().timelineBySession[first.sessionId] ?? [];
    assert.ok(rows.some((row) => row.kind === 'tool' && row.label === '自动重试已暂停'));
  } finally { bridge.dispose(); f.close(); }
});
