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
  let operationId = input.operationId;
  let sourceRunId = `checkpoint-approval:${operationId}`;
  let previous = storage.getRun(sourceRunId);
  const matchesApproval = (id: string) => {
    const receipt = storage.listArtifactVersions(input.projectId, 'report', `author-intent:${id}`).at(-1);
    const data = receipt && JSON.parse(receipt.content);
    return data?.intent === 'approve_checkpoint' && data.decisionSource === 'explicit_checkpoint_button' &&
      data.checkpoint?.runId === input.runId && data.checkpoint.eventSeq === input.approval.eventSeq &&
      data.bodyVersionId === input.approval.bodyVersionId && data.briefVersionId === input.approval.briefVersionId;
  };
  const previousReceipt = previous && storage.listArtifactVersions(input.projectId, 'report', `author-intent:${sourceRunId}`).at(-1);
  if (previous && (previous.projectId !== input.projectId || (previousReceipt && !matchesApproval(sourceRunId)))) {
    throw new ToolExecutionFault('IDEMPOTENCY_CONFLICT', 'Confirmation operation was used for a different checkpoint');
  }
  if (previous?.status === 'completed') {
    if (matchesApproval(sourceRunId)) return;
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
  // Operation IDs identify clicks, not decisions. Reuse the durable decision
  // for the exact checkpoint and versions, including after a process restart.
  // Validate the current context first so an old card cannot approve a new wait.
  const matching = storage.listRuns(project.id, run.sessionId).find(candidate =>
    candidate.id.startsWith('checkpoint-approval:') && matchesApproval(candidate.id));
  if (matching) {
    if (matching.status === 'completed') return;
    sourceRunId = matching.id;
    previous = matching;
    operationId = sourceRunId.slice('checkpoint-approval:'.length);
  }
  if (storage.listRuns(project.id).some(r => ['running', 'queued', 'paused'].includes(r.status) && r.id !== sourceRunId)) {
    throw new ToolExecutionFault('RUN_ALREADY_ACTIVE', '请等待当前运行完成后确认。');
  }
  const userMessage = '认可当前阶段，继续下一步';
  if (!previous) storage.startRun({ projectId: project.id, sessionId: run.sessionId, runId: sourceRunId,
    operationId, purpose: 'writing-pack:author-conversation',
    planVersion: 'explicit-checkpoint-approval-v1', displayInstruction: userMessage });
  else if (previous.status === 'interrupted') storage.resumeRun({ projectId: project.id, runId: sourceRunId,
    operationId: `${input.operationId}:recover`, decision: 'resume' });
  const intent = createConversationIntent({ storage, projectId: project.id, sessionId: run.sessionId, userMessage,
    allowedIntents: ['approve_checkpoint'], context: {}, decisionSource: 'explicit_checkpoint_button' });
  const receipt = storage.listArtifactVersions(project.id, 'report', `author-intent:${sourceRunId}`).at(-1);
  // This local receipt writer is synchronous. Keep receipt, outbox and finish
  // in one JS turn; yielding here lets concurrent clicks interleave the writes.
  if (!receipt) intent.record({ intent: 'approve_checkpoint', reason: '作者点击了当前成果的认可并继续按钮。' }, {
    projectId: project.id, runId: sourceRunId, operationId: `${operationId}:receipt`,
    abortSignal: new AbortController().signal, expectedBodyVersionId: project.latestBodyVersionId,
    permissionGrant: createToolPermissionGrant({ projectId: project.id, runId: sourceRunId, permissions: ['author:intent'] }),
  });
  const intentReceiptId = receipt?.id ?? intent.result()!.artifactVersionId;
  const reply = '已确认当前阶段，将从已保存的位置继续。';
  const outbox = storage.listArtifactVersions(project.id, 'report', `author-turn:${sourceRunId}`).at(-1);
  const saved = outbox ? null : storage.commitArtifactVersion({ projectId: project.id, operationId: `${operationId}:handoff`,
    expectedProjectRevision: storage.inspectProject(project.id)!.revision, kind: 'report',
    logicalKey: `author-turn:${sourceRunId}`, baseVersionId: null,
    content: JSON.stringify({ reply, role: 'director', task: userMessage, requestedAction: 'resume_checkpoint',
      intentReceiptId, checkpoint, proposalIds: [], bodyVersionId: project.latestBodyVersionId }),
    reason: 'author-conversation', actor: { kind: 'agent', id: 'explicit-checkpoint-approval', runId: sourceRunId } });
  if (saved && !saved.ok) throw new ToolExecutionFault(saved.code, saved.message);
  storage.finishRun({ projectId: project.id, runId: sourceRunId, operationId: `${operationId}:complete`,
    status: 'completed', stopReason: null, payload: { content: reply, artifactVersionId: outbox?.id ?? (saved && saved.ok ? saved.result.versionId : null) } });
}
