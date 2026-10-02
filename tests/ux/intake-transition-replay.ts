// Reads incident records only; uses the normal desktop bridge in an isolated workspace.
// WA_DIAG_DB=... node --import tsx tests/ux/intake-transition-replay.ts <project-id>
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelProvider, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';

assert.ok(process.env.WA_DIAG_DB && process.argv[2]);
const db = new DatabaseSync(process.env.WA_DIAG_DB, { readOnly: true });
const history: { message: string; args: Record<string, unknown> }[] = [];
let current = ''; let expectedModel = ''; let expectedProvider = '';
try {
  for (const row of db.prepare('SELECT type,payload_json FROM events WHERE project_id=? ORDER BY project_seq').all(process.argv[2])) {
    const p = JSON.parse(String(row.payload_json));
    if (row.type === 'run.started') current = p.displayInstruction;
    if (row.type === 'request.prepared') { expectedModel = p.model; expectedProvider = p.provider; }
    if (row.type === 'tool.requested' && p.toolName === 'respond_writing_intake') history.push({ message: current, args: p.arguments });
  }
} finally { db.close(); }
assert.ok(history.length >= 4);
const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, expectedModel);
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
assert.equal(real.id, expectedProvider);
const root = mkdtempSync(join(tmpdir(), 'writing-intake-transition-live-'));
const storage = openWorkspaceStorage({ workspacePath: root });
let seed: Record<string, unknown> | null = null;
let liveCalls = 0;
class Fixture extends ModelProviderBase {
  constructor() { super(real.id, 'legacy-fixture', real.capabilitiesFor(config.model)); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const interpreting = request.tools[0]?.name === 'interpret_author_reply';
    const args = interpreting ? { intent: 'discuss', sourceQuote: JSON.parse(request.messages.find(m => m.role === 'user')!.content).currentUserMessage,
      reason: 'Recreate the historical collecting state, not validate semantics' } : seed;
    yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: interpreting ? 'interpret_author_reply' : 'respond_writing_intake', argumentsDelta: JSON.stringify(args) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const fixture = new Fixture();
const provider: ModelProvider = {
  id: real.id, adapterVersion: real.adapterVersion, capabilities: real.capabilities,
  capabilitiesFor: m => real.capabilitiesFor(m), snapshotRequest: r => real.snapshotRequest(r),
  async *stream(request: ModelRequest) {
    if (seed) { yield* fixture.stream(request); return; }
    assert.ok(++liveCalls <= 18, 'live-call bound');
    console.log(JSON.stringify({ liveCalls, tool: request.tools[0]?.name, at: new Date().toISOString() }));
    yield* real.stream(request);
  },
};
const service = new WritingApplicationService({ storage, provider });
const bridge = createApplicationBridge({ service, model: { model: config.model, providerLabel: real.id,
  credentialReference: 'configured-system-credential', parameters: { temperature: 0 } }, workspaceId: 'isolated-transition' });
const report: Record<string, unknown> = { root, model: config.model, turns: [] };
const intakeRuns = new Set<string>();
async function until(check: () => boolean) {
  const end = Date.now() + 12 * 60_000;
  while (!check()) { assert.ok(Date.now() < end, 'bridge settlement timeout'); await new Promise(r => setTimeout(r, 200)); }
}
try {
  service.createProject({ projectId: 'replay', operationId: 'p', name: 'RC59确认推进隔离验证', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  let sessionId: string | undefined;
  for (const turn of history.slice(0, 2)) {
    seed = turn.args;
    const result = await service.startConversationTurn({ projectId: 'replay', sessionId, model: config.model, parameters: {}, userInstruction: turn.message }).result;
    assert.equal(result.ok, true); sessionId = result.sessionId; intakeRuns.add(result.runId);
  }
  seed = null;
  await bridge.selectSession('replay', sessionId!);
  for (const [index, message] of ['1500字，其他没问题', 'ok'].entries()) {
    const { runId } = await bridge.sendMessage(message);
    intakeRuns.add(runId);
    await until(() => !['running', 'pending', 'recovering'].includes(storage.getRun(runId)!.status));
    const state = service.getConversationIntake('replay');
    (report.turns as unknown[]).push({ message, run: storage.getRun(runId), phase: state.phase, reply: state.reply });
    assert.equal(state.phase, index === 0 ? 'proposal' : 'confirmed', state.reply);
    console.log(JSON.stringify({ message, phase: state.phase, liveCalls }));
  }
  await until(() => service.getProjectProjection('replay').runs.some(r => !intakeRuns.has(r.id) &&
    !['running', 'pending', 'recovering'].includes(r.status)));
  const writing = service.getProjectProjection('replay').runs.findLast(r => !intakeRuns.has(r.id))!;
  report.writing = writing;
  assert.equal(writing.stopReason, 'CO_CREATION_CHECKPOINT', JSON.stringify(writing));
  assert.ok(storage.listRunEvents(writing.id).some(e => e.type === 'tool.completed' &&
    (e.payload.result as any)?.ok === true && (e.payload.result as any)?.toolName === 'submit_writing_stage'));
  report.ok = true;
} catch (error) { report.error = String(error); throw error;
} finally {
  // Never leave a timed-out isolated replay running after closing its database.
  for (const run of service.getProjectProjection('replay').runs.filter(r => ['running', 'pending', 'recovering'].includes(r.status))) {
    await bridge.cancelRun(run.id);
  }
  report.liveCalls = liveCalls;
  report.events = storage.listEvents('replay').filter(e => ['request.completed', 'request.failed', 'tool.failed', 'run.waiting_user'].includes(e.type));
  const out = resolve('output/intake-transition-recovery'); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'live-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok ?? false, liveCalls, root }));
  bridge.dispose(); storage.close();
}
