import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ArtifactVersion, MaterialRecord } from '../../writing-core/src/index.js';
import type { RuntimeEvent } from '../../runtime/session/src/index.js';
import { publicationReviewSourceSlices } from '../src/publication-review-context.js';

const runId = 'source-run';
const reviewContent = '实验只比较特定场景下的采信判断。';
const bodyVersionId = 'reviewed-draft';
const sourceText = 'Participants judged whether to accept the employees’ self-reported hours.';

function material(id: string, version = `${id}:v1`, content = `🔍 ${sourceText}\nOther context.`): MaterialRecord {
  return { id, projectId: 'p', displayName: `Source ${id}`, sourceKind: 'web_snapshot', sourceReference: `https://example.test/${id}`,
    role: 'source_verified', trustLabel: 'external_untrusted', permissionScope: 'project_only', importedAt: '2026-11-13', contentVersionId: version, hash: 'fixture', content };
}

function event(projectSeq: number, type: string, operationId: string, payload: RuntimeEvent['payload']): RuntimeEvent {
  return { projectId: 'p', runId, id: `event:${projectSeq}`, projectSeq, type, operationId, payload, occurredAt: '2026-11-13' };
}

function completed(projectSeq: number, operationId: string, toolName: string, result: object): RuntimeEvent {
  return event(projectSeq, 'tool.completed', operationId, { requestId: `${operationId}:request`, callId: `${operationId}:call`,
    result: { ok: true, operationId, callId: `${operationId}:call`, runId, toolName, result } });
}

function dispatch(projectSeq: number, draft = bodyVersionId): RuntimeEvent {
  const operationId = `dispatch:${projectSeq}`;
  return completed(projectSeq, operationId, 'director_decide', { collaboration: { actor: 'review_publish', stage: 'review_publish',
    status: 'dispatched', decisionId: operationId, inputVersionIds: [draft, 'evidence'], expectedBodyVersionId: draft } });
}

function read(projectSeq: number, item: MaterialRecord, actor = 'review_publish', offset = 2, maxChars = sourceText.length): [RuntimeEvent, RuntimeEvent] {
  const operationId = `read:${projectSeq}`;
  const characters = Array.from(item.content);
  const nextOffset = Math.min(offset + maxChars, characters.length);
  return [event(projectSeq, 'tool.requested', operationId, { actor, toolName: 'read_material', requestId: `${operationId}:request`,
    callId: `${operationId}:call`, arguments: { materialId: item.id, contentVersionId: item.contentVersionId, offset, maxChars } }),
    completed(projectSeq + 1, operationId, 'read_material', { materialId: item.id, contentVersionId: item.contentVersionId, offset,
      nextOffset, totalChars: characters.length, content: characters.slice(offset, nextOffset).join(''), instructionAuthority: 'none', editorialPlan: 'never forward' })];
}

const submit = event(90, 'tool.requested', 'submit', { actor: 'review_publish', toolName: 'submit_writing_stage',
  arguments: { stage: 'review_publish', content: reviewContent, findings: [] } });
const envelope = { schemaVersion: 'writing-review-v1', reviewType: 'review_publish', runId, bodyVersionId, content: reviewContent };
const review: ArtifactVersion = { id: 'carried-review', artifactId: 'review-artifact', projectId: 'p', kind: 'review', logicalKey: `review_publish:${runId}`,
  content: JSON.stringify({ ...envelope, findings: [] }), contentHash: 'fixture', actor: { kind: 'agent', id: 'writing-pack/review_publish', runId },
  parentVersionIds: [], reason: 'workflow:review_publish', requestSnapshotId: null, createdEventSeq: 100, operationId: 'submit:artifact', createdAt: '2026-11-13' };

it('replays exact source passages from the carried review owner and rejects other actors, versions and assignments', () => {
  const source = material('study');
  const stale = material('stale');
  const denied = material('denied');
  const malformed = read(60, source, 'review_publish', 0, 3);
  const events = [dispatch(1), ...read(3, source, 'review_publish', 0, 2), dispatch(10), ...read(12, source, 'research', 0, 1),
    ...read(20, stale), ...read(30, denied), ...read(40, source), ...read(50, source), malformed[0],
    { ...malformed[1], payload: { ...malformed[1].payload, requestId: 'unpaired-request' } },
    submit, ...read(93, source, 'review_publish', 0, 2)];
  const queriedRuns: string[] = [];
  const storage = { listRunEvents(id: string) { queriedRuns.push(id); return id === runId ? events : []; } };
  const slices = publicationReviewSourceSlices(storage, 'p', review, [source, material('stale', 'stale:v2'), { ...denied, projectId: 'another-project' }]);
  assert.deepEqual(queriedRuns, [runId]);
  assert.deepEqual(slices, [{ materialId: source.id, contentVersionId: source.contentVersionId, displayName: source.displayName,
    sourceReference: source.sourceReference, offset: 2, nextOffset: sourceText.length + 2, totalChars: Array.from(source.content).length,
    content: sourceText, instructionAuthority: 'none' }]);
});

it('requires a structured review and an exact saved submission and dispatch', () => {
  const source = material('study');
  const reader = (events: RuntimeEvent[]) => ({ listRunEvents: () => events });
  const events = [dispatch(1), ...read(20, source), submit];
  assert.deepEqual(publicationReviewSourceSlices(reader(events), 'p', { ...review, content: JSON.stringify(envelope) }, [source]), []);
  assert.deepEqual(publicationReviewSourceSlices(reader(events.slice(0, -1)), 'p', review, [source]), []);
  assert.deepEqual(publicationReviewSourceSlices(reader([dispatch(1, 'another-draft'), ...events.slice(1)]), 'p', review, [source]), []);
});

it('retains whole slices within the bounded terminal context', () => {
  const source = material('long', 'long:v1', 'x'.repeat(25_000));
  const events = [dispatch(1), ...read(10, source, 'review_publish', 0, 13_000), ...read(20, source, 'review_publish', 13_000, 12_000), submit];
  const slices = publicationReviewSourceSlices({ listRunEvents: () => events }, 'p', review, [source]);
  assert.deepEqual(slices.map(slice => [slice.offset, slice.nextOffset, slice.content.length]), [[13_000, 25_000, 12_000]]);
});
