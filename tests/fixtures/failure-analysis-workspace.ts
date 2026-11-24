import assert from 'node:assert/strict';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';

export function seedFailureAnalysisWorkspace(workspacePath: string) {
  const storage = openWorkspaceStorage({ workspacePath });
  const projectId = 'failure-analysis-example';
  const sessionId = 'example-session';
  const runId = 'example-failure';
  const record = (type: Parameters<typeof storage.recordRunEvent>[0]['type'], operationId: string, payload: Record<string, unknown>) =>
    storage.recordRunEvent({ projectId, runId, type, operationId, payload });
  try {
    assert.ok(storage.createProject({ projectId, name: '排障示例 · 核对公开来源', mode: 'quick',
      operationId: 'create-example', actor: { kind: 'user', id: 'test' } }).ok);
    storage.createSession({ projectId, sessionId, purpose: 'writing-pack:fact-check' });
    storage.startRun({ projectId, sessionId, runId, purpose: 'writing-pack:fact-check', planVersion: 'test',
      displayInstruction: '核对稿件里的公开来源' });
    const completed = record('request.dispatch_attempted', 'model-step', { requestId: 'example-local-request', actor: 'fact_check' });
    record('request.completed', 'model-step', { requestId: 'example-local-request', responseText: 'fixture-private-model-output',
      toolCallIds: ['example-local-call'], finishReason: 'tool_calls' });
    const failure = record('tool.requested', 'read-source', { requestId: 'example-local-request', callId: 'example-local-call',
      actor: 'fact_check', toolName: 'read_fact_source', arguments: { url: 'https://example.test/fixture-private-source' } });
    record('tool.failed', 'read-source', { error: { code: 'FACT_SOURCE_NOT_IN_LEDGER', message: 'fixture-private-error-detail' } });
    storage.finishRun({ projectId, runId, operationId: 'finish-example', status: 'failed', stopReason: 'FACT_SOURCE_NOT_IN_LEDGER' });
    return { target: { projectId, sessionId, runId, stepId: failure.id }, completedStepId: completed.id };
  } finally {
    storage.close();
  }
}
