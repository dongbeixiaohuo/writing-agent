// Synthetic legacy profile + waiting project. Never reads production data/Keys.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
const id = `rc41-${randomUUID()}`;
const root = join(tmpdir(), `writing-agent-desktop-test-${id}`);
mkdirSync(join(root, 'user-data'), { recursive: true });
const storage = openWorkspaceStorage({ workspacePath: join(root, 'workspace') });
storage.createProject({ projectId: 'old', operationId: 'p', name: '已有测试项目', mode: 'quick', actor: { kind: 'user', id: 'fixture' } });
for (const sessionId of ['s-old', 's-new']) storage.createSession({ projectId: 'old', sessionId, purpose: 'draft' });
storage.startRun({ projectId: 'old', sessionId: 's-old', runId: 'waiting-run', planVersion: 'fixture' });
storage.pauseRun({ projectId: 'old', runId: 'waiting-run', operationId: 'wait', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'outline', nextStage: 'draft' } });
storage.close();
writeFileSync(join(root, 'user-data/provider.json'), JSON.stringify({ schemaVersion: 2, kind: 'openai_compatible',
  providerId: 'fixture', baseURL: 'https://127.0.0.1:9/v1', model: 'MiniMax-M3',
  credentialRef: 'env:WRITING_AGENT_RC37_TEST_KEY', tools: 'supported', usage: 'unknown' }));
console.log(JSON.stringify({ id, root }));
