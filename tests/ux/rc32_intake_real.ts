import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelProvider } from '../../packages/runtime/llm/src/index.js';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, 'MiniMax-M3');
const root = mkdtempSync(join(tmpdir(), 'writing-agent-rc32-intake-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
const replayFirst = process.argv.includes('--replay-first');
let recordedReply: string | null = null;
if (replayFirst) {
  const db = new DatabaseSync('D:/User/Documents/Writing Agent/Workspace/.writing-agent/workspace.sqlite3', { readOnly: true });
  try {
    const row = db.prepare('SELECT payload_json FROM events WHERE run_id=? AND type=? ORDER BY project_seq LIMIT 1').get('3c7dbca4-934e-4db1-bc1d-bb83b4512de1', 'request.completed')!;
    recordedReply = JSON.parse(String(row.payload_json)).responseText;
    assert.ok(recordedReply);
  } finally { db.close(); }
}
let modelCalls = 0;
const provider: ModelProvider = {
  id: real.id, adapterVersion: real.adapterVersion, capabilities: real.capabilities,
  capabilitiesFor: model => real.capabilitiesFor(model), snapshotRequest: request => real.snapshotRequest(request),
  async *stream(request) {
    if (recordedReply !== null) {
      const delta = recordedReply; recordedReply = null;
      yield { type: 'text_delta', sequence: 1, delta };
      yield { type: 'completed', sequence: 2, finishReason: 'stop', provider: 'recorded-incident-replay', model: config.model, adapterVersion: 'fixture' };
      return;
    }
    if (replayFirst) assert.equal(request.parameters.toolChoice, 'required');
    modelCalls++;
    yield* real.stream(request);
  },
};
const app = new WritingApplicationService({ storage, provider });
const results: unknown[] = [];
try {
  const messages = replayFirst ? ['写一个人天天内耗怎么办'] : ['写一个人天天内耗怎么办', '不知道写啥', '写一个人天天内耗怎么办'];
  for (const [i, message] of messages.entries()) {
    const projectId = `p${i}`;
    app.createProject({ operationId: projectId, projectId, name: `澄清回归${i}`, mode: 'quick', actor: { kind: 'user', id: 'isolated-test' } });
    const handle = app.startConversationTurn({ projectId, model: config.model, parameters: { temperature: 0 }, userInstruction: message });
    console.log(JSON.stringify({ phase: 'start', i, root, runId: handle.runId }));
    const previews: number[] = [];
    const timer = setInterval(() => { const text = app.getLiveReply(projectId, handle.sessionId, handle.runId)?.text; if (text) previews.push(text.length); }, 150);
    let run;
    try { run = await handle.result; } finally { clearInterval(timer); }
    results.push({ message, run, previews: [...new Set(previews)], events: storage.listRunEvents(run.runId), usage: storage.getRun(run.runId)?.usage });
    const out = resolve('output/rc32-intake'); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, replayFirst ? 'real-save-result.json' : 'real-result.json'), JSON.stringify({ root, model: config.model, replayFirst, modelCalls, results }, null, 2));
    assert.ok(run.ok, JSON.stringify(run));
    assert.equal(run.toolCallCount, 1);
    assert.ok(run.modelRequestCount <= 2, JSON.stringify(run));
    assert.notEqual(run.intake.phase, 'confirmed');
    assert.equal(storage.inspectProject(projectId)!.latestBodyVersionId, null);
    console.log(JSON.stringify({ phase: 'saved', i, requests: run.modelRequestCount, reply: run.reply, intakePhase: run.intake.phase }));
    if (i === 0 && !replayFirst) {
      const next = await app.startConversationTurn({ projectId, sessionId: handle.sessionId, model: config.model, parameters: { temperature: 0 }, userInstruction: '给普通上班族看，1000字，不用我的个人经历，先聊方向，不开始写正文' }).result;
      results.push({ message: 'follow-up', run: next, events: storage.listRunEvents(next.runId), usage: storage.getRun(next.runId)?.usage });
      writeFileSync(join(out, 'real-result.json'), JSON.stringify({ root, model: config.model, replayFirst, modelCalls, results }, null, 2));
      assert.ok(next.ok, JSON.stringify(next));
      assert.notEqual(next.intake.phase, 'confirmed');
      assert.equal(storage.inspectProject(projectId)!.latestBodyVersionId, null);
      console.log(JSON.stringify({ phase: 'follow-up-saved', requests: next.modelRequestCount, intakePhase: next.intake.phase }));
    }
  }
  console.log('INTAKE_REAL_PASS');
} finally { storage.close(); }
