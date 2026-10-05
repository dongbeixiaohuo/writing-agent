import type { WritingApplicationStorage } from './index.js';
import { createConversationIntent, pendingCheckpoint } from './conversation-intent.js';
import { ToolExecutionFault, createToolPermissionGrant } from '../../runtime/tools/src/index.js';

export interface CheckpointApproval {
  eventSeq: number;
  bodyVersionId: string | null;
  briefVersionId: string | null;
}

/** A labelled UI action is already a decision, not text requiring NLP. Save it
 * through the same durable receipt/outbox used by conversation handoffs. */
export async function approveStageCheckpoint(storage: WritingApplicationStorage, input: {
  projectId: string; runId: string; operationId: string; approval: CheckpointApproval;
}): Promise<void> {
  const sourceRunId = `checkpoint-approval:${input.operationId}`;
  const previous = storage.getRun(sourceRunId);
  if (previous?.status === 'completed') {
    const receipt = storage.listArtifactVersions(input.projectId, 'report', `author-intent:${sourceRunId}`).at(-1);
    const data = receipt && JSON.parse(receipt.content);
    if (data?.checkpoint?.runId === input.runId && data.checkpoint.eventSeq === input.approval.eventSeq &&
      data.bodyVersionId === input.approval.bodyVersionId && data.briefVersionId === input.approval.briefVersionId) return;
    throw new ToolExecutionFault('IDEMPOTENCY_CONFLICT', 'Confirmation operation was used for a different checkpoint');
  }
  const run = storage.getRun(input.runId);
  const project = storage.inspectProject(input.projectId);
  const checkpoint = run && pendingCheckpoint(storage, input.projectId, run.sessionId);
  if (!project || !run || run.projectId !== input.projectId || checkpoint?.runId !== run.id ||
    checkpoint.eventSeq !== input.approval.eventSeq || project.latestBodyVersionId !== input.approval.bodyVersionId ||
    project.currentBriefVersionId !== input.approval.briefVersionId) {
    throw new ToolExecutionFault('INTENT_CONTEXT_STALE', '稿件或待确认阶段已变化，请查看当前结果后重新确认。');
  }
  if (storage.listRuns(project.id).some(r => ['running', 'queued', 'paused'].includes(r.status) && r.id !== sourceRunId)) {
    throw new ToolExecutionFault('RUN_ALREADY_ACTIVE', '请等待当前运行完成后确认。');
  }
  const userMessage = '认可当前阶段，继续下一步';
  if (!previous) storage.startRun({ projectId: project.id, sessionId: run.sessionId, runId: sourceRunId,
    operationId: input.operationId, purpose: 'writing-pack:author-conversation',
    planVersion: 'explicit-checkpoint-approval-v1', displayInstruction: userMessage });
  else if (previous.status === 'interrupted') storage.resumeRun({ projectId: project.id, runId: sourceRunId,
    operationId: `${input.operationId}:recover`, decision: 'resume' });
  const intent = createConversationIntent({ storage, projectId: project.id, sessionId: run.sessionId, userMessage,
    allowedIntents: ['approve_checkpoint'], context: {}, decisionSource: 'explicit_checkpoint_button' });
  const receipt = storage.listArtifactVersions(project.id, 'report', `author-intent:${sourceRunId}`).at(-1);
  if (!receipt) await intent.definition.execute({ intent: 'approve_checkpoint', reason: '作者点击了当前成果的认可并继续按钮。' }, {
    projectId: project.id, runId: sourceRunId, operationId: `${input.operationId}:receipt`,
    abortSignal: new AbortController().signal, expectedBodyVersionId: project.latestBodyVersionId,
    permissionGrant: createToolPermissionGrant({ projectId: project.id, runId: sourceRunId, permissions: ['author:intent'] }),
  });
  const intentReceiptId = receipt?.id ?? intent.result()!.artifactVersionId;
  const reply = '已确认当前阶段，将从已保存的位置继续。';
  const saved = storage.commitArtifactVersion({ projectId: project.id, operationId: `${input.operationId}:handoff`,
    expectedProjectRevision: storage.inspectProject(project.id)!.revision, kind: 'report',
    logicalKey: `author-turn:${sourceRunId}`, baseVersionId: null,
    content: JSON.stringify({ reply, role: 'director', task: userMessage, requestedAction: 'resume_checkpoint',
      intentReceiptId, checkpoint, proposalIds: [], bodyVersionId: project.latestBodyVersionId }),
    reason: 'author-conversation', actor: { kind: 'agent', id: 'explicit-checkpoint-approval', runId: sourceRunId } });
  if (!saved.ok) throw new ToolExecutionFault(saved.code, saved.message);
  storage.finishRun({ projectId: project.id, runId: sourceRunId, operationId: `${input.operationId}:complete`,
    status: 'completed', stopReason: null, payload: { content: reply, artifactVersionId: saved.result.versionId } });
}
