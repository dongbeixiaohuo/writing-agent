import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  migrateWorkspaceStorage,
  openWorkspaceStorage,
  StorageOpenError,
} from "../src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema.js";

const actor = { kind: "runtime", id: "migration-test" } as const;

function removeSchemaV7(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX exports_project_idx;
    DROP TABLE exports;
  `);
}

function removeSchemaV6(database: DatabaseSync): void {
  removeSchemaV7(database);
  database.exec(`
    DROP TABLE fact_invalidations;
    DROP TABLE fact_assessments;
    DROP TABLE fact_input_snapshots;
  `);
}

function downgradeFixtureToSchemaV6(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF;");
    removeSchemaV7(database);
    database.exec(`
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (6, '2026-09-17T05:00:00.000Z');
      UPDATE projects SET schema_version = 6;
      PRAGMA user_version = 6;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function removeSchemaV5(database: DatabaseSync): void {
  removeSchemaV6(database);
  database.exec(`
    DROP INDEX block_lock_decisions_project_idx;
    DROP TABLE block_lock_decisions;
    DROP INDEX revision_proposals_project_idx;
    DROP TABLE revision_proposals;
    DROP INDEX body_documents_project_idx;
    DROP TABLE body_documents;
  `);
}

function downgradeFixtureToSchemaV5(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF;");
    removeSchemaV6(database);
    database.exec(`
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (5, '2026-09-17T03:30:00.000Z');
      UPDATE projects SET schema_version = 5;
      PRAGMA user_version = 5;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function recordLegacyPassedFactSnapshot(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO fact_snapshots(
           id, project_id, body_version_id, title_version_id, evidence_version_id,
           status, assessment_json, actor_json, operation_id, created_at
         ) VALUES (?, ?, NULL, NULL, NULL, 'passed', ?, ?, ?, ?)`,
      )
      .run(
        "legacy-fact-passed",
        "project-1",
        JSON.stringify({ status: "passed", schemaVersion: "legacy" }),
        JSON.stringify(actor),
        "legacy-fact-operation",
        "2026-09-17T03:45:00.000Z",
      );
    database
      .prepare(
        `UPDATE projects
            SET fact_gate_status = 'passed', current_fact_snapshot_id = ?
          WHERE id = ?`,
      )
      .run("legacy-fact-passed", "project-1");
  } finally {
    database.close();
  }
}

function removeSchemaV4(database: DatabaseSync): void {
  removeSchemaV5(database);
  database.exec(`
    DROP INDEX decisions_project_idx;
    DROP TABLE decisions;
    DROP INDEX writing_brief_versions_project_idx;
    DROP TABLE writing_brief_versions;
    DROP INDEX materials_project_idx;
    DROP TABLE materials;
    ALTER TABLE projects DROP COLUMN current_brief_version_id;
  `);
}

function downgradeFixtureToSchemaV4(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF;");
    removeSchemaV5(database);
    database.exec(`
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (4, '2026-09-17T02:00:00.000Z');
      UPDATE projects SET schema_version = 4;
      PRAGMA user_version = 4;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function downgradeFixtureToSchemaV1(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
    `);
    removeSchemaV4(database);
    database.exec(`
      DROP INDEX runtime_operations_run_idx;
      DROP TABLE runtime_operations;
      DROP INDEX events_run_idx;
      ALTER TABLE events DROP COLUMN run_id;
      DROP TABLE request_snapshots;
      DROP TABLE runs;
      DROP TABLE sessions;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (1, '2026-09-16T00:00:00.000Z');
      UPDATE projects SET schema_version = 1;
      PRAGMA user_version = 1;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function downgradeFixtureToSchemaV2(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
    `);
    removeSchemaV4(database);
    database.exec(`
      DROP INDEX runtime_operations_run_idx;
      DROP TABLE runtime_operations;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (2, '2026-09-16T00:00:00.000Z');
      UPDATE runs SET budget_json = 'null', usage_json = 'null';
      UPDATE projects SET schema_version = 2;
      PRAGMA user_version = 2;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

function downgradeFixtureToSchemaV3(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF;");
    removeSchemaV4(database);
    database.exec(`
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version, applied_at)
        VALUES (3, '2026-09-16T00:00:00.000Z');
      UPDATE projects SET schema_version = 3;
      PRAGMA user_version = 3;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    database.close();
  }
}

