import { z } from 'zod';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import type { ArtifactVersion, DomainEvent, StoragePort } from '../../writing-core/src/index.js';

const quoteSchema = z.string().min(1).max(500);
const observationSchema = z.strictObject({
  before: quoteSchema,
  after: quoteSchema,
  why: z.string().min(1).max(500),
});
const comparisonSchema = z.strictObject({
  selectedVersionId: z.string().min(1),
  reason: z.string().min(1).max(1_000),
  gains: z.array(observationSchema).max(5),
  losses: z.array(observationSchema).max(5),
  retainedQuotes: z.array(quoteSchema).max(5),
});

const { $schema, ...schema } = z.toJSONSchema(comparisonSchema, { target: 'draft-07' });
export const JSON_SCHEMA = schema;

export const REVISION_COMPARISON_INSTRUCTIONS = [
  '比较绑定的初稿与集中修订稿，说明哪一版对当前读者更清楚、更具体，也更忠于作者的意思。优先保留真正有效的变化，避免为了改而改。',
  '在 comparison 提交选中的版本 ID、选择理由、收益 gains、损失 losses 和原样保留的引句 retainedQuotes。每条收益或损失的 before 与 after 必须分别是初稿与修订稿中不同的连续原文，why 说明这个变化对阅读的影响。如果两段引文在两稿都出现，扩大引文范围以体现实际变化。',
  '两稿有实际差异时至少列一条收益或损失。两稿相同时可将 gains 和 losses 留空，说明保留理由。retainedQuotes 的每条引句必须同时出现在选中稿和交付正文。',
  '只能选程序允许的版本。content 只提交从选中稿出发的完整文章正文，比较和选择理由只写在 comparison。',
].join('\n');

type RevisionComparison = z.infer<typeof comparisonSchema>;

interface BoundVersion {
  readonly id: string;
  readonly content: string;
}

function comparableContent(content: string): string {
  return content.replace(/\r\n/gu, '\n').trim();
}

export function parseRevisionComparison(
  value: unknown,
  binding: { readonly original: BoundVersion; readonly revised: BoundVersion; readonly allowOriginal: boolean },
  finalContent: string,
): RevisionComparison {
  const parsed = comparisonSchema.safeParse(value);
  if (!parsed.success) {
    throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Submit the complete revision comparison with bounded quotes and a selection reason.');
  }
  const comparison = parsed.data;
  const { original, revised, allowOriginal } = binding;
  const selected = comparison.selectedVersionId === revised.id ? revised
    : allowOriginal && comparison.selectedVersionId === original.id ? original : null;
  if (selected === null) {
    throw new ToolExecutionFault('REVISION_SELECTION_NOT_ALLOWED', 'Select an allowed version from the bound draft and revision.');
  }
  if (!comparison.reason.trim()) {
    throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Explain why the selected version should be used.');
  }
  const observations = [...comparison.gains, ...comparison.losses];
  const hasChanges = comparableContent(original.content) !== comparableContent(revised.content);
  if (!allowOriginal && hasChanges && comparableContent(finalContent) === comparableContent(original.content)) {
    throw new ToolExecutionFault('REVISION_SELECTION_NOT_ALLOWED', 'The final article cannot restore a draft that is ineligible for selection.');
  }
  if (hasChanges && observations.length === 0) {
    throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Different versions require at least one concrete gain or loss.');
  }
  if (!hasChanges && observations.length > 0) {
    throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Identical drafts cannot contain gains or losses.');
  }
  for (const { before, after, why } of observations) {
    const showsDifference = !revised.content.includes(before) || !original.content.includes(after);
    if (!before.trim() || !after.trim() || comparableContent(before) === comparableContent(after) || !why.trim() ||
        !original.content.includes(before) || !revised.content.includes(after) || !showsDifference) {
      throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Each gain or loss must explain a change using distinct verbatim passages from the draft and the revision, in that order.');
    }
  }
  for (const quote of comparison.retainedQuotes) {
    if (!quote.trim() || !selected.content.includes(quote) || !finalContent.includes(quote)) {
      throw new ToolExecutionFault('REVISION_COMPARISON_INVALID', 'Each retained quote must appear verbatim in both the selected version and the final article.');
    }
  }
  return comparison;
}

