// Opt-in live validation. Reads only the requested incident; all writes are isolated.
// WA_DIAG_DB=<workspace sqlite> node --import tsx tests/ux/intake-format-replay.ts <project-id>
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

assert.ok(process.env.WA_DIAG_DB && process.argv[2], 'Specify the incident database and project ID');
const db = new DatabaseSync(process.env.WA_DIAG_DB, { readOnly: true });
const history: { message: string; args: Record<string, unknown> }[] = [];
let currentMessage = '';
let expectedModel = '';
let expectedProvider = '';
try {
  for (const row of db.prepare('SELECT type,payload_json FROM events WHERE project_id=? ORDER BY project_seq').all(process.argv[2])) {
    const payload = JSON.parse(String(row.payload_json));
    if (row.type === 'run.started') currentMessage = payload.displayInstruction;
    if (row.type === 'request.prepared') { expectedModel = payload.model; expectedProvider = payload.provider; }
    if (row.type === 'tool.requested') {
      assert.equal(payload.toolName, 'respond_writing_intake', 'This replay supports intake only');
      assert.ok(!payload.arguments.proposal && !payload.arguments.confirmation, 'Do not replay historical version-bound transitions');
      history.push({ message: currentMessage, args: payload.arguments });
    }
  }
} finally { db.close(); }
assert.ok(history.length && currentMessage);
const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, expectedModel, 'Do not silently test a different active model');
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
assert.equal(real.id, expectedProvider);
const reports: unknown[] = [];
for (const mode of ['natural', 'mixed-format-recovery'] as const) {
  const root = mkdtempSync(join(tmpdir(), 'writing-intake-format-live-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  let seededArgs: Record<string, unknown> | null = null;
  let liveCalls = 0; let injected = 0;
  class Fixture extends ModelProviderBase {
    constructor() { super(real.id, 'incident-fixture', real.capabilitiesFor(config.model)); }
    protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
      const raw = seededArgs ? JSON.stringify(seededArgs) : injected++ === 0
        ? '{"reply":"已收到选择","questions":[],"proposal":{"summary":"错误层级"}}'
        : '{"reply":"含有"未转义"引号"}';
      yield { type: 'tool_call_delta', index: 0, id: `fixture-${injected}`, name: 'respond_writing_intake', argumentsDelta: raw };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const fixture = new Fixture();
  const provider: ModelProvider = {
    id: real.id, adapterVersion: real.adapterVersion, capabilities: real.capabilities,
    capabilitiesFor: model => real.capabilitiesFor(model), snapshotRequest: request => real.snapshotRequest(request),
    async *stream(request: ModelRequest) {
      if (seededArgs || mode === 'mixed-format-recovery' && injected < 2) { yield* fixture.stream(request); return; }
      assert.ok(++liveCalls <= 4, 'live-call safety bound');
      console.log(JSON.stringify({ mode, phase: 'model_request', call: liveCalls, toolChoice: request.parameters.toolChoice }));
      yield* real.stream(request);
    },
  };
  try {
    const app = new WritingApplicationService({ storage, provider });
    app.createProject({ projectId: 'replay', operationId: 'replay', name: '格式恢复隔离验收', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    let sessionId: string | undefined;
    for (const turn of history) {
      seededArgs = turn.args;
      const seed = await app.startConversationTurn({ projectId: 'replay', sessionId, model: config.model, parameters: {}, userInstruction: turn.message }).result;
      assert.equal(seed.ok, true, JSON.stringify(seed)); sessionId = seed.sessionId;
    }
    seededArgs = null;
    const result = await app.startConversationTurn({ projectId: 'replay', sessionId, model: config.model, parameters: { temperature: 0 }, userInstruction: currentMessage }).result;
    const state = app.getConversationIntake('replay');
    const events = storage.listRunEvents(result.runId).filter(event => ['request.failed', 'request.completed', 'run.failed'].includes(event.type))
      .map(event => ({ type: event.type, payload: { error: event.payload.error, toolSchemaFeedback: event.payload.toolSchemaFeedback,
        stream: event.payload.stream, usage: event.payload.usage } }));
    reports.push({ mode, root, liveCalls, ok: result.ok, requests: result.modelRequestCount, toolCalls: result.toolCallCount, phase: state.phase,
      reply: result.ok ? result.reply : null, events });
    const out = resolve('output/intake-format-recovery'); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'live-report.json'), JSON.stringify({ model: config.model, reports }, null, 2));
    console.log(JSON.stringify({ mode, ok: result.ok, liveCalls, requests: result.modelRequestCount, phase: state.phase }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.toolCallCount, 1);
    assert.notEqual(state.phase, 'confirmed');
    assert.equal(storage.inspectProject('replay')?.latestBodyVersionId, null);
    assert.equal(state.sourceTurns.at(-1)?.quote, currentMessage);
    assert.equal(state.assistantTurns.length, history.length + 1);
  } finally { storage.close(); }
}
