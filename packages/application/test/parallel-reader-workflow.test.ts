import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { ModelRequest, ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { ImmediateWorkflowProvider } from '../../client-bridge/test/helpers/workflow-provider.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import { WritingApplicationService } from '../src/index.js';
import { readerSimulationFixtureEvents } from './collaboration-fixture.js';
import { withCheckpointIntent, withIntentFixture } from './intent-fixture.js';

class ReadersProvider extends ImmediateWorkflowProvider {
  requests: ModelRequest[] = [];
  active = 0; peak = 0; aborted = 0;
  failed = false;
  readonly ready: Promise<void>;
  readonly gate: Promise<void>;
  release!: () => void;
  private markReady!: () => void;
  constructor(readonly failure: 'none' | 'c' | 'all' = 'none', readonly hold = false) {
    super('parallel-readers-test');
    this.ready = new Promise(resolve => { this.markReady = resolve; });
    this.gate = new Promise(resolve => { this.release = resolve; });
  }
  protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const reaction = readerSimulationFixtureEvents(request);
    if (!reaction) { yield* super.providerStream(request); return; }
    this.active++; this.peak = Math.max(this.peak, this.active);
    if (this.active === 3) { this.markReady(); if (!this.hold) this.release(); }
    let abort!: () => void;
    const cancelled = new Promise<void>(resolve => {
      abort = () => { this.aborted++; resolve(); };
      request.signal!.addEventListener('abort', abort, { once:true });
    });
    try {
      await Promise.race([this.gate, cancelled]);
      if (this.failure === 'all' || this.failure === 'c' && request.messages[0]!.content.startsWith('READER_SIMULATION_V1=c')) {
        this.failed = true;
        yield { type:'error', error:{ code:'NETWORK_ERROR', message:'test unavailable', retryable:true } };
      } else yield* reaction;
    } finally { request.signal!.removeEventListener('abort', abort); this.active--; }
  }
}

