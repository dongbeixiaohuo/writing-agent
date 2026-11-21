import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openWorkspaceStorage } from '../src/index.js';
import { WritingApplicationService } from '../../application/src/index.js';

const actor = { kind: 'user', id: 'repair-fixture' } as const;
const brokenText = '{原始损坏字节\n\t';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-project-repair-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  for (const projectId of ['selected', 'healthy']) {
    assert.equal(storage.createProject({ projectId, operationId: `${projectId}:create`, name: projectId, mode: 'quick', actor }).ok, true);
    assert.equal(storage.saveWritingBrief({ projectId, operationId: `${projectId}:brief`, expectedProjectRevision: 0, baseVersionId: null, actor,
      brief: { schemaVersion: 1, topic: `${projectId} topic`, genre: 'narrative_observation', audience: '读者', lengthTarget: { targetCharacters: 800 },
        materialIds: [], constraints: [], interactionMode: 'autonomous', authorAuthorization: { voice: null, styleReference: null,
          styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: null,
        publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } }).ok, true);
    assert.equal(storage.commitArtifactVersion({ projectId, operationId: `${projectId}:body`, expectedProjectRevision: 1, kind: 'body', logicalKey: 'main',
      baseVersionId: null, content: `# ${projectId} 原始稿件\n\n保持正文不变。`, reason: 'original', actor }).ok, true);
  }
  const backupPath = join(root, 'verified-backup.sqlite3');
  await storage.createBackup(backupPath);
  const sql = new DatabaseSync(storage.databasePath);
  const service = new WritingApplicationService({ storage });
  const rows = (projectId: string) => JSON.parse(storage.exportProjectRecovery(projectId)).tables;
  return { root, storage, sql, service, backupPath, rows, close() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }); } };
}
function hash(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

for (const damage of ['brief', 'body', 'missing-body', 'both'] as const) test(`verified backup repairs only selected ${damage}, preserves exact bytes and is idempotent`, async () => {
  const f = await fixture();
  try {
    const healthyBefore = f.rows('healthy');
    const selectedBefore = f.rows('selected');
    const backupHash = hash(f.backupPath);
    if (damage === 'brief' || damage === 'both') f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    if (damage === 'body' || damage === 'both') f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    if (damage === 'missing-body') f.sql.prepare('DELETE FROM body_documents WHERE project_id = ?').run('selected');
    assert.equal(f.service.tryProjectProjection('selected'), null);
    const result = f.service.repairProjectFromBackup('selected', f.backupPath);
    assert.equal(result.status, 'repaired');
    assert.deepEqual(result.repairedFields, damage === 'both' ? ['brief_json', 'body_document'] : [damage === 'brief' ? 'brief_json' : 'body_document']);
    assert.ok(f.service.tryProjectProjection('selected'));
    assert.deepEqual(f.rows('healthy'), healthyBefore);
    assert.deepEqual(f.rows('selected'), selectedBefore, 'only corrupt fields were restored; no project pointer, revision, run or history was rewritten');
    const evidence = JSON.parse(readFileSync(result.evidencePath!, 'utf8'));
    assert.equal(evidence.projectId, 'selected');
    assert.equal(evidence.backupSha256, backupHash, 'chunked hash matches the independent source checksum');
    assert.deepEqual(evidence.repairedFields, result.repairedFields);
    if (damage === 'brief' || damage === 'both') assert.equal(evidence.before.brief.rawJsonHex, Buffer.from(brokenText).toString('hex').toUpperCase());
    if (damage === 'body' || damage === 'both') assert.equal(evidence.before.body.rawJsonHex, Buffer.from(brokenText).toString('hex').toUpperCase());
    if (damage === 'missing-body') assert.equal(evidence.before.body.row, null);
    const retry = f.service.repairProjectFromBackup('selected', f.backupPath);
    assert.deepEqual(retry, { projectId: 'selected', status: 'no_change', repairedFields: [], evidencePath: null });
    assert.equal(readdirSync(join(f.root, '.writing-agent', 'project-repairs')).length, 1);
    assert.equal(hash(f.backupPath), backupHash, 'source backup remains untouched');
  } finally { f.close(); }
});

test('a newer healthy brief is left byte-for-byte unchanged while restoring the same damaged body version', async () => {
  const f = await fixture();
  try {
    const current = f.storage.getWritingBriefVersion(f.storage.inspectProject('selected')!.currentBriefVersionId!)!;
    const saved = f.storage.saveWritingBrief({ projectId: 'selected', operationId: 'new-brief', expectedProjectRevision: f.storage.inspectProject('selected')!.revision,
      baseVersionId: current.id, brief: { ...current.brief, topic: 'New author intent since backup' }, actor });
    assert.equal(saved.ok, true);
    const before = f.rows('selected');
    f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    const result = f.service.repairProjectFromBackup('selected', f.backupPath);
    assert.deepEqual(result.repairedFields, ['body_document']);
    assert.deepEqual(f.rows('selected'), before);
  } finally { f.close(); }
});

test('missing exact brief version, missing project and missing local brief proof all refuse without changes', async () => {
  const f = await fixture();
  try {
    const current = f.storage.getWritingBriefVersion(f.storage.inspectProject('selected')!.currentBriefVersionId!)!;
    const saved = f.storage.saveWritingBrief({ projectId: 'selected', operationId: 'new-brief', expectedProjectRevision: f.storage.inspectProject('selected')!.revision,
      baseVersionId: current.id, brief: { ...current.brief, topic: 'New version absent from backup' }, actor });
    assert.equal(saved.ok, true);
    const id = f.storage.inspectProject('selected')!.currentBriefVersionId!;
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE id = ?').run(brokenText, id);
    const before = f.rows('selected');
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), { code: 'PROJECT_REPAIR_NO_MATCH' });
    assert.deepEqual(f.rows('selected'), before);
    assert.throws(() => f.service.repairProjectFromBackup('absent', f.backupPath), { code: 'PROJECT_NOT_FOUND' });
    f.sql.prepare('DELETE FROM writing_brief_versions WHERE id = ?').run(id);
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), { code: 'PROJECT_REPAIR_UNVERIFIABLE' });
  } finally { f.close(); }
});