describe("ordered workspace schema migration", () => {
  it("backs up schema v1, verifies it, and preserves project data while adding runtime tables", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-"));
    const backupPath = join(workspacePath, "migration-backup-v1.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    try {
      assert.equal(
        initial.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "迁移保留项目",
          mode: "deep",
          actor,
        }).ok,
        true,
      );
      assert.equal(
        initial.commitArtifactVersion({
          operationId: "create-body",
          projectId: "project-1",
          expectedProjectRevision: 0,
          kind: "body",
          logicalKey: "main",
          baseVersionId: null,
          content: "迁移前正文",
          reason: "migration fixture",
          actor,
        }).ok,
        true,
      );
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV1(databasePath);

    assert.throws(
      () => openWorkspaceStorage({ workspacePath }),
      (error) =>
        error instanceof StorageOpenError &&
        error.code === "SCHEMA_MIGRATION_REQUIRED",
    );

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-16T10:00:00.000Z",
      });
      assert.equal(migrated.fromVersion, 1);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(migrated.backup.schemaVersion, 1);
      assert.equal(migrated.backup.path, backupPath);
      assert.equal(migrated.backup.sha256.length, 64);
      assert.equal(existsSync(backupPath), true);

      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try {
        assert.equal(
          (backup.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
          1,
        );
        assert.equal(
          backup
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name='request_snapshots'",
            )
            .get(),
          undefined,
        );
      } finally {
        backup.close();
      }

      const storage = openWorkspaceStorage({ workspacePath });
      try {
        assert.equal(
          storage.inspectProject("project-1")?.schemaVersion,
          CURRENT_SCHEMA_VERSION,
        );
        assert.equal(
          storage.listArtifactVersions("project-1", "body", "main")[0]?.content,
          "迁移前正文",
        );
        const session = storage.createSession({
          sessionId: "session-after-migration",
          projectId: "project-1",
          purpose: "draft",
        });
        assert.equal(session.projectId, "project-1");
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("backs up and migrates schema v2 to the runtime operation ledger without losing sessions", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-v2-"));
    const backupPath = join(workspacePath, "migration-backup-v2.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    try {
      assert.equal(
        initial.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "v2 runtime data",
          mode: "quick",
          actor,
        }).ok,
        true,
      );
      initial.createSession({
        sessionId: "session-1",
        projectId: "project-1",
        purpose: "draft",
      });
      initial.startRun({
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        planVersion: "v2-fixture",
      });
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV2(databasePath);

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-16T11:00:00.000Z",
      });
      assert.equal(migrated.fromVersion, 2);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(migrated.backup.schemaVersion, 2);

      const storage = openWorkspaceStorage({ workspacePath });
      try {
        assert.equal(storage.getSession("session-1")?.projectId, "project-1");
        assert.equal(storage.getRun("run-1")?.status, "running");
        assert.deepEqual(storage.getRun("run-1")?.budget, {
          maxMajorRevisions: 2,
          maxModelRequests: 24,
          maxRetriesPerRequest: 2,
          maxToolCalls: 32,
        });
        assert.equal(storage.getRun("run-1")?.usage.modelRequests, 0);
        assert.deepEqual(storage.listRuntimeOperations("run-1"), []);
        storage.prepareRuntimeOperation({
          operationId: "op-after-migration",
          projectId: "project-1",
          runId: "run-1",
          kind: "tool_call",
          effect: "read_only",
          input: { callId: "call-1" },
        });
        assert.equal(storage.listRuntimeOperations("run-1").length, 1);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("backs up and migrates schema v3 before adding writing inputs", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-v3-"));
    const backupPath = join(workspacePath, "migration-backup-v3.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    try {
      assert.equal(
        initial.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "v3 writing inputs",
          mode: "deep",
          actor,
        }).ok,
        true,
      );
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV3(databasePath);

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-17T01:00:00.000Z",
      });
      assert.equal(migrated.fromVersion, 3);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(migrated.backup.schemaVersion, 3);

      const storage = openWorkspaceStorage({ workspacePath });
      try {
        assert.equal(
          storage.inspectProject("project-1")?.currentBriefVersionId,
          null,
        );
        const imported = storage.importMaterial({
          operationId: "import-after-migration",
          projectId: "project-1",
          expectedProjectRevision: 0,
          materialId: "material-1",
          displayName: "迁移后材料",
          sourceKind: "pasted_text",
          sourceReference: null,
          role: "source_verified",
          trustLabel: "user_provided_untrusted",
          permissionScope: "project_only",
          content: "迁移后可写入材料。",
          actor,
        });
        assert.equal(imported.ok, true);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("migrates schema v4 and backfills block documents for existing bodies", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-v4-"));
    const backupPath = join(workspacePath, "migration-backup-v4.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    let versionId = "";
    try {
      initial.createProject({
        operationId: "create-project",
        projectId: "project-1",
        name: "v4 body backfill",
        mode: "deep",
        actor,
      });
      const committed = initial.commitArtifactVersion({
        operationId: "body-before-v5",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 旧正文\n\n迁移后需要稳定块。",
        reason: "v4 fixture",
        actor,
      });
      assert.equal(committed.ok, true);
      if (committed.ok) versionId = committed.result.versionId;
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV4(databasePath);

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-17T03:00:00.000Z",
      });
      assert.equal(migrated.fromVersion, 4);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      const storage = openWorkspaceStorage({ workspacePath });
      try {
        const document = storage.getBodyDocument(versionId);
        assert.equal(document?.content, "# 旧正文\n\n迁移后需要稳定块。");
        assert.equal(document?.blocks.length, 2);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("migrates schema v5 to immutable fact-check snapshots without losing projects", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-v5-"));
    const backupPath = join(workspacePath, "migration-backup-v5.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    try {
      assert.equal(
        initial.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "v5 fact migration",
          mode: "deep",
          actor,
        }).ok,
        true,
      );
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV5(databasePath);
    recordLegacyPassedFactSnapshot(databasePath);

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-17T04:00:00.000Z",
      });
      assert.equal(migrated.fromVersion, 5);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(migrated.backup.schemaVersion, 5);

      const storage = openWorkspaceStorage({ workspacePath });
      try {
        assert.equal(
          storage.inspectProject("project-1")?.schemaVersion,
          CURRENT_SCHEMA_VERSION,
        );
        assert.equal(storage.inspectProject("project-1")?.factGateStatus, "stale");
        assert.deepEqual(storage.getFactCheckStatus("project-1"), {
          status: "stale",
          currentSnapshotId: "legacy-fact-passed",
          snapshot: null,
          assessment: null,
          invalidations: [],
        });
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("migrates schema v6 to durable export records without losing projects", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-migrate-v6-"));
    const backupPath = join(workspacePath, "migration-backup-v6.sqlite3");
    const initial = openWorkspaceStorage({ workspacePath });
    const databasePath = initial.databasePath;
    try {
      assert.equal(
        initial.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "v6 export migration",
          mode: "deep",
          actor,
        }).ok,
        true,
      );
    } finally {
      initial.close();
    }
    downgradeFixtureToSchemaV6(databasePath);

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath,
        backupPath,
        clock: () => "2026-09-17T05:30:00.000Z",
      });
      assert.equal(migrated.fromVersion, 6);
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(migrated.backup.schemaVersion, 6);

      const storage = openWorkspaceStorage({ workspacePath });
      try {
        assert.equal(
          storage.inspectProject("project-1")?.schemaVersion,
          CURRENT_SCHEMA_VERSION,
        );
        assert.deepEqual(storage.listExports("project-1"), []);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
