import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';
import { ModelProviderBase, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import {
  isWorkflowHandoffSourceCommitted,
  pendingWorkflowHandoffs,
} from '../src/workflow-handoff.js';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-handoff-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const actor = { kind: 'user', id: 'test' } as const;
  storage.createProject({ projectId: 'p', operationId: 'project', name: 'handoff', mode: 'quick', actor });
  const brief = storage.saveWritingBrief({ projectId: 'p', operationId: 'brief', expectedProjectRevision: storage.inspectProject('p')!.revision,
    baseVersionId: null, actor, brief: { schemaVersion: 1, topic: '测试', genre: 'narrative_observation', audience: '读者',
      lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: [], interactionMode: 'autonomous',
      authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } });
  assert.equal(brief.ok, true);
  storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'writing-pack:author-conversation' });
  return { storage, close() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

class NoRequestProvider extends ModelProviderBase {
  constructor() { super('no-request', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    throw new Error('A changed context must be explained before any model request');
  }
}

it('persists a visible handoff error after a body edit and preserves it across reopening', () => {
  const f = setup();
  try {
    saveAuthorHandoff(f.storage, 'confirmed', 'confirmed-op');
    const changed = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'manual-edit',
      expectedProjectRevision: f.storage.inspectProject('p')!.revision, kind: 'body', logicalKey: 'main',
      baseVersionId: null, content: '# 作者刚刚修改的正文', reason: 'manual-edit', actor: { kind: 'user', id: 'test' } });
    assert.equal(changed.ok, true);
    const service = new WritingApplicationService({ storage: f.storage, provider: new NoRequestProvider() });
    assert.deepEqual(service.continuePendingHandoffs({ model: 'mock', parameters: {} }), []);
    assert.equal(service.getHandoffError('p', 's')?.code, 'HANDOFF_CONTEXT_CHANGED');
    assert.equal(service.getHandoffError('p', 'other-session'), null);
    const reopened = new WritingApplicationService({ storage: f.storage, provider: new NoRequestProvider() });
    assert.deepEqual(reopened.getHandoffError('p', 's'), service.getHandoffError('p', 's'));
    assert.deepEqual(reopened.continuePendingHandoffs({ model: 'mock', parameters: {} }), []);
    assert.equal(f.storage.listRuns('p').length, 1);
    assert.equal(f.storage.listArtifactVersions('p', 'body', 'main').at(-1)?.content, '# 作者刚刚修改的正文');
    const bridge = createApplicationBridge({ service: reopened, model: { model: 'mock', parameters: {}, providerLabel: 'test', credentialReference: null }, workspaceId: 'test', initialProjectId: 'p' });
    try {
      assert.equal(bridge.getSnapshot().lastError?.code, 'CONVERSATION_HANDOFF_FAILED');
      assert.match(bridge.getSnapshot().lastError!.message, /确认后稿件或方向发生了变化/);
    } finally { bridge.dispose(); }
  } finally { f.close(); }
});

function saveAuthorHandoff(
  storage: ReturnType<typeof openWorkspaceStorage>,
  runId: string,
  operationId: string,
  action: 'full_writing' | 'fact_check' = 'full_writing',
  finish = true,
) {
  storage.startRun({ projectId: 'p', sessionId: 's', runId, planVersion: 'test', purpose: 'writing-pack:author-conversation', operationId });
  const saved = storage.commitArtifactVersion({ projectId: 'p', operationId: `${operationId}:response`,
    expectedProjectRevision: storage.inspectProject('p')!.revision, kind: 'report', logicalKey: `author-turn:${runId}`,
    baseVersionId: null, content: JSON.stringify({ requestedAction: action, task: action, bodyVersionId: storage.inspectProject('p')!.latestBodyVersionId,
      intentReceiptId: null }), reason: 'author-conversation', actor: { kind: 'agent', id: 'director', runId } });
  assert.equal(saved.ok, true);
  if (finish) storage.finishRun({ projectId: 'p', runId, operationId: `${operationId}:finish`, status: 'completed', stopReason: null });
  return storage.getArtifactVersion(saved.ok ? saved.result.versionId : '')!;
}

it('consumes only the source named by the new handoff operation id', () => {
  const f = setup();
  try {
    const first = saveAuthorHandoff(f.storage, 'author-1', 'author-op-1');
    const second = saveAuthorHandoff(f.storage, 'author-2', 'author-op-2');
    f.storage.startRun({ projectId: 'p', sessionId: 's', runId: 'workflow-1', planVersion: 'test', purpose: 'writing-pack:draft',
      operationId: `workflow-handoff:${first.id}` });
    assert.deepEqual(pendingWorkflowHandoffs(f.storage, 'p').map(item => item.id), [second.id]);
  } finally { f.close(); }
});

it('matches a legacy callback only to its exact source run operation and action suffix', () => {
  const f = setup();
  try {
    saveAuthorHandoff(f.storage, 'author-1', 'author-op-1');
    const second = saveAuthorHandoff(f.storage, 'author-2', 'author-op-2');
    f.storage.startRun({ projectId: 'p', sessionId: 's', runId: 'legacy-workflow', planVersion: 'test', purpose: 'writing-pack:draft',
      operationId: 'author-op-1:full-writing' });
    assert.deepEqual(pendingWorkflowHandoffs(f.storage, 'p').map(item => item.id), [second.id]);
  } finally { f.close(); }
});

