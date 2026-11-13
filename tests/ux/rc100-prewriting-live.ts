/** Opt-in, bounded real-model experiment. Never opens the personal workspace for writing. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { groupProviderConfig, loadDesktopProviderCatalog, loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { SearchSettingsStore } from '../../apps/desktop/src/search-settings.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { projectStyleSelection, saveProjectStyleSelection } from '../../packages/application/src/style-selection.js';
import { stageMarker } from '../../packages/application/src/workflow-tools.js';
import { withCheckpointIntent } from '../../packages/application/test/intent-fixture.js';

const mode = process.argv[2];
assert.ok(mode === 'frozen' || mode === 'reframed' || mode === 'reviewed');
const output = resolve(process.argv[3] ?? `output/quality/rc100/${mode}`);
mkdirSync(output, { recursive: false });
const inheritedFrom = mode === 'reviewed' ? resolve(process.argv[4]!) : null;
const inherited = inheritedFrom ? JSON.parse(readFileSync(join(inheritedFrom, 'summary.json'), 'utf8')) : null;
if (inheritedFrom) cpSync(join(inheritedFrom, 'workspace'), join(output, 'workspace'), { recursive: true, errorOnExist: true });
assert.ok(process.env.WRITING_AGENT_COMPARE_WORKSPACE && process.env.WRITING_AGENT_COMPARE_PROJECT,
  'Set WRITING_AGENT_COMPARE_WORKSPACE and WRITING_AGENT_COMPARE_PROJECT to the authorized read-only source.');
const source = openWorkspaceStorage({ workspacePath: process.env.WRITING_AGENT_COMPARE_WORKSPACE, readOnly: true });
const original = source.inspectProject(process.env.WRITING_AGENT_COMPARE_PROJECT)!;
assert.ok(original?.currentBriefVersionId && original.currentEvidenceVersionId, 'The source needs a saved brief and research.');
const savedBrief = source.getWritingBriefVersion(original.currentBriefVersionId!)!.brief;
const originalMaterials = savedBrief.materialIds.map(id => source.getMaterial(original.id, id)!);
const style = projectStyleSelection(source, original.id);
const ledger = source.getArtifactVersion(original.currentEvidenceVersionId!)!.content;
const protectedHashes = () => source.listProjects().flatMap(p => (['body', 'title'] as const).flatMap(kind =>
  source.listArtifactVersions(p.id, kind, 'main').map(v => [v.id, createHash('sha256').update(v.content).digest('hex')])));
const before = protectedHashes();
const profilePath = join(process.env.APPDATA!, 'Writing Agent/provider.json');
const profileBefore = readFileSync(profilePath);
const catalog = loadDesktopProviderCatalog(profilePath);
const fallback = loadDesktopProviderProfile(profilePath);
const credentials = createDefaultCredentialBroker();
const searchEnabled = mode === 'reframed' && process.env.WRITING_AGENT_COMPARE_SEARCH === '1';
const searchSettings = new SearchSettingsStore(join(process.env.APPDATA!, 'Writing Agent/search-settings.json'), credentials);
const storage = openWorkspaceStorage({ workspacePath: join(output, 'workspace') });
const actor = { kind: 'user', id: 'rc100-simulated-author' } as const;
const p = 'rc100-test';
let actualRequests = 0;
const cap = Number(process.env.WRITING_AGENT_COMPARE_CAP ?? (mode === 'frozen' ? 5 : mode === 'reviewed' ? 14 : 12));
assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 14, 'Request cap must be an integer from 1 to 14.');
const routes: Record<string, string> = {};
const tool = (request: ModelRequest, name: string, args: unknown): ProviderStreamEvent[] => [
  { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) }, { type: 'completed', finishReason: 'tool_calls' }];
const stateFor = (request: ModelRequest) => JSON.parse(request.messages.find(m => m.role === 'user')!.content.split('\nCOLLABORATION_STATE=')[1]!);
const director = new class extends ModelProviderBase {
  constructor() { super('rc100-scripted-director', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest) {
    const state = stateFor(request);
    if (state.prewritingReturn) {
      yield* tool(request, 'director_decide', { action: 'ask', stage: null, reason: state.prewritingReturn.reason, questions: state.prewritingReturn.questions }); return;
    }
    if (state.revisionReturn) {
      yield* tool(request, 'director_decide', { action: 'rework', stage: 'central_revision', reason: '按终审发现的具体问题修正正文，保留有效内容。', questions: [] }); return;
    }
    const unread = state.unreadArtifactVersionIds?.[0];
    if (unread) { yield* tool(request, 'read_artifact_version', { versionId: unread }); return; }
    if (!state.ready) {
      yield* tool(request, 'assess_writing_readiness', { status: 'ready', reason: '本次测试输入与已保存成果已提供；专家仍须按材料判断并可退回。', questions: [] }); return;
    }
    assert.ok((mode === 'reviewed' ? ['review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review'] : ['research', 'outline', 'draft']).includes(state.nextStage), 'Experiment stops at the configured article checkpoint');
    yield* tool(request, 'director_decide', { action: 'dispatch', stage: state.nextStage, reason: '按原始作者需求和本次材料完成当前任务。', questions: [], readinessReason: '本次输入已提供，缺关键证据应退回讨论。' });
  }
}();
const replayResearch = new class extends ModelProviderBase {
  constructor() { super('rc100-replay-research', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest) { yield* tool(request, 'submit_writing_stage', { stage: 'research', content: ledger }); }
}();
const providers = new Map<string, ReturnType<typeof createConfiguredProvider>>();
function real(role: string) {
  const config = groupProviderConfig(catalog, fallback, role)!;
  routes[role] = config.model;
  if (!providers.has(role)) providers.set(role, createConfiguredProvider(config, credentials));
  const delegate = providers.get(role)!;
  return { model: config.model, provider: {
    id: delegate.id, adapterVersion: delegate.adapterVersion, capabilities: delegate.capabilities,
    capabilitiesFor: (model: string) => delegate.capabilitiesFor(model), snapshotRequest: (request: ModelRequest) => delegate.snapshotRequest(request),
    async *stream(request: ModelRequest) {
      assert.ok(actualRequests < cap, 'Real request cap reached'); actualRequests++;
      console.log(JSON.stringify({ role, model: config.model, actualRequests, cap }));
      for await (const event of delegate.stream(request)) yield event;
    },
  } };
}
const app = new WritingApplicationService({ storage, provider: director,
  resolveModel: role => role === 'director' ? { provider: director, model: 'scripted' }
    : mode === 'frozen' && role === 'research' ? { provider: replayResearch, model: 'replay' } : real(role!),
  factSearchConfiguration: () => searchEnabled ? searchSettings.configuration() : ({ parallelEnabled: false, tavilyEnabled: false, deepseekEnabled: false }),
});
let runId: string | undefined;
const revision = () => storage.inspectProject(p)!.revision;
const input = () => ({ projectId: p, expectedProjectRevision: revision(), expectedBriefVersionId: storage.inspectProject(p)!.currentBriefVersionId!,
  model: 'scripted', parameters: { temperature: 0 }, budget: { maxModelRequests: 30, maxToolCalls: 50, maxRetriesPerRequest: 1, maxMajorRevisions: 2 }, signal: AbortSignal.timeout(20 * 60_000) });
try {
  if (mode === 'reviewed') {
    runId = storage.listRuns(p).find(r => r.planVersion !== 'test-semantic-decision')!.id;
    for (let n = 0; n < 8; n++) {
      const checkpoint = storage.getRun(runId)?.stopReason === 'CO_CREATION_CHECKPOINT';
      await app.resumeDraft(withCheckpointIntent(storage, { ...input(), runId, operationId: randomUUID(),
        decision: storage.getRun(runId)?.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' ? 'retry_unknown' : 'resume',
        ...(checkpoint ? { userInstruction: '认可，继续。' } : {}) })).result;
      const wait = storage.listRunEvents(runId).findLast(e => e.type === 'run.waiting_user');
      if (wait?.payload.stage === 'language_review' || storage.getRun(runId)?.stopReason !== 'CO_CREATION_CHECKPOINT') break;
    }
  } else {
  assert.ok(app.createProject({ operationId: randomUUID(), projectId: p, name: '胡雪岩与马斯克同题对照', mode: 'deep', actor }).ok);
  for (const m of originalMaterials) {
    assert.ok(app.importMaterial({ operationId: randomUUID(), projectId: p, expectedProjectRevision: revision(), actor,
      materialId: m.id, displayName: m.displayName, sourceKind: m.sourceKind, sourceReference: m.sourceReference,
      role: m.role, trustLabel: m.trustLabel, permissionScope: 'project_only', content: m.content }).ok);
  }
  let brief = savedBrief;
  if (mode === 'reframed') {
    const choice = readFileSync(process.argv[4]!, 'utf8').trim();
    const excerpts = JSON.stringify({ purpose: '冻结原材料与记录的时间、归属背景；这些旧分析仍须对照引文判断，不继承旧切口或写作结构。',
      claims: JSON.parse(ledger).claims }, null, 2);
    assert.ok(app.importMaterial({ operationId: randomUUID(), projectId: p, expectedProjectRevision: revision(), actor, materialId: 'frozen-sources',
      displayName: '本次原材料的冻结引文', sourceKind: 'pasted_text', sourceReference: '原任务研究摘录，未重新联网核验', role: 'source_verified',
      trustLabel: 'external_untrusted', permissionScope: 'project_only', content: excerpts }).ok);
    assert.ok(app.importMaterial({ operationId: randomUUID(), projectId: p, expectedProjectRevision: revision(), actor, materialId: 'intake-user-simulated-choice',
      displayName: '隔离测试的模拟作者取舍', sourceKind: 'pasted_text', sourceReference: 'test-only', role: 'illustrative',
      trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: choice }).ok);
    brief = { ...savedBrief, topic: choice, materialIds: [...savedBrief.materialIds, 'frozen-sources', 'intake-user-simulated-choice'], constraints: ['模拟作者选择了这个新切口；旧的“私生活就是商业布局”不再是必须证明的结论。', '仍写胡雪岩与马斯克的比较，不编造人物动机或史实。'], lengthTarget: { targetCharacters: 1400 } };
  }
  assert.ok(app.saveWritingBrief({ operationId: randomUUID(), projectId: p, expectedProjectRevision: revision(), baseVersionId: null,
    actor: mode === 'frozen' ? { kind: 'user', id: 'conversation-user' } : actor, brief }).ok);
  saveProjectStyleSelection(storage, p, style, randomUUID());
  let result = await app.runDraft(input()); runId = result.runId;
  if (mode === 'reframed' && storage.getRun(runId)?.stopReason === 'CO_CREATION_CHECKPOINT') {
    result = await app.resumeDraft(withCheckpointIntent(storage, { ...input(), runId, operationId: randomUUID(), decision: 'resume', userInstruction: '认可，继续。' })).result;
  }
  }
} finally {
  runId ??= storage.listRuns(p).find(r => r.planVersion !== 'test-semantic-decision')?.id;
  if (runId) for (const stage of ['research', 'outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review'] as const) {
    const marker = stageMarker(storage, p, runId, stage);
    if (marker) { const v = storage.getArtifactVersion(JSON.parse(marker.content).artifactVersionId)!; writeFileSync(join(output, `${stage}.${stage === 'research' ? 'json' : 'md'}`), v.content); }
  }
  const reports = storage.listArtifactVersions(p, 'report', 'prewriting-assessment');
  writeFileSync(join(output, 'assessments.json'), JSON.stringify(reports.map(r => JSON.parse(r.content)), null, 2));
  const wait = runId ? storage.listRunEvents(runId).findLast(e => e.type === 'run.waiting_user')?.payload : null;
  const summary = { mode, runId, actualRequests, cap, routes, stopReason: runId ? storage.getRun(runId)?.stopReason : null, wait,
    bodyVersions: storage.listArtifactVersions(p, 'body', 'main').length, protectedContentUnchanged: JSON.stringify(before) === JSON.stringify(protectedHashes()),
    profileUnchanged: profileBefore.equals(readFileSync(profilePath)), frozenSources: inherited ? inherited.frozenSources && inherited.researchSearches === 0 : !searchEnabled,
    inheritedFrom, inheritedRequests: inherited ? (inherited.inheritedRequests ?? 0) + inherited.actualRequests : 0,
    researchSearches: runId ? storage.listRunEvents(runId).filter(e => e.type === 'tool.requested' && e.payload.toolName === 'search_research_sources').length : 0,
    directorAndConfirmations: 'scripted test, not actual user choices' };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
  assert.ok(summary.protectedContentUnchanged && summary.profileUnchanged);
  storage.close(); source.close();
}
