import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { AgentRuntime } from '../../runtime/agent/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { ToolExecutionFault, ToolRegistry, type ToolDefinition } from '../../runtime/tools/src/index.js';
import type { JsonValue, WritingBrief } from '../../writing-core/src/index.js';
import type { StyleSelectionSnapshot } from '../../writing-core/src/style-package.js';
import { createWritingCollaboration } from '../src/collaboration.js';
import { createFactSearchTools } from '../src/fact-search.js';
import type { PrewritingAssessment } from '../src/prewriting.js';
import type { ResearchReading } from '../src/research-readings.js';
import { createOutlineSupplement } from '../src/research-supplement.js';
import { saveProjectStyleSelection } from '../src/style-selection.js';
import { createWritingWorkflowTools } from '../src/workflow-tools.js';

type ReplaySearchHit = { title: string; url: string; content: string };

export interface ReadingHandoffFixture {
  brief: WritingBrief;
  authorReplies: string[];
  rawAuthorText: string[];
  firstReading: ResearchReading;
  researchLedger: string;
  assessment: PrewritingAssessment;
  outlineContent?: string;
  supplement: ResearchReading;
  firstSearchQuery?: string;
  style?: StyleSelectionSnapshot | null;
  model?: string;
  parameters?: ModelRequest['parameters'];
  savedDraft?: string;
  recordedResearch?: {
    queries: ReadonlyMap<string, ReplaySearchHit[]>;
    followupQueries: string[];
    readings: ResearchReading[];
  };
  recordedSupplement?: {
    queries: ReadonlyMap<string, ReplaySearchHit[]>;
    readings: ReadonlyMap<string, ResearchReading>;
    select?(readings: readonly ResearchReading[]): NonNullable<PrewritingAssessment['readingRoute']>['moments'];
  };
}

interface PostDraftReplay {
  body: string;
  stopAfterCentralRevision?: boolean;
  answer(request: ModelRequest, stage: 'review_editor' | 'central_revision' | 'language_review'): Record<string, unknown>;
}

const permissions = ['workflow:submit', 'artifact:read', 'material:list', 'material:read', 'network:https:read', 'network:http:read'];
const stateOf = (request: ModelRequest) => JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);

function tool(request: ModelRequest, name: string, args: Record<string, unknown>): ProviderStreamEvent[] {
  return [{ type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) },
    { type: 'completed', finishReason: 'tool_calls' }];
}

