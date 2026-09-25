// Read-only source diagnosis; all replay writes stay in a newly created test workspace.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';

const [sourcePath, sourceRunId, mode = '--offline'] = process.argv.slice(2);
assert.ok(sourcePath && sourceRunId, 'source DB path and exact run ID are required');
assert.ok(['--offline', '--allow-real-model'].includes(mode));
const source = new DatabaseSync(sourcePath, { readOnly: true });
type Turn = { input: string; response: Record<string, unknown> };
let history: Turn[] = [];
let failedTurn: Turn;
try {
  const run = source.prepare('SELECT project_id,status FROM runs WHERE id=?').get(sourceRunId)!;
  assert.ok(run); assert.equal(run.status, 'budget_exhausted');
  const events = source.prepare('SELECT run_id,type,payload_json,project_seq FROM events WHERE project_id=? ORDER BY project_seq').all(run.project_id!);
  const starts = events.filter(event => event.type === 'run.started');
  const target = starts.findIndex(event => event.run_id === sourceRunId);
  assert.ok(target >= 0);
  const turns = starts.slice(0, target + 1).map(start => {
    const payload = JSON.parse(String(start.payload_json));
    assert.equal(payload.purpose, 'writing-pack:intake');
    const request = events.find(event => event.run_id === start.run_id && event.type === 'tool.requested');
    assert.ok(request);
    return { input: payload.displayInstruction as string, response: JSON.parse(String(request.payload_json)).arguments as Record<string, unknown> };
  });
  history = turns.slice(0, -1); failedTurn = turns.at(-1)!;
} finally { source.close(); }

class ReplayProvider extends ModelProviderBase {
  index = 0;
  constructor(readonly turns: readonly Turn[]) {
    super('offline-recorded-intake', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' });
  }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const turn = this.turns[this.index++];
    assert.ok(turn, 'Each recorded response must save without an additional model correction');
    yield { type: 'tool_call_delta', index: 0, id: `replay-${request.requestId}`, name: 'respond_writing_intake', argumentsDelta: JSON.stringify(turn.response) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}

const parent = resolve('output/rc13-intake-replay'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, mode === '--offline' ? 'offline-' : 'real-'));
const workspacePath = join(root, 'workspace');
const storage = openWorkspaceStorage({ workspacePath });
const provider = new ReplayProvider(mode === '--offline' ? [...history, failedTurn!] : history);
const service = new WritingApplicationService({ storage, provider });
service.createProject({ projectId: 'replay-project', operationId: 'create', name: 'rc13 独立澄清回归', mode: 'quick', actor: { kind: 'user', id: 'replay-user' } });
const report: Record<string, unknown> = { sourceRunId, mode, workspacePath, originalProjectWrites: 0, realModelTurns: 0, historyTurns: history.length,
  sourceMessagesHash: createHash('sha256').update(JSON.stringify([...history, failedTurn!].map(turn => turn.input))).digest('hex') };
let host: DesktopApplicationHost | undefined;
let storageClosed = false;
try {
  for (const [index, turn] of provider.turns.entries()) {
    const result = await service.startConversationTurn({ projectId: 'replay-project', sessionId: 'replay-session', operationId: `seed-${index}`, model: 'offline', parameters: {}, userInstruction: turn.input }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.modelRequestCount, 1);
  }
  const state = service.getConversationIntake('replay-project');
  assert.deepEqual(state.sourceTurns.map(turn => turn.quote), provider.turns.map(turn => turn.input));
  assert.equal(storage.inspectProject('replay-project')!.latestBodyVersionId, null);
  if (mode === '--offline') {
    assert.equal(state.phase, 'proposal');
    assert.equal(state.brief!.confirmationStatus, 'tentative');
    assert.deepEqual(state.brief!.authorAuthorization.firsthandMaterialIds, []);
    report.phase = state.phase; report.reply = state.reply;
    report.modelRequests = provider.index; report.replayedFailureSavedOnFirstAttempt = true;
  } else {
    storage.close(); storageClosed = true;
    host = new DesktopApplicationHost({ workspacePath, providerProfilePath: join(process.env.APPDATA!, 'Writing Agent', 'provider.json'), applicationVersion: '1.0.0-rc.13' });
    const status = await host.providerStatus(); assert.equal(status.configured, true); assert.equal(status.model, 'MiniMax-M3');
    await host.bridge.selectSession('replay-project', 'replay-session');
    const realTurns = [failedTurn!.input, '先不要开始写作。这次请用明确标注为虚构的示意案例，先和我讨论怎样避免以偏概全，不要把案例当成我的亲历。'];
    const results = [];
    for (const input of realTurns) {
      const started = await host.bridge.sendMessage(input);
      report.realModelTurns = Number(report.realModelTurns) + 1;
      const deadline = Date.now() + 240_000;
      let result;
      while (Date.now() < deadline) {
        await host.bridge.refresh();
        const current = host.bridge.getSnapshot();
        result = current.runRecords.find(run => run.id === started.runId);
        if (result && !['created', 'running', 'queued'].includes(result.status) && current.activeRunId === null) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(result); results.push(result); report.runs = results;
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(host.bridge.getSnapshot().deliveryWorkspace.bodyVersionId, null, 'Clarification must not start full writing');
      console.log(JSON.stringify({ mode, turn: results.length, status: result.status, modelRequests: result.modelRequests }));
    }
    report.timeline = host.bridge.getSnapshot().timelineBySession['replay-session'];
    report.intake = host.bridge.getSnapshot().conversationIntake;
    report.realTurnsPassed = results.length;
    assert.notEqual(host.bridge.getSnapshot().conversationIntake?.phase, 'confirmed');
  }
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed'; report.failure = error instanceof Error ? error.message : 'REPLAY_FAILED'; process.exitCode = 1;
} finally {
  if (host) { const active = host.bridge.getSnapshot().activeRunId; if (active) await host.bridge.cancelRun(active); host.close(); }
  if (!storageClosed) storage.close();
  report.checkedAt = new Date().toISOString();
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode, outcome: report.outcome, realModelTurns: report.realModelTurns, evidence: join(root, 'result.json') }));
}