for (const damage of ['file', 'brief', 'body', 'hash'] as const) test(`backup ${damage} damage is rejected before any target write`, async () => {
  const f = await fixture();
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    const before = f.rows('selected');
    if (damage === 'file') writeFileSync(f.backupPath, 'not sqlite');
    else {
      const source = new DatabaseSync(f.backupPath);
      try {
        if (damage === 'brief') source.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run(brokenText, 'selected');
        if (damage === 'body') source.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(brokenText, 'selected');
        if (damage === 'hash') source.prepare('UPDATE artifact_versions SET content_hash = ? WHERE project_id = ?').run('wrong-hash', 'selected');
      } finally { source.close(); }
    }
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), { code: 'PROJECT_REPAIR_BACKUP_INVALID' });
    assert.deepEqual(f.rows('selected'), before);
  } finally { f.close(); }
});

test('a transaction failure after brief update rolls it back, retaining pre-repair evidence', async () => {
  const f = await fixture();
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    const before = f.rows('selected');
    f.sql.exec("CREATE TRIGGER reject_repair BEFORE UPDATE ON body_documents BEGIN SELECT RAISE(ABORT, 'synthetic repair failure'); END");
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), /synthetic repair failure/);
    assert.deepEqual(f.rows('selected'), before);
    const evidence = readdirSync(join(f.root, '.writing-agent', 'project-repairs'));
    assert.equal(evidence.length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.root, '.writing-agent', 'project-repairs', evidence[0]!), 'utf8')).before.brief.rawJsonHex, Buffer.from(brokenText).toString('hex').toUpperCase());
  } finally { f.close(); }
});

test('evidence write failure prevents repairs; unverifiable live hashes are never overwritten', async () => {
  const f = await fixture();
  try {
    f.sql.prepare('UPDATE writing_brief_versions SET brief_json = ? WHERE project_id = ?').run(brokenText, 'selected');
    const before = f.rows('selected');
    writeFileSync(join(f.root, '.writing-agent', 'project-repairs'), 'synthetic obstruction');
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), { code: 'PROJECT_REPAIR_EVIDENCE_FAILED' });
    assert.deepEqual(f.rows('selected'), before);
    f.sql.prepare('UPDATE writing_brief_versions SET content_hash = ? WHERE project_id = ?').run('lost-local-proof', 'selected');
    const unverified = f.rows('selected');
    assert.throws(() => f.service.repairProjectFromBackup('selected', f.backupPath), { code: 'PROJECT_REPAIR_UNVERIFIABLE' });
    assert.deepEqual(f.rows('selected'), unverified);
  } finally { f.close(); }
});


test('repair evidence preserves invalid UTF-8 SQLite bytes rather than a lossy JavaScript string', async () => {
  const f = await fixture();
  try {
    f.sql.exec("UPDATE writing_brief_versions SET brief_json = CAST(X'FFFE7B00' AS TEXT) WHERE project_id = 'selected'");
    const result = f.service.repairProjectFromBackup('selected', f.backupPath);
    assert.equal(result.status, 'repaired');
    const evidence = JSON.parse(readFileSync(result.evidencePath!, 'utf8'));
    assert.equal(evidence.before.brief.rawJsonHex, 'FFFE7B00');
    assert.ok(f.service.tryProjectProjection('selected'));
  } finally { f.close(); }
});

test('same-version repair retains stable block IDs from an edited draft', async () => {
  const f = await fixture();
  try {
    const project = f.storage.inspectProject('selected')!;
    const saved = f.storage.commitArtifactVersion({ projectId: 'selected', operationId: 'edited-body', expectedProjectRevision: project.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: project.latestBodyVersionId, content: '# selected 原始稿件\n\n新段落。', reason: 'edit', actor });
    assert.equal(saved.ok, true);
    const currentId = f.storage.inspectProject('selected')!.latestBodyVersionId!;
    const expected = f.storage.getBodyDocument(currentId)!;
    assert.equal(expected.blocks[0]!.id, f.storage.getBodyDocument(project.latestBodyVersionId!)!.blocks[0]!.id);
    const updatedBackup = join(f.root, 'edited-backup.sqlite3');
    await f.storage.createBackup(updatedBackup);
    f.sql.prepare('UPDATE body_documents SET document_json = ? WHERE artifact_version_id = ?').run(brokenText, currentId);
    f.service.repairProjectFromBackup('selected', updatedBackup);
    assert.deepEqual(f.storage.getBodyDocument(currentId), expected);
  } finally { f.close(); }
});
