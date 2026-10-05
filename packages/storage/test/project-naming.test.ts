import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { migrateWorkspaceStorage, openWorkspaceStorage } from "../src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema.js";

const actor = { kind: "user", id: "project-naming-test" } as const;

describe("project naming", () => {
  it("lets the intake agent replace a placeholder once and never overwrite a manual name", () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-project-name-"));
    const storage = openWorkspaceStorage({ workspacePath: root });
    try {
      assert.equal(storage.createProject({
        operationId: "create",
        projectId: "project",
        name: "新写作项目",
        nameSource: "placeholder",
        mode: "deep",
        actor,
      }).ok, true);

      const generated = storage.renameProject({
        operationId: "agent-name-1",
        projectId: "project",
        name: "企业 AI 交付实践",
        source: "agent",
        actor: { kind: "agent", id: "conversation-intake", runId: "run-1" },
      });
      assert.equal(generated.ok && generated.result.applied, true);
      assert.equal(storage.inspectProject("project")?.name, "企业 AI 交付实践");

      const repeatedAgent = storage.renameProject({
        operationId: "agent-name-2",
        projectId: "project",
        name: "不应覆盖的后续名称",
        source: "agent",
        actor: { kind: "agent", id: "conversation-intake", runId: "run-2" },
      });
      assert.equal(repeatedAgent.ok && repeatedAgent.result.applied, false);
      assert.equal(storage.inspectProject("project")?.name, "企业 AI 交付实践");

      const manual = storage.renameProject({
        operationId: "manual-name",
        projectId: "project",
        name: "客户指定项目名",
        source: "manual",
        actor,
      });
      assert.equal(manual.ok && manual.result.applied, true);

      const lateAgent = storage.renameProject({
        operationId: "late-agent-name",
        projectId: "project",
        name: "迟到的自动名称",
        source: "agent",
        actor: { kind: "agent", id: "conversation-intake", runId: "run-1" },
      });
      assert.equal(lateAgent.ok && lateAgent.result.applied, false);
      assert.equal(storage.inspectProject("project")?.name, "客户指定项目名");
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats callers and migrated schema-v7 projects as user-owned legacy names", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-project-name-migration-"));
    const databasePath = join(root, ".writing-agent", "workspace.sqlite3");
    let storage: ReturnType<typeof openWorkspaceStorage> | undefined = openWorkspaceStorage({ workspacePath: root });
    try {
      assert.equal(storage.createProject({
        operationId: "legacy-create",
        projectId: "legacy-project",
        name: "旧项目名称",
        mode: "quick",
        actor,
      }).ok, true);
    } finally {
      storage.close();
      storage = undefined;
    }

    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        ALTER TABLE projects DROP COLUMN name_source;
        DELETE FROM schema_migrations;
        INSERT INTO schema_migrations(version, applied_at) VALUES (7, '2026-10-04T00:00:00.000Z');
        UPDATE projects SET schema_version = 7;
        PRAGMA user_version = 7;
      `);
    } finally {
      database.close();
    }

    try {
      const migrated = await migrateWorkspaceStorage({
        workspacePath: root,
        backupPath: join(root, "schema-v7-backup.sqlite3"),
        clock: () => "2026-10-04T01:00:00.000Z",
      });
      assert.equal(migrated.toVersion, CURRENT_SCHEMA_VERSION);
      storage = openWorkspaceStorage({ workspacePath: root });
      const ignored = storage.renameProject({
        operationId: "legacy-agent-name",
        projectId: "legacy-project",
        name: "不应替换旧项目",
        source: "agent",
        actor: { kind: "agent", id: "conversation-intake", runId: "run-legacy" },
      });
      assert.equal(ignored.ok && ignored.result.applied, false);
      assert.equal(storage.inspectProject("legacy-project")?.name, "旧项目名称");
    } finally {
      storage?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
