import type { WritingApplicationStorage } from './index.js';
import { getConversationIntakeState } from './conversation-intake.js';
import { isPublicationSelectionWait } from './publication-choice.js';
import { AUTHOR_CONVERSATION_PURPOSE } from './author-conversation.js';
import type { ArtifactVersion } from '../../writing-core/src/index.js';

export interface WorkflowHandoff {
  id: string; operationId: string; projectId: string; sessionId: string;
  action: 'full_writing' | 'resume_checkpoint' | 'fact_check' | 'continue_title';
  source: ArtifactVersion; userMessage: string; bodyVersionId: string | null;
  briefVersionId: string | null; checkpointRunId?: string; intentReceiptId?: string;
}

/** A local response artifact is durable even if the process died before finishing its run. */
export function isWorkflowHandoffSourceCommitted(storage: WritingApplicationStorage, source: ArtifactVersion): boolean {
  const persisted = storage.getArtifactVersion(source.id);
  if (!persisted || persisted.projectId !== source.projectId || persisted.contentHash !== source.contentHash) return false;
  if (persisted.actor.kind !== 'agent') return true;
  const run = storage.getRun(persisted.actor.runId);
  if (run?.status === 'completed') return true;
  if (run?.status !== 'interrupted' || run.stopReason !== 'PROCESS_INTERRUPTED') return false;
  return !storage.listRuntimeOperations(run.id).some(operation =>
    operation.effect === 'external_side_effect' && operation.state === 'unknown_outcome');
}

/** The saved user decision is the outbox. No gap between saving it and enqueueing a callback. */
export function pendingWorkflowHandoffs(storage: WritingApplicationStorage, projectId: string): WorkflowHandoff[] {
  const events = storage.listEvents(projectId);
  const runs = storage.listRuns(projectId);
  const startByRunId = new Map(events.filter(event => event.type === 'run.started' && event.runId)
    .map(event => [event.runId!, event] as const));
  const purposeByRunId = new Map([...startByRunId].map(([runId, event]) => [runId, event.payload.purpose]));
  const consumptionSeqsByOperationId = new Map<string, number[]>();
  for (const event of events.filter(event => ['run.started', 'run.resumed'].includes(event.type))) {
    const sequences = consumptionSeqsByOperationId.get(event.operationId) ?? [];
    sequences.push(event.projectSeq); consumptionSeqsByOperationId.set(event.operationId, sequences);
  }
  const titleWaitBySessionId = new Map<string, typeof runs[number]>();
  for (const run of runs) {
    if (run.status === 'waiting_user' &&
        isPublicationSelectionWait(storage.listRunEvents(run.id).findLast(event => event.type === 'run.waiting_user')?.payload)) {
      titleWaitBySessionId.set(run.sessionId, run);
    }
  }
  const bodies = storage.listArtifactVersions(projectId, 'body', 'main');
  const candidates: WorkflowHandoff[] = [];
  const add = (source: ArtifactVersion, fields: Omit<WorkflowHandoff, 'id' | 'operationId' | 'projectId' | 'source'>) => {
    const operationId = `workflow-handoff:${source.id}`;
    if (!isWorkflowHandoffSourceCommitted(storage, source) ||
        storage.listArtifactVersions(projectId, 'report', `handoff-failure:${source.id}`).length) return;
    candidates.push({ id: source.id, operationId, projectId, source, ...fields });
  };
  const intake = getConversationIntakeState(storage, projectId);
  const intakeSource = intake.stateArtifactVersionId ? storage.getArtifactVersion(intake.stateArtifactVersionId) : null;
  if (intake.phase === 'confirmed' && intake.sessionId && intakeSource) {
    const bodyAtConfirmation = bodies.findLast(body => body.createdEventSeq < intakeSource.createdEventSeq)?.id ?? null;
    add(intakeSource, { sessionId: intake.sessionId, action: 'full_writing', userMessage: intake.summary,
      bodyVersionId: bodyAtConfirmation, briefVersionId: intake.proposalVersionId });
  }
  for (const run of runs) {
    if (purposeByRunId.get(run.id) !== AUTHOR_CONVERSATION_PURPOSE) continue;
    const source = storage.listArtifactVersions(projectId, 'report', `author-turn:${run.id}`).at(-1);
    if (!source) continue;
    const data = JSON.parse(source.content);
    const intent = typeof data.intentReceiptId === 'string' ? storage.getArtifactVersion(data.intentReceiptId) : null;
    const receipt = intent ? JSON.parse(intent.content) : null;
    let action = data.requestedAction;
    const titleWait = titleWaitBySessionId.get(run.sessionId);
    if (!action && receipt?.intent === 'select_title' && titleWait) action = 'continue_title';
    if (!['full_writing', 'resume_checkpoint', 'fact_check', 'continue_title'].includes(action)) continue;
    add(source, { sessionId: run.sessionId, action, userMessage: receipt?.userMessage ?? data.task,
      bodyVersionId: data.bodyVersionId, briefVersionId: receipt?.briefVersionId ?? null,
      ...(action === 'resume_checkpoint' ? { checkpointRunId: data.checkpoint?.runId, intentReceiptId: data.intentReceiptId } : {}),
      ...(action === 'continue_title' ? { checkpointRunId: titleWait!.id } : {}) });
  }
  const claimedLegacyOperationIds = new Set<string>();
  return candidates.sort((a, b) => a.source.createdEventSeq - b.source.createdEventSeq).filter(handoff => {
    const consumedAfterSource = (operationId: string) =>
      consumptionSeqsByOperationId.get(operationId)?.some(sequence => sequence > handoff.source.createdEventSeq) === true;
    if (consumedAfterSource(handoff.operationId)) return false;
    const sourceStartOperationId = handoff.source.actor.kind === 'agent'
      ? startByRunId.get(handoff.source.actor.runId)?.operationId
      : handoff.source.operationId.endsWith(':state') ? handoff.source.operationId.slice(0, -':state'.length) : undefined;
    if (!sourceStartOperationId) return true;
    const suffixes = handoff.action === 'full_writing'
      ? [handoff.source.logicalKey === 'conversation-intake' ? ':writing' : ':full-writing']
      : handoff.action === 'fact_check' ? [':fact-check']
        : handoff.action === 'resume_checkpoint' ? [':checkpoint']
          : [':check-selected-title', ':continue-after-title'];
    const legacyOperationId = suffixes.map(suffix => `${sourceStartOperationId}${suffix}`)
      .find(operationId => consumedAfterSource(operationId) && !claimedLegacyOperationIds.has(operationId));
    if (!legacyOperationId) return true;
    claimedLegacyOperationIds.add(legacyOperationId);
    return false;
  });
}

export function recordHandoffFailure(storage: WritingApplicationStorage, handoff: WorkflowHandoff, code: string) {
  const saved = storage.commitArtifactVersion({ projectId: handoff.projectId, operationId: `${handoff.operationId}:failure`,
    expectedProjectRevision: storage.inspectProject(handoff.projectId)!.revision, kind: 'report',
    logicalKey: `handoff-failure:${handoff.id}`, baseVersionId: null,
    content: JSON.stringify({ sourceId: handoff.id, sessionId: handoff.sessionId, code }),
    reason: 'workflow-handoff-failed', actor: { kind: 'runtime', id: 'workflow-handoff' } });
  if (!saved.ok) throw new Error(saved.code);
}