export interface RevisionComparisonView {
  readonly runId: string;
  readonly operationId: string;
  readonly markerEventSeq: number;
  readonly finalVersionId: string;
  readonly selected: 'original' | 'revised';
  readonly reason: string;
  readonly gains: readonly z.infer<typeof observationSchema>[];
  readonly losses: readonly z.infer<typeof observationSchema>[];
}

/** Expose comparison prose only after the same operation durably completed its stage. */
export function projectRevisionComparisons(
  storage: Pick<StoragePort, 'getArtifactVersion'>,
  projectId: string,
  events: readonly DomainEvent[],
  bodies: readonly ArtifactVersion[],
): RevisionComparisonView[] {
  const bodyById = new Map(bodies.map(body => [body.id, body]));
  const committed = events.filter(event => event.type === 'artifact.version_committed' &&
    event.projectId === projectId && event.payload.kind === 'report' && typeof event.payload.versionId === 'string');
  const markers = new Map(committed.filter(event => event.payload.reason === 'workflow-stage-complete:language_review')
    .map(event => [event.operationId, event]));
  return committed.flatMap(event => {
    if (event.payload.reason !== 'revision-comparison' || !event.operationId.endsWith(':comparison')) return [];
    const operationId = event.operationId.slice(0, -':comparison'.length);
    const markerEvent = markers.get(operationId + ':marker');
    const report = storage.getArtifactVersion(event.payload.versionId as string);
    const marker = markerEvent ? storage.getArtifactVersion(markerEvent.payload.versionId as string) : null;
    if (!report || !marker || report.projectId !== projectId || marker.projectId !== projectId ||
        report.kind !== 'report' || marker.kind !== 'report' || report.reason !== 'revision-comparison' ||
        marker.reason !== 'workflow-stage-complete:language_review' ||
        report.operationId !== event.operationId || marker.operationId !== markerEvent?.operationId ||
        report.createdEventSeq >= marker.createdEventSeq ||
        report.actor.kind !== 'agent' || report.actor.id !== 'writing-pack/writer' ||
        marker.actor.kind !== 'agent' || marker.actor.id !== report.actor.id || marker.actor.runId !== report.actor.runId) return [];
    const runId = report.actor.runId;
    if (report.logicalKey !== 'revision-comparison:' + runId || marker.logicalKey !== 'workflow:' + runId + ':language_review') return [];
    try {
      const saved = JSON.parse(report.content);
      const binding = JSON.parse(marker.content);
      if (saved.schemaVersion !== 'revision-comparison-v1' || saved.runId !== runId ||
          binding.schemaVersion !== 'writing-workflow-stage-v1' || binding.runId !== runId || binding.stage !== 'language_review' ||
          binding.artifactVersionId !== saved.finalVersionId || saved.audit?.requiresRevision === true) return [];
      const original = bodyById.get(saved.originalVersionId);
      const revised = bodyById.get(saved.revisedVersionId);
      const final = bodyById.get(saved.finalVersionId);
      if (!original || !revised || !final || final.createdEventSeq >= report.createdEventSeq) return [];
      const { reason, gains, losses, selectedVersionId } = parseRevisionComparison({
        reason: saved.reason, gains: saved.gains, losses: saved.losses,
        selectedVersionId: saved.selectedVersionId, retainedQuotes: saved.retainedQuotes,
      }, { original, revised, allowOriginal: true }, final.content);
      return [{ runId, operationId, markerEventSeq: marker.createdEventSeq, finalVersionId: final.id,
        selected: selectedVersionId === revised.id ? 'revised' as const : 'original' as const, reason, gains, losses }];
    } catch {
      return [];
    }
  });
}
