import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openWorkspaceStorage, StorageOpenError } from "../../../packages/storage/src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../../../packages/storage/src/schema.js";
import { describeDesktopStartupFailure, recordDesktopStartupFailure, startDesktopApplicationHost } from "../src/startup.js";

function makeV7Workspace(root: string): string {
  const storage = openWorkspaceStorage({ workspacePath: root });
  const actor = { kind: "user", id: "upgrade-test" } as const;
  try {
    assert.equal(storage.createProject({ operationId: "create", projectId: "existing-project",
      name: "已有写作项目", mode: "deep", actor }).ok, true);
    assert.equal(storage.commitArtifactVersion({ operationId: "body", projectId: "existing-project",
      expectedProjectRevision: 0, kind: "body", logicalKey: "main", baseVersionId: null,
      content: "# 已保存的文章\n\n升级不能丢失这一段。", reason: "upgrade fixture", actor }).ok, true);
  } finally { storage.close(); }
  const path = join(root, ".writing-agent", "workspace.sqlite3");
  const db = new DatabaseSync(path);
  try {
    db.exec(`ALTER TABLE projects DROP COLUMN name_source;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at) VALUES (7, '2026-10-04T00:00:00.000Z');
      UPDATE projects SET schema_version = 7;
      PRAGMA user_version = 7;`);
  } finally { db.close(); }
  return path;
}

const options = (root: string) => ({ workspacePath: root, providerProfilePath: join(root, "provider.json") });
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("desktop startup upgrades a populated v7 workspace before opening the host, preserving a verified backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-startup-upgrade-"));
  try {
    const path = makeV7Workspace(root);
    // The original RC69 constructor fails on this exact persisted state.
    assert.throws(() => openWorkspaceStorage({ workspacePath: root, readOnly: true }),
      (error) => error instanceof StorageOpenError && error.code === "SCHEMA_MIGRATION_REQUIRED");
    const host = await startDesktopApplicationHost(options(root));
    try {
      assert.equal((await host.bridge.handshake()).persistsUserProjects, true);
      assert.equal(host.bridge.getSnapshot().projects[0]?.name, "已有写作项目");
    } finally { host.close(); }
    const backupRoot = join(root, ".writing-agent", "backups");
    const backups = readdirSync(backupRoot).filter(name => name.endsWith(".sqlite3"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(backupRoot, backups[0]!), { readOnly: true });
    const current = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 7);
      assert.equal(backup.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      assert.equal(current.prepare("PRAGMA user_version").get()!.user_version, CURRENT_SCHEMA_VERSION);
      assert.deepEqual(current.prepare("SELECT id, content FROM artifact_versions ORDER BY id").all(),
        backup.prepare("SELECT id, content FROM artifact_versions ORDER BY id").all());
      assert.equal(current.prepare("SELECT name_source FROM projects").get()!.name_source, "legacy");
    } finally { backup.close(); current.close(); }
    const reopened = await startDesktopApplicationHost(options(root));
    reopened.close();
    assert.equal(readdirSync(backupRoot).filter(name => name.endsWith(".sqlite3")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup errors are actionable, persisted, and never log raw exceptions or secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "wa-startup-log-"));
  try {
    const error = new StorageOpenError("SCHEMA_UNSUPPORTED", "api-key=secret; private article");
    const failure = describeDesktopStartupFailure(error);
    assert.equal(failure.code, "SCHEMA_UNSUPPORTED");
    assert.match(failure.message, /更新版本/u);
    const log = recordDesktopStartupFailure(error, root, "test-build");
    recordDesktopStartupFailure(new Error("api-key=another-secret"), root, "test-build");
    const contents = readFileSync(log, "utf8");
    assert.doesNotMatch(contents, /secret|private article/u);
    const records = contents.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.map(row => row.code), ["SCHEMA_UNSUPPORTED", "DESKTOP_START_FAILED"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Electron startup uses the migration-aware host and reports failures instead of silently exiting", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /host = await startDesktopApplicationHost\(/u);
  assert.doesNotMatch(main, /host = new DesktopApplicationHost\(/u);
  assert.match(main, /recordDesktopStartupFailure\(/u);
  assert.match(main, /dialog\.showErrorBox\(/u);
});

test("desktop startup creates a fresh workspace without a migration backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-startup-new-"));
  try {
    const host = await startDesktopApplicationHost(options(root));
    host.close();
    assert.equal(existsSync(join(root, ".writing-agent", "backups")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desktop startup never resets corrupt or future-schema databases", async () => {
  for (const kind of ["corrupt", "future"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wa-startup-reject-"));
    try {
      const path = makeV7Workspace(root);
      if (kind === "corrupt") writeFileSync(path, "not a database");
      else {
        const db = new DatabaseSync(path);
        db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1};`);
        db.close();
      }
      const before = digest(path);
      await assert.rejects(startDesktopApplicationHost(options(root)), (error) =>
        error instanceof StorageOpenError && error.code === (kind === "corrupt" ? "DATABASE_CORRUPT" : "SCHEMA_UNSUPPORTED"));
      assert.equal(digest(path), before);
      assert.equal(existsSync(join(root, ".writing-agent", "backups")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("desktop startup does not migrate if a backup cannot be created", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-startup-backup-fail-"));
  try {
    const path = makeV7Workspace(root);
    writeFileSync(join(root, ".writing-agent", "backups"), "fixture blocks backup directory");
    const before = digest(path);
    await assert.rejects(startDesktopApplicationHost(options(root)));
    assert.equal(digest(path), before);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 7); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
