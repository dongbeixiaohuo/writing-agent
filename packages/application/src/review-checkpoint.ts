import type { WritingApplicationStorage } from './index.js';

export const reviewStages = ['review_editor', 'review_publish', 'review_reader'] as const;
export type ReviewStage = typeof reviewStages[number];
export function isReviewStage(stage: unknown): stage is ReviewStage {
  return reviewStages.some(value => value === stage);
}

/** Whole-message acknowledgement only. Mixed acceptance/objections stay a discussion. */
export function isReviewConfirmation(message: string): boolean {
  const text = message.trim().replace(/[\s，,。.!！]/gu, '');
  return /^(?:(?:好的?|可以|行|对的?|是的?|没问题|同意|认可|确认|接受|ok(?:ay)?)(?:了)?|继续(?:吧|下一步|下一位(?:专家)?)?|认可当前阶段继续下一步|(?:这些|本轮|当前)?(?:审校)?(?:意见|建议)(?:我)?(?:都)?(?:认可|同意|接受|确认)|(?:就)?按(?:这些|这个|当前)?建议(?:改|修改|修订)|都不动就这样)(?:请?继续(?:吧|下一步|下一位(?:专家)?)?)?$/iu.test(text);
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