function setup(provider: ReadersProvider) {
  const path = mkdtempSync(join(tmpdir(), 'writing-parallel-workflow-'));
  const storage = openWorkspaceStorage({ workspacePath:path });
  const app = new WritingApplicationService({ storage, provider:withIntentFixture(provider) });
  const actor = { kind:'user', id:'u' } as const;
  app.createProject({ projectId:'p', operationId:'p', name:'并行读者', mode:'quick', actor });
  const saved = app.saveWritingBrief({ projectId:'p', operationId:'brief', expectedProjectRevision:storage.inspectProject('p')!.revision,
    baseVersionId:null, actor, brief:{ schemaVersion:1, topic:'安静', genre:'narrative_observation', audience:'普通上班族',
      lengthTarget:{targetCharacters:800}, materialIds:[], constraints:[], interactionMode:'co_creation',
      authorAuthorization:{voice:'克制', styleReference:null, styleDecision:'user_confirmed', directionDecision:'user_confirmed', firsthandMaterialIds:[]},
      platform:'微信公众号', publicationGoal:'not_applicable', confirmationStatus:'confirmed' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const p = storage.inspectProject('p')!;
  const input = { projectId:'p', expectedProjectRevision:p.revision, expectedBriefVersionId:p.currentBriefVersionId!, model:'mock', parameters:{},
    budget:{maxModelRequests:60, maxToolCalls:80, maxRetriesPerRequest:0, maxMajorRevisions:1} };
  const resume = (runId:string, id:string, service = app) => service.resumeDraft(withCheckpointIntent(storage, {
    ...input, expectedProjectRevision:storage.inspectProject('p')!.revision, runId, operationId:id, decision:'resume', userInstruction:'继续' }));
  return { storage, app, input, resume, close() { storage.close(); rmSync(path, {recursive:true, force:true}); } };
}
async function reachReader(f: ReturnType<typeof setup>) {
  const first = await f.app.runDraft(f.input);
  assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
  await f.resume(first.runId, 'approve-outline').result;
  await f.resume(first.runId, 'approve-draft').result;
  assert.equal(f.storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'review_editor');
  return { first, handle:f.resume(first.runId, 'approve-editor') };
}
const report = (f:ReturnType<typeof setup>, runId:string) => f.storage.listArtifactVersions('p', 'report', `workflow:${runId}:review_reader`);

for (const failure of ['none', 'c'] as const) it(`real workflow saves one isolated parallel reader stage and one checkpoint (failure=${failure})`, {timeout:15000}, async () => {
  const provider = new ReadersProvider(failure, true), f = setup(provider);
  try {
    const { first, handle } = await reachReader(f);
    await provider.ready;
    const activity = f.app.getLiveActivity('p', first.sessionId, first.runId)!;
    assert.equal(activity.actor, 'review_reader');
    assert.match(activity.workPreview!.text, /已完成 0 \/ 3/);
    assert.equal(f.app.getLiveReply('p', first.sessionId, first.runId), null, 'internal child JSON is not conversation prose');
    provider.release();
    const result = await handle.result;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'USER_CONFIRMATION_REQUIRED', JSON.stringify(result));
    assert.equal(provider.peak, 3);
    const children = provider.requests.filter(r => r.messages[0]?.content.startsWith('READER_SIMULATION_V1='));
    assert.equal(children.length, 3);
    const body = f.storage.getArtifactVersion(f.storage.inspectProject('p')!.latestBodyVersionId!)!;
    for (const request of children) {
      assert.equal(request.messages.length, 2); assert.equal(request.tools?.length ?? 0, 0);
      const data = JSON.parse(request.messages[1]!.content.slice('READER_ARTICLE='.length));
      assert.equal(data.article, body.content);
      assert.equal(data.bodyVersionId, body.id);
      assert.doesNotMatch(JSON.stringify(request.messages), /SECRET_OPINION|COLLABORATION_STATE|证据台账|结构清楚/);
      assert.match(request.messages[0]!.content, /微信公众号/);
    }
    const saved = report(f, first.runId);
    assert.equal(saved.length, 1);
    const marker = JSON.parse(saved[0]!.content);
    const artifact = f.storage.getArtifactVersion(marker.artifactVersionId)!;
    assert.match(artifact.content, /模拟读者 A.*模拟读者 B.*模拟读者 C/s);
    assert.equal(JSON.parse(artifact.content).runId, first.runId);
    assert.equal(JSON.parse(artifact.content).bodyVersionId, body.id);
    assert.doesNotMatch(artifact.content, /必须修改|可选优化|建议保留|2\/3|多数读者/);
    if (failure === 'c') assert.match(artifact.content, /未返回/);
    const waits = f.storage.listRunEvents(first.runId).filter(e => e.type === 'run.waiting_user' && e.payload.stage === 'review_reader');
    assert.equal(waits.length, 1);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(f.app.getLiveActivity('p', first.sessionId, first.runId), null);
    const restarted = new WritingApplicationService({storage:f.storage, provider:withIntentFixture(provider)});
    await f.resume(first.runId, 'approve-readers-after-restart', restarted).result;
    assert.equal(provider.requests.filter(r => r.messages[0]?.content.startsWith('READER_SIMULATION_V1=')).length, 3);
    assert.equal(report(f, first.runId).length, 1);
    const revision = f.storage.listRunEvents(first.runId).find(e => e.type === 'tool.completed' &&
      (e.payload.result as any)?.result?.collaboration?.stage === 'central_revision');
    assert.match((revision?.payload.result as any)?.result?.collaboration?.reason ?? '', /导演解读（非读者原话）/);
  } finally { provider.release(); f.close(); }
});

it('application stop propagates to all reader requests without a saved reaction or checkpoint', {timeout:15000}, async () => {
  const provider = new ReadersProvider('none', true), f = setup(provider);
  try {
    const {first, handle} = await reachReader(f); await provider.ready;
    f.app.cancelDraft({projectId:'p', runId:first.runId, operationId:'stop-readers'});
    await handle.result;
    assert.equal(provider.aborted, 3);
    assert.equal(report(f, first.runId).length, 0);
    assert.equal(f.storage.getRun(first.runId)?.status, 'cancelled');
    assert.equal(f.storage.listRunEvents(first.runId).filter(e=>e.type==='run.waiting_user' && e.payload.stage==='review_reader').length, 0);
  } finally { provider.release(); f.close(); }
});

it('a manual edit during reading cannot save a reader review bound to the obsolete body', {timeout:15000}, async () => {
  const provider = new ReadersProvider('none', true), f = setup(provider);
  try {
    const {first, handle} = await reachReader(f); await provider.ready;
    const p = f.storage.inspectProject('p')!;
    const saved = f.app.saveBody({projectId:'p', operationId:'manual', expectedProjectRevision:p.revision,
      baseBodyVersionId:p.latestBodyVersionId!, content:'# 新稿\n\n保留作者新版本。', reason:'manual', actor:{kind:'user', id:'u'} });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    provider.release();
    const result = await handle.result;
    assert.equal(result.ok, false);
    assert.equal(report(f, first.runId).length, 0);
    assert.equal(provider.requests.filter(r=>r.messages[0]?.content.startsWith('READER_SIMULATION_V1=')).length, 3, 'save rejection must not rerun all readers');
    assert.match(f.storage.getArtifactVersion(f.storage.inspectProject('p')!.latestBodyVersionId!)!.content, /保留作者新版本/);
  } finally { provider.release(); f.close(); }
});

it('all missing readers fail without an empty report; explicit retry resumes only the reader assignment', {timeout:15000}, async () => {
  const provider = new ReadersProvider('all'), f = setup(provider);
  try {
    const {first, handle} = await reachReader(f);
    const result = await handle.result;
    assert.equal(result.ok, false);
    assert.equal(f.storage.getRun(first.runId)?.stopReason, 'PARALLEL_TEXT_ALL_FAILED');
    assert.equal(report(f, first.runId).length, 0);
    const bridge = createApplicationBridge({service:f.app, workspaceId:'reader-retry', model:{model:'mock', parameters:{}, providerLabel:'test', credentialReference:null}});
    try {
      await bridge.selectSession('p', first.sessionId);
      assert.equal(bridge.getSnapshot().recoverableRuns.find(r=>r.runId===first.runId)?.stopReason, 'PARALLEL_TEXT_ALL_FAILED');
      assert.match(JSON.stringify(bridge.getSnapshot().timelineBySession[first.sessionId]), /三个模拟读者都未返回.*未自动重试/);
    } finally { bridge.dispose(); }
    const before = f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:review_editor`).map(a=>a.id);
    const retry = await f.app.resumeDraft({...f.input, expectedProjectRevision:f.storage.inspectProject('p')!.revision,
      runId:first.runId, operationId:'explicit-retry', decision:'resume'}).result;
    assert.equal(retry.ok, false);
    assert.equal(provider.requests.filter(r=>r.messages[0]?.content.startsWith('READER_SIMULATION_V1=')).length, 6);
    assert.deepEqual(f.storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:review_editor`).map(a=>a.id), before);
  } finally { f.close(); }
});
