import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../../application/src/index.js';
import { ModelProviderBase, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { createApplicationBridge } from '../src/application-bridge.js';

const actor = { kind: 'user', id: 'synthetic-recovery-test' } as const;
const model = { model: 'no-network', providerLabel: 'synthetic', credentialReference: null, parameters: {} };
class NoNetwork extends ModelProviderBase {
  constructor() { super('no-network', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> { throw new Error('Unexpected external model request'); }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-project-isolation-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  for (const projectId of ['healthy', 'broken']) {
    assert.equal(storage.createProject({ projectId, operationId: `${projectId}:create`, name: projectId, mode: 'quick', actor }).ok, true);
    assert.equal(storage.saveWritingBrief({ projectId, operationId: `${projectId}:brief`, expectedProjectRevision: 0, baseVersionId: null, actor,
      brief: { schemaVersion: 1, topic: `${projectId} topic`, genre: 'narrative_observation', audience: '读者', lengthTarget: { targetCharacters: 800 },
        materialIds: [], constraints: [], interactionMode: 'autonomous', authorAuthorization: { voice: null, styleReference: null,
          styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: null,
        publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } }).ok, true);
    assert.equal(storage.commitArtifactVersion({ projectId, operationId: `${projectId}:body`, expectedProjectRevision: 1, kind: 'body', logicalKey: 'main',
      baseVersionId: null, content: `# ${projectId} original body`, reason: 'synthetic-original', actor }).ok, true);
    storage.createSession({ projectId, sessionId: `${projectId}:session`, purpose: 'writing-pack:draft' });
  }
  const sql = new DatabaseSync(storage.databasePath);
  const service = new WritingApplicationService({ storage, provider: new NoNetwork() });
  return { root, storage, sql, service, close() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const field of ['brief', 'body'] as const) test(`genuine two-project ${field} corruption is isolated at startup, selection and refresh`, async () => {
  const f = fixture();
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  const table = field === 'brief' ? 'writing_brief_versions' : 'body_documents';
  const column = field === 'brief' ? 'brief_json' : 'document_json';
  const original = f.sql.prepare(`SELECT ${column} AS value FROM ${table} WHERE project_id = ?`).get('broken')!.value;
  const damage = '{SYNTHETIC malformed original';
  try {
    f.sql.prepare(`UPDATE ${table} SET ${column} = ? WHERE project_id = ?`).run(damage, 'broken');
    assert.doesNotThrow(() => { bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, initialProjectId: 'healthy', model }); });
    assert.equal(bridge!.getSnapshot().connection, 'ready');
    assert.equal(bridge!.getSnapshot().previewDocument.body, '# healthy original body');
    assert.equal(bridge!.getSnapshot().projects.length, 2);
    assert.ok(bridge!.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue);
    const logs = readdirSync(join(f.root, '.writing-agent', 'project-diagnostics'));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(join(f.root, '.writing-agent', 'project-diagnostics', logs[0]!), 'utf8'), /broken/);
    await bridge!.selectProject('broken');
    assert.equal(bridge!.getSnapshot().selectedProjectId, 'broken');
    assert.equal(bridge!.getSnapshot().selectedSessionId, '');
    await assert.rejects(bridge!.sendMessage('do not write to sibling'), { code: 'PROJECT_DATA_UNREADABLE' });
    assert.equal(f.storage.listRuns('healthy').length, 0);
    const exported = JSON.parse(f.service.exportProjectRecovery('broken'));
    assert.equal(exported.projectId, 'broken');
    assert.equal(exported.tables[table][0][column], damage);
    for (const [name, rows] of Object.entries(exported.tables) as [string, any[]][]) {
      assert.ok(rows.every(row => name === 'projects' ? row.id === 'broken' : row.project_id === 'broken'));
    }
    assert.doesNotMatch(JSON.stringify(exported.tables), /healthy original body|healthy topic/);
    await bridge!.selectProject('healthy');
    await bridge!.refresh();
    await bridge!.renameProject('healthy', 'Healthy still writable');
    assert.equal(f.storage.inspectProject('healthy')!.name, 'Healthy still writable');
    f.sql.prepare(`UPDATE ${table} SET ${column} = ? WHERE project_id = ?`).run(original, 'broken');
    await bridge!.refresh();
    assert.equal(bridge!.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue, undefined);
    await bridge!.selectProject('broken');
    assert.equal(bridge!.getSnapshot().previewDocument.body, '# broken original body');
  } finally { bridge?.dispose(); f.close(); }
});

test('single-project raw export preserves invalid UTF-8 bytes from the current draft', () => {
  const f = fixture();
  try {
    f.sql.exec("UPDATE body_documents SET document_json = CAST(X'FF007B' AS TEXT) WHERE project_id = 'broken'");
    const result = JSON.parse(f.service.exportProjectRecovery('broken'));
    assert.equal(result.rawCurrentFields.body.rawHex, 'FF007B');
    assert.doesNotMatch(JSON.stringify(result), /healthy original body/);
  } finally { f.close(); }
});

test('all unreadable projects remain selectable and exportable; new projects can still be created', async () => {
  const f = fixture();
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    f.sql.exec("UPDATE writing_brief_versions SET brief_json = '{bad'");
    bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, model });
    assert.equal(bridge.getSnapshot().connection, 'ready');
    assert.equal(bridge.getSnapshot().projects.filter(p => p.readIssue).length, 2);
    assert.notEqual(bridge.getSnapshot().selectedProjectId, '');
    await bridge.selectProject('broken');
    assert.equal(JSON.parse(f.service.exportProjectRecovery('broken')).projectId, 'broken');
    assert.equal(f.service.createProject({ projectId: 'new', operationId: 'new:create', name: 'New', mode: 'quick', actor }).ok, true);
    await bridge.refresh();
    await bridge.selectProject('new');
    assert.equal(bridge.getSnapshot().selectedProjectId, 'new');
    assert.equal(bridge.getSnapshot().lastError, null);
  } finally { bridge?.dispose(); f.close(); }
});

