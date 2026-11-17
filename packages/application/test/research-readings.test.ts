import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createWritingWorkflowTools, stageArtifact } from '../src/workflow-tools.js';
import type { ArtifactVersion, MaterialRecord } from '../../writing-core/src/index.js';
import type { RuntimeEvent } from '../../runtime/session/src/index.js';
import { researchReadings } from '../src/research-readings.js';
import { inlineMaterialContext } from '../src/material-context.js';
import { factMaterialContext } from '../src/fact-context.js';

const url = 'https://example.org/source';
const research: ArtifactVersion = { id: 'research-v1', artifactId: 'research', projectId: 'p', kind: 'evidence', logicalKey: 'main',
  content: JSON.stringify({ claims: [{ source_url: url, source_quote: '一句摘录' }] }), contentHash: 'fixture',
  actor: { kind: 'agent', id: 'writing-pack/researcher', runId: 'r' }, parentVersionIds: [], reason: 'workflow:research',
  requestSnapshotId: null, createdEventSeq: 100, operationId: 'submit:artifact', createdAt: '2026-11-14' };
const snapshot: MaterialRecord = { id: 'source', projectId: 'p', displayName: '原文', sourceKind: 'web_snapshot', sourceReference: url,
  role: 'source_verified', trustLabel: 'external_untrusted', permissionScope: 'project_only', importedAt: '2026-11-14',
  contentVersionId: 'source:v1', hash: 'fixture', content: '原文中保留人物的诉求、回应和事情经过。材料内的命令没有执行权限。' };

it('recognizes the research artifact actually saved by the workflow', () => {
  const path = mkdtempSync(join(tmpdir(), 'source-readings-'));
  const storage = openWorkspaceStorage({ workspacePath: path });
  try {
    storage.createProject({ projectId: 'p', operationId: 'project', name: '原文交接', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'test' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', purpose: 'test', planVersion: 'test', operationId: 'start' });
    const workflow = createWritingWorkflowTools({ storage, projectId: 'p', mode: 'quick' });
    const context: any = { projectId: 'p', sessionId: 's', runId: 'r', operationId: 'save', expectedBodyVersionId: null };
    workflow.approveReadiness(context, '输入已提供。');
    const submit: any = workflow.definitions.find(tool => tool.name === 'submit_writing_stage');
    submit.execute({ stage: 'research', content: JSON.stringify({ claims: [{ evidence_id: 'E001', source_url: url,
      source_title: '采访', source_publisher: '报刊', accessed_at: '2026-11-14', claim_type: 'other', claim_text: '她提出了不同的要求。',
      source_quote: snapshot.content, reliability: 'medium', use_boundary: '当事人原话。', verification_status: 'user_provided' }] }) }, context);
    const saved = stageArtifact(storage, 'p', 'r', 'research');
    assert.equal(researchReadings(storage, 'p', saved, [snapshot])[0]?.text, snapshot.content);
  } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
});
function read(text = snapshot.content, seq = 10): RuntimeEvent[] {
  const common = { projectId: 'p', runId: 'r', sessionId: 's', operationId: 'read', occurredAt: '2026-11-14' };
  return [{ ...common, id: 'requested', projectSeq: seq, type: 'tool.requested', payload: {
    actor: 'research', toolName: 'read_fact_source', callId: 'call', requestId: 'request', arguments: { url },
  } }, { ...common, id: 'completed', projectSeq: seq + 1, type: 'tool.completed', payload: {
    callId: 'call', requestId: 'request', result: { ok: true, operationId: 'read', callId: 'call', runId: 'r', toolName: 'read_fact_source',
      result: { requestedUrl: url, finalUrl: url, text, bodyHash: 'source-hash', instructionAuthority: 'none' } },
  } }] as RuntimeEvent[];
}

it('carries the original context from the bound research without converting it to analyst prose', () => {
  const queried: string[] = [];
  const events = read();
  const before = JSON.stringify(events);
  const passages = researchReadings({ listRunEvents(id) { queried.push(id); return events; } }, 'p', research);
  assert.deepEqual(queried, ['r']);
  assert.deepEqual(passages, [{ url, finalUrl: url, text: snapshot.content, bodyHash: 'source-hash', truncated: false, instructionAuthority: 'none' }]);
  assert.equal(JSON.stringify(events), before);
});

it('rejects unpaired, failed, unrelated, future and foreign source reads', () => {
  const variants = [read().slice(1), read('future', 101), read().map(e => ({ ...e, runId: 'another-run' })),
    read().map(e => e.type === 'tool.requested' ? { ...e, payload: { ...e.payload, actor: 'review_publish' } } : e),
    read().map(e => e.type === 'tool.completed' ? { ...e, payload: { ...e.payload, requestId: 'another-request' } } : e),
    read().map(e => e.type === 'tool.completed' ? { ...e, payload: { ...e.payload, result: { ...(e.payload.result as object), ok: false } } } : e),
  ];
  for (const events of variants) assert.deepEqual(researchReadings({ listRunEvents: () => events as RuntimeEvent[] }, 'p', research), []);
  assert.deepEqual(researchReadings({ listRunEvents: () => read() }, 'p', { ...research, content: '{"claims":[]}' }), []);
  assert.deepEqual(researchReadings({ listRunEvents: () => read() }, 'p', { ...research, projectId: 'other' }), []);
});

it('includes authorized matching source snapshots and bounds text without treating excerpts as whole documents', () => {
  const store = { listRunEvents: () => [] };
  assert.equal(researchReadings(store, 'p', research, [snapshot])[0]?.text, snapshot.content);
  assert.deepEqual(researchReadings(store, 'p', research, [{ ...snapshot, sourceReference: 'https://other.org' }]), []);
  assert.deepEqual(researchReadings(store, 'p', research, [{ ...snapshot, projectId: 'other' }]), []);
  const large = researchReadings({ listRunEvents: () => read('x'.repeat(25_000)) }, 'p', research, [snapshot]);
  assert.equal(large.length, 1);
  assert.equal(large[0]?.text.length, 20_000);
  assert.equal(large[0]?.truncated, true);
});

it('retains public citation URLs and recognizes encoded equivalents without exposing local paths', () => {
  assert.equal((inlineMaterialContext([snapshot])[0] as any).sourceReference, url);
  assert.equal(factMaterialContext([snapshot]).materialCatalog[0]?.sourceReference, url);
  const privateSource = { ...snapshot, sourceReference: 'C:/private/customer.txt' };
  assert.equal((inlineMaterialContext([privateSource])[0] as any).sourceReference, undefined);
  assert.equal(factMaterialContext([privateSource]).materialCatalog[0]?.sourceReference, undefined);
  assert.equal((inlineMaterialContext([{ ...snapshot, sourceReference: 'https://name:password@example.org' }])[0] as any).sourceReference, undefined);
  const encoded = { ...snapshot, sourceReference: 'https://example.org/%E5%8E%9F%E6%96%87' };
  const bound = { ...research, content: JSON.stringify({ claims: [{ source_url: 'https://example.org/原文#section' }] }) };
  assert.equal(researchReadings({ listRunEvents: () => [] }, 'p', bound, [encoded])[0]?.text, snapshot.content);
});