// Stop at the Writer request, or replay saved prose through review. No model or search service is contacted.
export async function replayReadingHandoff(fixture: ReadingHandoffFixture,
  outcome: 'found' | 'missing' | 'reprint' | 'not_authorized' | 'irrelevant' | 'blocked_first', postDraft?: PostDraftReplay) {
  const path = mkdtempSync(join(tmpdir(), 'wa-reading-handoff-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  const stop = new AbortController();
  const actor = { kind: 'user', id: 'replay' } as const;
  const publicQueries: string[] = [];
  let sourceReads = 0;
  let initialSearchDispatched = false;
  let archivedQueriesSent = false;
  let followupQueriesSent = false;
  let readingsReplayed = false;
  let outlineRequests = 0;
  let draftRequest: ModelRequest | undefined;
  const reviewRequests: ModelRequest[] = [];
  const projectId = 'p';
  try {
    assert.ok(storage.createProject({ projectId, name: '写前交接回放', mode: 'deep', actor, operationId: 'create' }).ok);
    const materialIds = fixture.rawAuthorText.map((content, i) => {
      const materialId = `intake-user-replay-${i}`;
      assert.ok(storage.importMaterial({ projectId, expectedProjectRevision: storage.inspectProject(projectId)!.revision, materialId,
        operationId: materialId, displayName: '作者原话', sourceKind: 'pasted_text', sourceReference: null, role: 'illustrative',
        trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content, actor }).ok);
      return materialId;
    });
    assert.ok(storage.saveWritingBrief({ projectId, expectedProjectRevision: storage.inspectProject(projectId)!.revision, baseVersionId: null,
      operationId: 'brief', actor, brief: { ...fixture.brief, materialIds, interactionMode: 'autonomous',
        authorAuthorization: { ...fixture.brief.authorAuthorization, firsthandMaterialIds: [] } } }).ok);
    if (fixture.style !== undefined) saveProjectStyleSelection(storage, projectId, fixture.style, 'style');
    const configuration = () => ({ parallelEnabled: false, tavilyEnabled: true, getTavilyKey: async () => 'fixture',
      ...(outcome === 'not_authorized' ? {} : { authorizationMode: 'enabled_services' as const }) });
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const query = JSON.parse(String(init?.body)).query;
      publicQueries.push(query);
      const recordedHits = fixture.recordedSupplement?.queries.get(query) ?? fixture.recordedResearch?.queries.get(query);
      if (fixture.recordedResearch || fixture.recordedSupplement) return Response.json({ results: recordedHits ?? [] });
      const reading = query === fixture.firstSearchQuery ? fixture.firstReading : outcome === 'missing' ? null : fixture.supplement;
      const results = reading ? [{ title: '离线回放来源', url: reading.url, content: reading.text }] : [];
      if (outcome === 'blocked_first' && reading === fixture.supplement) {
        results.unshift({ title: '无法读取的PDF', url: 'https://court.example/case.pdf', content: '摘要' });
      }
      return Response.json({ results });
    };
    const search = createFactSearchTools({ storage, purpose: 'research', fetch,
      configuration: fixture.recordedResearch ? configuration : () => ({
        parallelEnabled: false, tavilyEnabled: Boolean(fixture.firstSearchQuery),
        getTavilyKey: async () => 'fixture', authorizeQuery: async () => true,
      }) });
    const supplementSearch = createFactSearchTools({ storage, purpose: 'supplement', configuration, fetch });
    const reader: ToolDefinition<{ url: string }, JsonValue> = { name: 'read_fact_source', version: '1.0.0',
      description: 'Replay a fixed public source response.', effect: 'read_only', permissions: ['network:https:read'],
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
      execute({ url }, context) {
        sourceReads++;
        assert.ok(supplementSearch.isDiscoveredSource(url, context.runId));
        if (fixture.recordedSupplement) {
          const reading = fixture.recordedSupplement.readings.get(url);
          if (!reading) throw new ToolExecutionFault('OFFLINE_SOURCE_NOT_CAPTURED', '历史记录未保存这条网址的原文快照。');
          return { ...reading, requestedUrl: url };
        }
        if (url.endsWith('.pdf')) throw new ToolExecutionFault('WEB_CONTENT_TYPE_DENIED', '离线模拟 PDF 原文不可读');
        return { ...fixture.supplement, requestedUrl: url,
          bodyHash: outcome === 'reprint' ? fixture.firstReading.bodyHash : fixture.supplement.bodyHash };
      },
    };
    const workflow = createWritingWorkflowTools({ storage, projectId, mode: 'deep', requireEditorialPlan: true,
      supplementOutline: createOutlineSupplement(storage, projectId, supplementSearch, reader) });
    const collaboration = createWritingCollaboration({ storage, projectId, workflow, researchSearch: search, supplementSearch,
      systemPrompt: '使用已确认的作者方向。', directorMessage: '按顺序交接。', expertMessage: '按顺序交接。', materialIds,
      factSearchConfiguration: configuration,
      authorReviewDiscussion: fixture.authorReplies.map(content => ({ role: 'user', content })) });
    const tools = ToolRegistry.create([...workflow.definitions, ...collaboration.definitions]);
    class ReplayProvider extends ModelProviderBase {
      constructor() { super('offline-reading-handoff', '1.0.0', {
        protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown',
      }); }
      protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        const state = stateOf(request);
        if (state.stage === 'draft') {
          draftRequest = structuredClone(request);
          if (postDraft || fixture.savedDraft) {
            yield { type: 'text_delta', delta: postDraft?.body ?? fixture.savedDraft! };
            yield { type: 'completed', finishReason: 'stop' };
          } else stop.abort();
          return;
        }
        if (state.actor === 'director' && ((postDraft && state.nextStage ===
            (postDraft.stopAfterCentralRevision ? 'language_review' : 'fact_check')) ||
            (!postDraft && fixture.savedDraft && state.nextStage === 'review_editor'))) {
          stop.abort();
          return;
        }
        if (postDraft && ['review_editor', 'central_revision', 'language_review'].includes(state.stage)) {
          reviewRequests.push(structuredClone(request));
          yield { type: 'text_delta', delta: JSON.stringify(postDraft.answer(request, state.stage)) };
          yield { type: 'completed', finishReason: 'stop' };
          return;
        }
        if (state.actor === 'director') {
          yield* tool(request, 'director_decide', { action: 'dispatch', stage: state.nextStage, questions: [],
            reason: '继续作者已确认的方向。', readinessReason: '已有本阶段输入。' });
        } else if (state.stage === 'research') {
          if (fixture.recordedResearch?.queries.size && (!archivedQueriesSent ||
            (!followupQueriesSent && request.messages.some(message => message.role === 'tool' && message.content.includes('SEARCH_QUERY_TARGET_UNMET'))))) {
            const queries = archivedQueriesSent ? fixture.recordedResearch.followupQueries : [...fixture.recordedResearch.queries.keys()];
            if (archivedQueriesSent) followupQueriesSent = true;
            archivedQueriesSent = true;
            for (const [index, query] of queries.entries()) yield { type: 'tool_call_delta', index, id: `${request.requestId}:${index}`,
              name: 'search_research_sources', argumentsDelta: JSON.stringify({ query }) };
            yield { type: 'completed', finishReason: 'tool_calls' };
            return;
          }
          if (fixture.firstSearchQuery && outcome !== 'not_authorized') {
            if (!initialSearchDispatched) {
              initialSearchDispatched = true;
              assert.ok(request.tools?.some(definition => definition.name === 'search_research_sources'));
              yield* tool(request, 'search_research_sources', { query: fixture.firstSearchQuery });
              return;
            }
            assert.ok(request.tools?.some(definition => definition.name === 'search_research_sources'), 'supplement has its own budget');
          }
          const runId = storage.listRuns(projectId)[0]!.id;
          if (!readingsReplayed) for (const [index, reading] of (fixture.recordedResearch?.readings ?? [fixture.firstReading]).entries()) {
            const operationId = `recorded-reading-${index}`;
            const record = { projectId, runId, operationId };
            storage.recordRunEvent({ ...record, type: 'tool.requested', payload: { actor: 'research', toolName: 'read_fact_source',
              requestId: request.requestId, callId: operationId, arguments: { url: reading.url } } });
            storage.recordRunEvent({ ...record, type: 'tool.completed', payload: { requestId: request.requestId, callId: operationId,
              result: { ok: true, toolName: 'read_fact_source', operationId, callId: operationId, runId,
                result: { ...reading, requestedUrl: reading.url } } } });
          }
          readingsReplayed = true;
          yield* tool(request, 'submit_writing_stage', { stage: 'research', content: fixture.researchLedger });
        } else {
          assert.equal(state.stage, 'outline');
          outlineRequests++;
          const prewriting = structuredClone(fixture.assessment);
          const supplement = state.sourceReadings.find((item: ResearchReading) => item.url === fixture.supplement.url);
          const selected = fixture.recordedSupplement?.select?.(state.sourceReadings);
          if (selected?.length) {
            prewriting.readingRoute!.moments = [...prewriting.readingRoute!.moments, ...selected];
            delete prewriting.researchGap;
            delete prewriting.researchGaps;
          }
          if (supplement && !fixture.recordedResearch && !fixture.recordedSupplement && outcome !== 'irrelevant') prewriting.readingRoute!.moments = [...prewriting.readingRoute!.moments.slice(0, 5),
            { sourceUrl: supplement.url, quote: fixture.supplement.text, interest: '检验公开区间能否解释奖金。' }];
          yield { type: 'text_delta', delta: JSON.stringify({ content: fixture.outlineContent ?? '选材完成。', prewriting }) };
          yield { type: 'completed', finishReason: 'stop' };
        }
      }
    }
    const runtime = new AgentRuntime({ provider: new ReplayProvider(), tools, sessions: storage, requestPolicy: collaboration.requestPolicy });
    const handle = runtime.start({ projectId, purpose: 'writing-pack:draft', model: fixture.model ?? 'offline', systemPrompt: '回放', userMessage: '回放',
      parameters: fixture.parameters ?? {}, grantedPermissions: permissions, expectedBodyVersionId: null, signal: stop.signal });
    const result = await handle.result;
    assert.ok(draftRequest, JSON.stringify({ result, lastEvents: storage.listRunEvents(handle.runId).slice(-8) }));
    const latestBody = storage.inspectProject(projectId)!.latestBodyVersionId;
    const bodyVersions = storage.listArtifactVersions(projectId, 'body', 'main');
    const completedStages = workflow.progress(handle.runId).completedStages;
    if (postDraft) {
      assert.equal(bodyVersions[0]?.content, postDraft.body);
      assert.ok(completedStages.includes(postDraft.stopAfterCentralRevision ? 'central_revision' : 'language_review'),
        JSON.stringify({ result, lastEvents: storage.listRunEvents(handle.runId).slice(-8) }));
    } else if (fixture.savedDraft) {
      assert.equal(bodyVersions[0]?.content, fixture.savedDraft);
      assert.ok(completedStages.includes('draft'));
    } else assert.equal(latestBody, null);
    const recorded = storage.listRequestSnapshots(handle.runId).find(snapshot => snapshot.requestId === draftRequest!.requestId)!;
    assert.ok(recorded);
    return { draftRequest, recorded, publicQueries, sourceReads, outlineRequests, reviewRequests, bodyVersions, completedStages,
      runEvents: storage.listRunEvents(handle.runId),
      finalBody: latestBody ? storage.getArtifactVersion(latestBody)?.content : undefined };
  } finally {
    storage.close();
    rmSync(path, { recursive: true, force: true });
  }
}
