/** Fresh fixture workspace; original incident DB is opened read-only for response replay. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const [source, port] = process.argv.slice(2);
const review = process.argv[4] === 'reviews';
const protectedRun = process.argv[4] === 'protected';
if (!source || !/^\d+$/.test(port ?? '')) throw new Error('Expected read-only source DB and fixture port');
const db = new DatabaseSync(source, { readOnly: true });
const response = db.prepare("SELECT payload_json FROM events WHERE type='request.completed' AND json_extract(payload_json,'$.requestId')=?").get(review ? 'c76f59d5-05cd-4115-9897-1d7dab2dca37' : 'b9fa9700-a357-44dd-a73a-a7e5217aa3b0');
const submitted = review
  ? db.prepare("SELECT payload_json FROM events WHERE type='tool.requested' AND json_extract(payload_json,'$.toolName')='submit_writing_stage' AND json_extract(payload_json,'$.arguments.stage')='review_editor' ORDER BY project_seq DESC LIMIT 1").get()
  : db.prepare("SELECT payload_json FROM events WHERE type='tool.requested' AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.toolName')='submit_writing_stage'").get('c801e26b-fb1c-4ae4-bf4f-55f1483e009d');
if (!response || !submitted) throw new Error('Incident replay responses not found');
const plain = JSON.parse(String(response.payload_json)).responseText;
const saved = JSON.parse(String(submitted.payload_json)).arguments.content;
db.close();
const id = `rc16-${randomUUID()}`;
const root = join(tmpdir(), `writing-agent-desktop-test-${id}`);
mkdirSync(join(root, 'user-data'), { recursive: true });
writeFileSync(join(root, 'replay.json'), JSON.stringify({ plain, saved }));
writeFileSync(join(root, 'user-data/provider.json'), JSON.stringify({ schemaVersion: 2, kind: 'anthropic_compatible', providerId: 'offline-fixture', baseURL: `http://127.0.0.1:${port}/v1`, credentialRef: 'env:WRITING_AGENT_RC16_FIXTURE_KEY', model: 'offline-expert-replay', tools: 'supported', usage: 'reported', allowInsecureHttp: true }));
class SeedProvider extends ModelProviderBase {
  constructor() { super('seed', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    if (state.actor === (review ? 'review_editor' : 'outline')) {
      if (protectedRun) { yield { type: 'text_delta', delta: '仍在整理' }; yield { type: 'completed', finishReason: 'stop' }; }
      else yield { type: 'error', error: { code: 'TIMEOUT', message: 'isolated replay checkpoint', retryable: true } };
      return;
    }
    const ready = state.ready || request.messages.some(m => m.role === 'tool' && m.name === 'assess_writing_readiness' && JSON.parse(m.content).ok);
    const readIds = request.messages.flatMap(m => m.role === 'tool' && m.name === 'read_artifact_version' ? [JSON.parse(m.content).result?.versionId] : []);
    const unread = state.actor === 'director' && !ready ? state.inputVersionIds.find((v: string) => !readIds.includes(v)) : undefined;
    if (unread) {
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'read_artifact_version', argumentsDelta: JSON.stringify({ versionId: unread }) };
      yield { type: 'completed', finishReason: 'tool_calls' }; return;
    }
    const name = state.actor !== 'director' ? 'submit_writing_stage' : ready ? 'director_decide' : 'assess_writing_readiness';
    const args = state.actor !== 'director' ? { stage: state.stage, content: state.stage === 'research' ? JSON.stringify({ claims: [], notes: '隔离回放：一般生活观察，不包含亲历事实' }) : '# 安静\n\n我喜欢安静，愿意停下来听一听。' }
      : ready ? { action: 'dispatch', stage: state.nextStage, reason: '生成节奏不均衡与接受主题的提纲，不写正文', questions: [] }
      : { status: 'ready', reason: '需求范围明确，不依赖亲历材料', questions: [] };
    if (state.actor !== 'director' && state.stage !== 'research') {
      yield { type: 'text_delta', delta: (args as { content: string }).content };
      yield { type: 'completed', finishReason: 'stop' }; return;
    }
    yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const storage = openWorkspaceStorage({ workspacePath: join(root, 'workspace') });
const app = new WritingApplicationService({ storage, provider: new SeedProvider() });
const actor = { kind: 'user', id: 'fixture' } as const;
app.createProject({ operationId: 'project', projectId: 'stream-fixture', name: '专家流式隔离验收', mode: review ? 'deep' : 'quick', actor });
const brief = app.saveWritingBrief({ operationId: 'brief', projectId: 'stream-fixture', expectedProjectRevision: storage.inspectProject('stream-fixture')!.revision, baseVersionId: null, actor,
  brief: { schemaVersion: 1, topic: '节奏不均衡中的接受与自洽', genre: 'narrative_observation', audience: '普通读者', lengthTarget: { targetCharacters: 1000 }, materialIds: [], constraints: [], interactionMode: 'co_creation', authorAuthorization: { voice: '克制观察', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
if (!brief.ok) throw new Error(JSON.stringify(brief));
const project = storage.inspectProject('stream-fixture')!;
const input = { projectId: project.id, expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, model: 'fixture', parameters: {}, budget: { maxModelRequests: protectedRun ? 12 : 30, maxToolCalls: 40, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } };
let result = await app.runDraft(input);
if (review) for (let i = 0; i < 2; i++) {
  result = await app.resumeDraft({ ...input, expectedProjectRevision: storage.inspectProject(project.id)!.revision, runId: result.runId, operationId: 'seed-resume-' + i, decision: 'resume', userInstruction: '继续' }).result;
}
if (result.ok) throw new Error('Expected isolated timeout checkpoint');
storage.close();
console.log(JSON.stringify({ id, root, projectId: project.id, sessionId: result.sessionId, runId: result.runId, plainLength: plain.length, savedLength: saved.length }));