test('runtime recovery and pending handoffs survive a sibling malformed project', () => {
  const f = fixture();
  try {
    for (const projectId of ['healthy', 'broken']) {
      f.storage.startRun({ projectId, sessionId: `${projectId}:session`, runId: `${projectId}:orphan`, planVersion: 'synthetic', purpose: 'writing-pack:draft', operationId: `${projectId}:run` });
    }
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run('{bad', 'broken');
    const recovered = f.service.recoverWorkspace();
    assert.deepEqual(recovered.map(r => r.projectId), ['healthy']);
    assert.equal(f.storage.getRun('healthy:orphan')!.status, 'interrupted');
    assert.equal(f.storage.getRun('broken:orphan')!.status, 'running', 'unreadable project is not silently mutated');
    assert.doesNotThrow(() => f.service.continuePendingHandoffs(model));
    assert.ok(f.service.getProjectReadIssue('broken'));
  } finally { f.close(); }
});


test('a real healthy handoff is processed even when a sibling handoff artifact is malformed', () => {
  const f = fixture();
  try {
    for (const projectId of ['healthy', 'broken']) {
      const runId = `${projectId}:author`;
      f.storage.startRun({ projectId, sessionId: `${projectId}:session`, runId, planVersion: 'synthetic', purpose: 'writing-pack:author-conversation', operationId: `${runId}:start` });
      const saved = f.storage.commitArtifactVersion({ projectId, operationId: `${runId}:response`, expectedProjectRevision: f.storage.inspectProject(projectId)!.revision,
        kind: 'report', logicalKey: `author-turn:${runId}`, baseVersionId: null,
        content: projectId === 'broken' ? '{malformed handoff' : JSON.stringify({ requestedAction: 'full_writing', task: 'write', bodyVersionId: null, intentReceiptId: null }),
        reason: 'author-conversation', actor: { kind: 'agent', id: 'director', runId } });
      assert.equal(saved.ok, true);
      f.storage.finishRun({ projectId, runId, operationId: `${runId}:finish`, status: 'completed', stopReason: null });
    }
    assert.doesNotThrow(() => f.service.continuePendingHandoffs(model));
    assert.equal(f.service.getHandoffError('healthy', 'healthy:session')?.code, 'HANDOFF_CONTEXT_CHANGED', 'healthy handoff is processed and durably records its genuine changed-body outcome');
    assert.ok(f.service.getProjectReadIssue('broken'));
    const bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, initialProjectId: 'healthy', model });
    assert.equal(bridge.getSnapshot().connection, 'ready');
    assert.ok(bridge.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue);
    bridge.dispose();
  } finally { f.close(); }
});


test('idle polling with an isolated project does not continuously rebuild projections or diagnostics', async t => {
  const f = fixture();
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run('{bad', 'broken');
    bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, model, pollIntervalMs: 15 });
    const reads = t.mock.method(f.service, 'getProjectProjection');
    const diagnostics = t.mock.method(f.storage, 'recordProjectReadFailure');
    const unsubscribe = bridge.subscribe(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 120));
    unsubscribe();
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(diagnostics.mock.callCount(), 0);
  } finally { bridge?.dispose(); f.close(); }
});

