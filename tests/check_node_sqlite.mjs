import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 15)) {
  throw new Error(
    `Writing Agent 1.0 storage requires Node >=24.15.0; current=${process.versions.node}`,
  );
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "writing-agent-sqlite-check-"));
const databasePath = join(temporaryRoot, "source.sqlite3");
const backupPath = join(temporaryRoot, "backup.sqlite3");
let source;
let restored;

try {
  source = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableForeignKeyConstraints: true,
  });
  source.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      project_seq INTEGER NOT NULL,
      UNIQUE (project_id, project_seq)
    ) STRICT;
  `);

  const journalMode = source.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.equal(String(journalMode).toLowerCase(), "wal");
  assert.equal(Number(source.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);

  source.exec("BEGIN IMMEDIATE");
  source.prepare("INSERT INTO projects (id, revision) VALUES (?, ?)").run("project-1", 0);
  source
    .prepare("INSERT INTO events (id, project_id, project_seq) VALUES (?, ?, ?)")
    .run("event-1", "project-1", 1);
  source.exec("COMMIT");

  assert.throws(() => {
    source
      .prepare("INSERT INTO events (id, project_id, project_seq) VALUES (?, ?, ?)")
      .run("event-invalid", "missing-project", 1);
  });
  assert.equal(source.prepare("PRAGMA quick_check").get().quick_check, "ok");

  await backup(source, backupPath);
  restored = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(
    Number(restored.prepare("SELECT COUNT(*) AS count FROM events").get().count),
    1,
  );
  assert.equal(restored.prepare("PRAGMA quick_check").get().quick_check, "ok");

  console.log(`node:sqlite foundation check passed on Node ${process.versions.node}`);
} finally {
  restored?.close();
  source?.close();

  const relativeToTemp = relative(resolve(tmpdir()), resolve(temporaryRoot));
  if (
    relativeToTemp &&
    relativeToTemp !== ".." &&
    !relativeToTemp.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