it('does not let an older legacy-looking event consume a newer source', () => {
  const f = setup();
  try {
    f.storage.startRun({ projectId: 'p', sessionId: 's', runId: 'older-workflow', planVersion: 'test', purpose: 'writing-pack:draft',
      operationId: 'author-op:full-writing' });
    const source = saveAuthorHandoff(f.storage, 'author', 'author-op');
    assert.deepEqual(pendingWorkflowHandoffs(f.storage, 'p').map(item => item.id), [source.id]);
  } finally { f.close(); }
});

it('recognizes the legacy intake writing suffix from its source run operation', () => {
  const f = setup();
  try {
    f.storage.startRun({ projectId: 'p', sessionId: 's', runId: 'intake-run', planVersion: 'test', purpose: 'writing-pack:conversation-intake',
      operationId: 'intake-op' });
    const briefVersionId = f.storage.inspectProject('p')!.currentBriefVersionId!;
    const state = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'intake-op:response', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'report', logicalKey: 'conversation-intake', baseVersionId: null, reason: 'conversation-intake-response', actor: { kind: 'agent', id: 'intake', runId: 'intake-run' },
      content: JSON.stringify({ schemaVersion: 'conversation-intake-v1', phase: 'confirmed', summary: '### 写作方向\n已确认', reply: '已确认', questions: [],
        proposalVersionId: briefVersionId, invalidatedProposalVersionId: null, pendingAuthorization: null, sourceTurns: [], sessionId: 's' }) });
    assert.equal(state.ok, true);
    f.storage.finishRun({ projectId: 'p', runId: 'intake-run', operationId: 'intake-op:finish', status: 'completed', stopReason: null });
    f.storage.startRun({ projectId: 'p', sessionId: 's', runId: 'legacy-writing', planVersion: 'test', purpose: 'writing-pack:draft',
      operationId: 'intake-op:writing' });
    assert.deepEqual(pendingWorkflowHandoffs(f.storage, 'p'), []);
  } finally { f.close(); }
});

it('binds an intake confirmation to the last body that existed when its source was committed', () => {
  const f = setup();
  try {
    const before = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'body-before', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 确认时正文', reason: 'test', actor: { kind: 'user', id: 'test' } });
    assert.equal(before.ok, true);
    const briefVersionId = f.storage.inspectProject('p')!.currentBriefVersionId!;
    const state = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'confirm:state', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'report', logicalKey: 'conversation-intake', baseVersionId: null, reason: 'conversation-intake-confirmed', actor: { kind: 'user', id: 'test' },
      content: JSON.stringify({ schemaVersion: 'conversation-intake-v1', phase: 'confirmed', summary: '### 写作方向\n已确认', reply: '已确认', questions: [],
        proposalVersionId: briefVersionId, invalidatedProposalVersionId: null, pendingAuthorization: null, sourceTurns: [], sessionId: 's' }) });
    assert.equal(state.ok, true);
    const after = f.storage.commitArtifactVersion({ projectId: 'p', operationId: 'body-after', expectedProjectRevision: f.storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: before.ok ? before.result.versionId : null, content: '# 确认后正文', reason: 'test', actor: { kind: 'user', id: 'test' } });
    assert.equal(after.ok, true);
    const handoff = pendingWorkflowHandoffs(f.storage, 'p').find(item => item.id === (state.ok ? state.result.versionId : ''))!;
    assert.equal(handoff.bodyVersionId, before.ok ? before.result.versionId : null);
  } finally { f.close(); }
});

it('accepts completed or safely interrupted local sources but rejects unknown external outcomes', () => {
  const f = setup();
  try {
    const completed = saveAuthorHandoff(f.storage, 'completed', 'completed-op');
    const interrupted = saveAuthorHandoff(f.storage, 'interrupted', 'interrupted-op', 'full_writing', false);
    const unknown = saveAuthorHandoff(f.storage, 'unknown', 'unknown-op', 'full_writing', false);
    f.storage.prepareRuntimeOperation({ operationId: 'external-op', projectId: 'p', runId: 'unknown', kind: 'tool_call', effect: 'external_side_effect', input: {} });
    f.storage.dispatchRuntimeOperation({ operationId: 'external-op', projectId: 'p', runId: 'unknown', eventType: 'tool.requested', eventPayload: {}, budgetUse: { toolCalls: 1 } });
    f.storage.recoverProjectRuns('p');
    assert.equal(isWorkflowHandoffSourceCommitted(f.storage, completed), true);
    assert.equal(f.storage.getRun('interrupted')?.stopReason, 'PROCESS_INTERRUPTED');
    assert.equal(isWorkflowHandoffSourceCommitted(f.storage, interrupted), true);
    assert.equal(f.storage.getRun('unknown')?.stopReason, 'UNKNOWN_EXTERNAL_OUTCOME');
    assert.equal(isWorkflowHandoffSourceCommitted(f.storage, unknown), false);
  } finally { f.close(); }
});