for (const damage of ['null', 'blocks', 'block-content', 'brief-shape']) test(`valid JSON with invalid ${damage} fields is visibly isolated`, () => {
  const f = fixture();
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    if (damage === 'brief-shape') f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run('{"topic":42}', 'broken');
    else {
      const row = f.sql.prepare('SELECT document_json FROM body_documents WHERE project_id = ?').get('broken')!;
      const document = JSON.parse(row.document_json as string);
      if (damage === 'blocks') document.blocks = {};
      if (damage === 'block-content') document.blocks[0].content = 7;
      f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(damage === 'null' ? 'null' : JSON.stringify(document), 'broken');
    }
    bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, model });
    assert.ok(bridge.getSnapshot().projects.find(project => project.id === 'broken')!.readIssue);
    assert.equal(bridge.getSnapshot().connection, 'ready');
  } finally { bridge?.dispose(); f.close(); }
});

test('workspace IO failure propagates and cannot be mislabeled as isolated project damage', t => {
  const f = fixture();
  try {
    t.mock.method(f.storage, 'getWritingBriefVersion', () => { throw Object.assign(new Error('busy'), { code: 'ERR_SQLITE_ERROR' }); });
    assert.throws(() => f.service.tryProjectProjection('broken'), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(f.service.getProjectReadIssue('broken'), undefined);
  } finally { f.close(); }
});

test('failure to persist diagnostics stays visible without blocking the healthy project', t => {
  const f = fixture();
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run('{bad', 'broken');
    t.mock.method(f.storage, 'recordProjectReadFailure', () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
    const stderr = t.mock.method(console, 'error', () => undefined);
    const bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, initialProjectId: 'healthy', model });
    assert.match(bridge.getSnapshot().projects.find(project => project.id === 'broken')!.readIssue!.message, /诊断记录未能保存.*ENOSPC/);
    assert.equal(bridge.getSnapshot().connection, 'ready');
    f.service.tryProjectProjection('broken');
    f.service.tryProjectProjection('broken');
    assert.equal(stderr.mock.callCount(), 1, 'identical diagnostic write failures are not logged repeatedly');
    assert.match(String(stderr.mock.calls[0]!.arguments[0]), /ENOSPC/);
    assert.doesNotMatch(String(stderr.mock.calls[0]!.arguments[0]), /broken|full/);
    bridge.dispose();
  } finally { f.close(); }
});

test('a runtime recovery failure remains visible across ordinary reads until explicitly rechecked', async t => {
  const f = fixture();
  let bridge: ReturnType<typeof createApplicationBridge> | undefined;
  try {
    const original = f.storage.recoverProjectRuns.bind(f.storage);
    let failing = true;
    t.mock.method(f.storage, 'recoverProjectRuns', (projectId: string) => {
      if (projectId === 'broken' && failing) throw Object.assign(new Error('invalid runtime recovery record'), { code: 'RECOVERY_RECORD_INVALID' });
      return original(projectId);
    });
    f.service.recoverWorkspace();
    bridge = createApplicationBridge({ service: f.service, workspaceId: f.root, initialProjectId: 'broken', model });
    await bridge.refresh();
    assert.equal(bridge.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue!.stage, '恢复运行');
    failing = false;
    await bridge.refresh();
    assert.ok(bridge.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue, 'ordinary refresh cannot erase an unchecked recovery failure');
    await bridge.recheckProject!('broken');
    assert.equal(bridge.getSnapshot().projects.find(p => p.id === 'broken')!.readIssue, undefined);
  } finally { bridge?.dispose(); f.close(); }
});


test('an unreadable auxiliary diagnostic file never prevents raw project export', () => {
  const f = fixture();
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run('{bad original', 'broken');
    f.service.tryProjectProjection('broken');
    const directory = join(f.root, '.writing-agent', 'project-diagnostics');
    const path = join(directory, readdirSync(directory)[0]!);
    rmSync(path);
    mkdirSync(path);
    const exported = JSON.parse(f.service.exportProjectRecovery('broken'));
    assert.equal(exported.tables.writing_brief_versions[0].brief_json, '{bad original');
    assert.equal(exported.diagnostic.code, 'PROJECT_BRIEF_INVALID');
    assert.equal(exported.tables.projects[0].id, 'broken');
  } finally { f.close(); }
});
