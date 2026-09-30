import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [source, runId, port] = process.argv.slice(2);
const kind = process.argv[5] ?? 'openai_compatible';
if (!['openai_compatible', 'anthropic_compatible'].includes(kind)) throw new Error('Invalid fixture transport');
if (!source || !runId || !/^\d+$/.test(port ?? '')) throw new Error('Expected source, run and local fixture port');
const id = `rc16-${randomUUID()}`;
const root = join(tmpdir(), `writing-agent-desktop-test-${id}`);
mkdirSync(join(root, 'workspace/.writing-agent'), { recursive: true });
mkdirSync(join(root, 'user-data'), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
const run = db.prepare('SELECT project_id,session_id FROM runs WHERE id=?').get(runId)!;
const before = db.prepare('SELECT latest_body_version_id,current_title_version_id FROM projects WHERE id=?').get(run.project_id!)!;
await backup(db, join(root, 'workspace/.writing-agent/workspace.sqlite3')); db.close();
writeFileSync(join(root, 'user-data/provider.json'), JSON.stringify({ schemaVersion: 2, kind, providerId: 'offline-fixture',
  baseURL: `http://127.0.0.1:${port}/v1`, credentialRef: 'env:WRITING_AGENT_RC16_FIXTURE_KEY', model: 'offline-title-test',
  tools: 'supported', usage: 'reported', allowInsecureHttp: true }));
console.log(JSON.stringify({ id, root, runId, projectId: run.project_id, sessionId: run.session_id, before }));
