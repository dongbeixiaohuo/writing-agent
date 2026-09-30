import type { WritingApplicationStorage } from './index.js';

export const reviewStages = ['review_editor', 'review_publish', 'review_reader'] as const;
export type ReviewStage = typeof reviewStages[number];
export function isReviewStage(stage: unknown): stage is ReviewStage {
  return reviewStages.some(value => value === stage);
}

export function pendingReviewCheckpoint(storage: WritingApplicationStorage, projectId: string, sessionId?: string) {
  const run = storage.listRuns(projectId, sessionId).findLast(run => run.status === 'waiting_user' && run.stopReason === 'CO_CREATION_CHECKPOINT');
  if (!run) return null;
  const wait = storage.listRunEvents(run.id).filter(event => event.type === 'run.waiting_user').at(-1);
  const stage = wait?.payload.stage;
  if (!isReviewStage(stage)) return null;
  const artifact = storage.listArtifactVersions(projectId, 'review', `${stage}:${run.id}`).at(-1);
  return { runId: run.id, stage, artifact, eventSeq: wait!.projectSeq };
}
