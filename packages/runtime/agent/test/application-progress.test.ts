import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { WritingApplicationService } from '../../../application/src/index.js';
import { openWorkspaceStorage } from '../../../storage/src/index.js';
import { contentHash } from '../../../writing-core/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../llm/src/index.js';
import { SecureWebFetcher } from '../../tools/src/index.js';
import { createApplicationBridge } from '../../../client-bridge/src/application-bridge.js';

it('bounds repeated material reads through the real collaboration policy after its initial catalog update', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-real-collaboration-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const requests: ModelRequest[] = [];
  let contentVersionId = '';
  class Provider extends ModelProviderBase {
    constructor() { super('real-collaboration', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'read_material',
        argumentsDelta: JSON.stringify({ materialId: 'material', contentVersionId, offset: 0, maxChars: 1000 }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const app = new WritingApplicationService({ storage, provider: new Provider() });
    const actor = { kind: 'user', id: 'test' } as const;
    app.createProject({ projectId: 'p', operationId: 'project', name: 'real context', mode: 'quick', actor });
    const imported = app.importMaterial({ projectId: 'p', operationId: 'material', expectedProjectRevision: storage.inspectProject('p')!.revision,
      materialId: 'material', displayName: '合成材料', sourceKind: 'pasted_text', sourceReference: 'synthetic', role: 'illustrative',
      trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: '安静观察'.repeat(2000), actor });
    assert.equal(imported.ok, true);
    contentVersionId = storage.listMaterials('p')[0]!.contentVersionId;
    const brief = app.saveWritingBrief({ projectId: 'p', operationId: 'brief', expectedProjectRevision: storage.inspectProject('p')!.revision,
      baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静', genre: 'narrative_observation', audience: '读者',
        lengthTarget: { targetCharacters: 800 }, materialIds: ['material'], constraints: [], interactionMode: 'autonomous',
        authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
        platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
    assert.equal(brief.ok, true);
    const project = storage.inspectProject('p')!;
    const result = await app.runDraft({ projectId: 'p', expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!,
      model: 'm', parameters: {}, budget: { maxModelRequests: 12, maxToolCalls: 12, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } });
    const states = requests.map(request => JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!.split('\n程序检测到')[0]!));
    t.diagnostic(JSON.stringify({ requests: requests.length, materialSlices: states.map(state => state.materials.length),
      stateHashes: states.map(state => contentHash(JSON.stringify(state))), historyLengths: requests.map(request => request.messages.length) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'TOOL_NO_PROGRESS');
    assert.ok(requests.length >= 3 && requests.length <= 4,
      'a receipt catalog update may refresh strict fallback once, but cannot keep the read loop alive');
    assert.equal(states[0].materials.length, 0);
    assert.ok(states.slice(1).every(state => state.materials.length === 1));
    assert.equal(new Set(states.slice(1).map(state => contentHash(JSON.stringify(state)))).size, 1);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const stopReason of ['TOOL_NO_PROGRESS', 'PROVIDER_RETRY_DEFERRED'] as const) {
  it(`resumes the real assigned outline after ${stopReason} without repeating research or dispatch`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-real-expert-resume-'));
    const storage = openWorkspaceStorage({ workspacePath: directory });
    const requests: ModelRequest[] = [];
    const actors: string[] = [];
    let contentVersionId = '';
    let recovering = false;
    class Provider extends ModelProviderBase {
      constructor() { super('real-resume', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
      protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests.push(structuredClone(request));
        const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!.split('\n程序检测到')[0]!);
        actors.push(state.actor);
        let name: string;
        let args: unknown;
        if (state.actor === 'director') {
          if (state.unreadArtifactVersionIds.length) { name = 'read_artifact_version'; args = { versionId: state.unreadArtifactVersionIds[0] }; }
          else if (recovering) { name = 'assess_writing_readiness'; args = { status: 'ready', reason: '恢复的提纲输入完整。', questions: [] }; }
          else { name = 'director_decide'; args = { action: 'dispatch', stage: state.nextStage, readinessReason: '合成个人观察材料充分。', reason: '根据当前授权材料完成此阶段。', questions: [] }; }
        } else if (state.actor === 'research') {
          name = 'submit_writing_stage'; args = { stage: 'research', content: { sources: [], claims: [], notes: '只有合成的个人感受，无外部事实。' } };
        } else if (state.actor === 'outline' && recovering) {
          yield { type: 'text_delta', delta: '# 安静\n\n- 开头：从眼前的安静场景进入。\n- 主体：展开个人观察与感受，不增加外部事实。\n- 结尾：回到开头的场景，保留安静的余韵。' };
          yield { type: 'completed', finishReason: 'stop' }; return;
        } else if (state.actor === 'outline' && stopReason === 'PROVIDER_RETRY_DEFERRED') {
          yield { type: 'error', error: { code: 'RATE_LIMITED', message: 'synthetic cooldown', retryable: true, retryAfterMs: 3_600_000 } }; return;
        } else { name = 'read_material'; args = { materialId: 'material', contentVersionId, offset: 0, maxChars: 1000 }; }
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
        yield { type: 'completed', finishReason: 'tool_calls' };
      }
    }
    const budget = { maxModelRequests: 24, maxToolCalls: 24, maxRetriesPerRequest: 1, maxMajorRevisions: 1 };
    const app = new WritingApplicationService({ storage, provider: new Provider() });
    let bridge: ReturnType<typeof createApplicationBridge> | undefined;
    try {
      const actor = { kind: 'user', id: 'test' } as const;
      app.createProject({ projectId: 'p', operationId: 'project', name: 'resume', mode: 'quick', actor });
      assert.equal(app.importMaterial({ projectId: 'p', operationId: 'material', expectedProjectRevision: storage.inspectProject('p')!.revision,
        materialId: 'material', displayName: '合成网页快照', sourceKind: 'web_snapshot', sourceReference: 'synthetic', role: 'illustrative',
        trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: '合成的个人观察场景。', actor }).ok, true);
      contentVersionId = storage.listMaterials('p')[0]!.contentVersionId;
      assert.equal(app.saveWritingBrief({ projectId: 'p', operationId: 'brief', expectedProjectRevision: storage.inspectProject('p')!.revision,
        baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '安静', genre: 'narrative_observation', audience: '读者',
          lengthTarget: { targetCharacters: 800 }, materialIds: ['material'], constraints: [], interactionMode: 'co_creation',
          authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
          platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } }).ok, true);
      const project = storage.inspectProject('p')!;
      const first = await app.runDraft({ projectId: 'p', expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, model: 'm', parameters: {}, budget });
      assert.equal(storage.getRun(first.runId)?.stopReason, stopReason);
      const researchIds = storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).map(version => version.id);
      assert.equal(researchIds.length, 1);
      const beforeResume = requests.length;
      recovering = true;
      bridge = createApplicationBridge({ service: app, workspaceId: 'real-resume', initialProjectId: 'p', initialSessionId: first.sessionId,
        model: { model: 'm', parameters: {}, providerLabel: 'synthetic', credentialReference: null, budget } });
      if (stopReason === 'PROVIDER_RETRY_DEFERRED') {
        const wait = storage.listRunEvents(first.runId).findLast(event => event.type === 'run.waiting_user')!;
        await bridge.resumeRun(first.runId, 'resume', { operationId: 'too-early' });
        await new Promise<void>(resolve => setImmediate(resolve)); // Allow the tracked paused handle to settle before a second UI command.
        assert.equal(requests.length, beforeResume, 'real application/bridge resume must obey the server cooldown');
        assert.equal(storage.getRun(first.runId)?.stopReason, stopReason);
        t.mock.method(Date, 'now', () => Number(wait.payload.retryNotBefore) + 1);
      }
      await bridge.resumeRun(first.runId, 'resume', { operationId: 'resume-current-expert' });
      const deadline = performance.now() + 5000;
      while (storage.getRun(first.runId)?.status === 'running') {
        if (performance.now() > deadline) throw new Error('resume did not settle');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const events = storage.listRunEvents(first.runId);
      const outlineAssignments = events.filter(event => event.type === 'tool.completed' &&
        (event.payload.result as { result?: { collaboration?: { actor?: string } } } | undefined)?.result?.collaboration?.actor === 'outline');
      assert.equal(outlineAssignments.length, 1);
      assert.deepEqual(storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:research`).map(version => version.id), researchIds);
      assert.ok(actors.slice(beforeResume).includes('outline'));
      assert.ok(!actors.slice(beforeResume).includes('research'));
      assert.equal(storage.getRun(first.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
      assert.equal(storage.listArtifactVersions('p', 'report', `workflow:${first.runId}:outline`).length, 1);
      assert.equal(events.findLast(event => event.type === 'run.resumed')?.payload.preservePendingAssignment, true);
      t.diagnostic(JSON.stringify({ stopReason, beforeResume, resumedActors: actors.slice(beforeResume), outlineAssignments: outlineAssignments.length,
        researchVersions: researchIds.length, finalStopReason: storage.getRun(first.runId)?.stopReason }));
    } finally { bridge?.dispose(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

it('bounds repeated source reads through the real fact policy despite new receipt IDs in its source catalog', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-real-fact-context-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const requests: ModelRequest[] = [];
  const url = 'https://8.8.8.8/synthetic-source';
  let fetches = 0;
  // Replace the network boundary only; the application policy, source cache,
  // durable receipts and fact-record catalog all run their real code.
  t.mock.method(SecureWebFetcher.prototype, 'fetchText', async () => {
    fetches++;
    return { finalUrl: url, redirectCount: 0, contentType: 'text/plain', bodyHash: 'synthetic',
      content: { text: '用于测试的来源原文。', trustLabel: 'external_untrusted', instructionAuthority: 'none', activeContentRemoved: false, truncated: false, totalChars: 11 } };
  });
  class Provider extends ModelProviderBase {
    constructor() { super('real-fact', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      const preparation = request.tools?.some(tool => tool.name === 'prepare_fact_check');
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: preparation ? 'prepare_fact_check' : 'read_fact_source',
        argumentsDelta: JSON.stringify(preparation ? { claims: [], noFactualClaimsReason: '合成的个人感受，无外部事实。' } : { url }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const actor = { kind: 'user', id: 'test' } as const;
    storage.createProject({ projectId: 'p', operationId: 'project', name: 'fact context', mode: 'quick', actor });
    for (const [kind, content] of [['body', '# 安静\n\n我喜欢安静。'], ['evidence', JSON.stringify({ claims: [], notes: `合成来源 ${url}` })]] as const) {
      assert.equal(storage.commitArtifactVersion({ projectId: 'p', operationId: kind, expectedProjectRevision: storage.inspectProject('p')!.revision,
        kind, logicalKey: 'main', baseVersionId: null, content, reason: 'synthetic fixture', actor }).ok, true);
    }
    const app = new WritingApplicationService({ storage, provider: new Provider(),
      factSearchConfiguration: () => ({ parallelEnabled: true, tavilyEnabled: false }) });
    const result = await app.runFactCheck({ projectId: 'p', expectedProjectRevision: storage.inspectProject('p')!.revision, model: 'm', parameters: {},
      budget: { maxModelRequests: 12, maxToolCalls: 12, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    const states = requests.map(request => JSON.parse(request.messages[1]!.content.split('\n程序检测到')[0]!));
    const resultHashes = storage.listRunEvents(result.runId).flatMap(event => {
      const envelope = event.payload.result as { toolName?: string; result?: unknown } | undefined;
      return event.type === 'tool.completed' && envelope?.toolName === 'read_fact_source'
        ? [contentHash(JSON.stringify(envelope.result))] : [];
    });
    t.diagnostic(JSON.stringify({ requests: requests.length, fetches, sourceCatalogSizes: states.map(state => state.savedSourceRecords?.length ?? null),
      historyLengths: requests.map(request => request.messages.length), distinctCachedResults: new Set(resultHashes.slice(1)).size }));
    assert.equal(new Set(resultHashes.slice(1)).size, 1, 'after the first cache-hit marker, subsequent successful source results are identical');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'TOOL_NO_PROGRESS');
    assert.ok(requests.length < 12, 'changing call IDs in receipt catalogs must not bypass the loop guard');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
