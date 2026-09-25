import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../src/index.js";
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION } from "../src/schema.js";

describe("workspace SQLite schema", () => {
  it("pins the application/schema IDs and creates strict source-of-truth tables", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-schema-contract-"));
    const storage = openWorkspaceStorage({ workspacePath });
    storage.close();

    const database = new DatabaseSync(storage.databasePath, { readOnly: true });
    try {
      assert.equal(
        (database.prepare("PRAGMA application_id").get() as {
          application_id: number;
        }).application_id,
        APPLICATION_ID,
      );
      assert.equal(
        (database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        CURRENT_SCHEMA_VERSION,
      );
      assert.equal(
        (database.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        }).journal_mode,
        "wal",
      );

      const tableRows = database.prepare("PRAGMA table_list").all() as Array<{
        name: string;
        strict: number;
      }>;
      const expectedTables = [
        "schema_migrations",
        "projects",
        "operations",
        "sessions",
        "runs",
        "request_snapshots",
        "runtime_operations",
        "materials",
        "writing_brief_versions",
        "decisions",
        "artifacts",
        "artifact_versions",
        "body_documents",
        "revision_proposals",
        "block_lock_decisions",
        "fact_snapshots",
        "fact_input_snapshots",
        "fact_assessments",
        "fact_invalidations",
        "exports",
        "events",
        "provenance_edges",
      ];
      for (const name of expectedTables) {
        const table = tableRows.find((row) => row.name === name);
        assert.notEqual(table, undefined, `missing table ${name}`);
        assert.equal(table?.strict, 1, `${name} must be STRICT`);
      }

      const versionColumns = database
        .prepare("PRAGMA table_info(artifact_versions)")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of [
        "content",
        "content_hash",
        "actor_json",
        "parent_version_ids_json",
        "reason",
        "request_snapshot_id",
        "created_event_seq",
        "created_at",
      ]) {
        assert.ok(versionColumns.includes(column), `missing version column ${column}`);
      }
      const runColumns = database
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of [
        "budget_json",
        "usage_json",
        "last_committed_event_seq",
        "stop_reason",
      ]) {
        assert.ok(runColumns.includes(column), `missing run column ${column}`);
      }
      const projectColumns = database
        .prepare("PRAGMA table_info(projects)")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.ok(projectColumns.includes("current_brief_version_id"));
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
