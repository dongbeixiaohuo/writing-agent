import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  inspectWorkspaceDatabase,
  openWorkspaceStorage,
  restoreWorkspaceBackup,
  StorageOpenError,
} from "../src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema.js";

const actor = { kind: "user" as const, id: "user-recovery" };

function createProject(
  storage: ReturnType<typeof openWorkspaceStorage>,
  projectId: string,
): void {
  const result = storage.createProject({
    operationId: `create-${projectId}`,
    projectId,
    name: `项目 ${projectId}`,
    mode: "deep",
    actor,
  });
  assert.equal(result.ok, true);
}

describe("workspace recovery boundaries", () => {
  it("reports future and corrupt databases without clearing either file", () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-schema-"));
    const futureWorkspace = join(root, "future");
    let storage = openWorkspaceStorage({ workspacePath: futureWorkspace });
    createProject(storage, "future-project");
    const futureDatabasePath = storage.databasePath;
    storage.close();

    const direct = new DatabaseSync(futureDatabasePath);
    direct.exec("PRAGMA user_version = 999");
    direct.close();
    const futureBytes = readFileSync(futureDatabasePath);

    assert.throws(
      () => openWorkspaceStorage({ workspacePath: futureWorkspace }),
      (error) =>
        error instanceof StorageOpenError && error.code === "SCHEMA_UNSUPPORTED",
    );
    assert.deepEqual(readFileSync(futureDatabasePath), futureBytes);
    const futureInspection = inspectWorkspaceDatabase(futureWorkspace);
    assert.equal(futureInspection.ok, true);
    if (futureInspection.ok) {
      assert.equal(futureInspection.supported, false);
      assert.equal(futureInspection.schemaVersion, 999);
      assert.equal(futureInspection.projectCount, 1);
    }

    const corruptWorkspace = join(root, "corrupt");
    const corruptPath = join(
      corruptWorkspace,
      ".writing-agent",
      "workspace.sqlite3",
    );
    mkdirSync(dirname(corruptPath), { recursive: true });
    const corruptBytes = Buffer.from("definitely-not-a-sqlite-database", "utf8");
    writeFileSync(corruptPath, corruptBytes);

    assert.throws(
      () => openWorkspaceStorage({ workspacePath: corruptWorkspace }),
      (error) =>
        error instanceof StorageOpenError && error.code === "DATABASE_CORRUPT",
    );
    assert.deepEqual(readFileSync(corruptPath), corruptBytes);
    const corruptInspection = inspectWorkspaceDatabase(corruptWorkspace);
    assert.equal(corruptInspection.ok, false);
    if (!corruptInspection.ok) {
      assert.equal(corruptInspection.code, "DATABASE_CORRUPT");
    }

    const emptyWorkspace = join(root, "empty-existing-database");
    const emptyPath = join(
      emptyWorkspace,
      ".writing-agent",
      "workspace.sqlite3",
    );
    mkdirSync(dirname(emptyPath), { recursive: true });
    writeFileSync(emptyPath, Buffer.alloc(0));
    assert.throws(
      () => openWorkspaceStorage({ workspacePath: emptyWorkspace }),
      (error) =>
        error instanceof StorageOpenError && error.code === "DATABASE_CORRUPT",
    );
    assert.equal(statSync(emptyPath).size, 0);

    rmSync(root, { recursive: true, force: true });
  });

  it("keeps read-only and simulated disk-full failures explicit and atomic", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-io-"));
    let storage = openWorkspaceStorage({ workspacePath });
    createProject(storage, "io-project");
    storage.close();

    storage = openWorkspaceStorage({ workspacePath, readOnly: true });
    assert.equal(storage.inspectProject("io-project")?.name, "项目 io-project");
    const rejected = storage.commitArtifactVersion({
      operationId: "readonly-write",
      projectId: "io-project",
      expectedProjectRevision: 0,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "只读连接不能写",
      reason: "只读测试",
      actor,
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "STORAGE_READ_ONLY");
    storage.close();

    storage = openWorkspaceStorage({
      workspacePath,
      faultInjector: (point) => {
        if (point !== "after_artifact_version_insert") return;
        throw Object.assign(new Error("simulated disk full"), {
          code: "SQLITE_FULL",
        });
      },
    });
    const diskFull = storage.commitArtifactVersion({
      operationId: "disk-full-write",
      projectId: "io-project",
      expectedProjectRevision: 0,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "x".repeat(1024 * 1024),
      reason: "磁盘耗尽测试",
      actor,
    });
    assert.equal(diskFull.ok, false);
    if (!diskFull.ok) {
      assert.equal(diskFull.code, "STORAGE_WRITE_FAILED");
      assert.equal(diskFull.details.causeCode, "SQLITE_FULL");
    }
    assert.equal(storage.inspectProject("io-project")?.revision, 0);
    assert.equal(storage.inspectProject("io-project")?.latestBodyVersionId, null);
    assert.equal(storage.listEvents("io-project", 0).length, 1);
    storage.close();

    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("deletes only the exactly confirmed project and preserves idempotency", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-delete-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      createProject(storage, "project-a");
      createProject(storage, "project-b");
      const bodyB = storage.commitArtifactVersion({
        operationId: "body-b",
        projectId: "project-b",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "必须保留",
        reason: "边界测试",
        actor,
      });
      assert.equal(bodyB.ok, true);

      const wrongConfirmation = storage.deleteProject({
        operationId: "delete-a-wrong",
        projectId: "project-a",
        expectedProjectRevision: 0,
        confirmedProjectId: "project-b",
        actor,
      });
      assert.equal(wrongConfirmation.ok, false);
      if (!wrongConfirmation.ok) {
        assert.equal(wrongConfirmation.code, "PROJECT_CONFIRMATION_MISMATCH");
      }
      assert.notEqual(storage.inspectProject("project-a"), null);
      assert.notEqual(storage.inspectProject("project-b"), null);

      const command = {
        operationId: "delete-a",
        projectId: "project-a",
        expectedProjectRevision: 0,
        confirmedProjectId: "project-a",
        actor,
      };
      const deleted = storage.deleteProject(command);
      assert.equal(deleted.ok, true);
      assert.deepEqual(storage.deleteProject(command), deleted);
      assert.equal(storage.inspectProject("project-a"), null);
      assert.equal(storage.listEvents("project-a", 0).length, 0);
      assert.equal(
        storage.listArtifactVersions("project-a", "body", "main").length,
        0,
      );
      assert.equal(storage.inspectProject("project-b")?.revision, 1);
      assert.equal(
        storage.getArtifactVersion(
          bodyB.ok ? bodyB.result.versionId : "unreachable",
        )?.content,
        "必须保留",
      );
      const audit = new DatabaseSync(storage.databasePath, { readOnly: true });
      try {
        const deletedProjectOperations = audit
          .prepare(
            "SELECT command_type FROM operations WHERE project_id = ? ORDER BY rowid",
          )
          .all("project-a") as Array<{ command_type: string }>;
        assert.deepEqual(
          deletedProjectOperations.map((row) => row.command_type),
          ["delete_project"],
        );
        const preservedProjectOperationCount = audit
          .prepare(
            "SELECT COUNT(*) AS count FROM operations WHERE project_id = ?",
          )
          .get("project-b") as { count: number };
        assert.equal(preservedProjectOperationCount.count, 2);
      } finally {
        audit.close();
      }
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("creates online backups and restores only the selected snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-backup-"));
    const sourceWorkspace = join(root, "source");
    const backupOne = join(root, "backups", "before.sqlite3");
    const backupTwo = join(root, "backups", "after.sqlite3");
    const targetOne = join(root, "restore-before");
    const targetTwo = join(root, "restore-after");
    const storage = openWorkspaceStorage({ workspacePath: sourceWorkspace });

    try {
      createProject(storage, "backup-project");
      const firstManifest = await storage.createBackup(backupOne);
      assert.equal(firstManifest.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(firstManifest.sizeBytes, statSync(backupOne).size);
      assert.equal(firstManifest.sha256.length, 64);

      const committed = storage.commitArtifactVersion({
        operationId: "backup-body",
        projectId: "backup-project",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "只应出现在第二份备份",
        reason: "备份选择测试",
        actor,
      });
      assert.equal(committed.ok, true);
      await storage.createBackup(backupTwo);

      await assert.rejects(
        () => storage.createBackup(backupTwo),
        (error) =>
          error instanceof StorageOpenError &&
          error.code === "BACKUP_DESTINATION_EXISTS",
      );

      await restoreWorkspaceBackup({ backupPath: backupOne, targetWorkspacePath: targetOne });
      await restoreWorkspaceBackup({ backupPath: backupTwo, targetWorkspacePath: targetTwo });
    } finally {
      storage.close();
    }

    const restoredBefore = openWorkspaceStorage({ workspacePath: targetOne });
    const restoredAfter = openWorkspaceStorage({ workspacePath: targetTwo });
    try {
      assert.equal(
        restoredBefore.inspectProject("backup-project")?.latestBodyVersionId,
        null,
      );
      assert.equal(
        restoredAfter
          .listArtifactVersions("backup-project", "body", "main")[0]
          ?.content,
        "只应出现在第二份备份",
      );
      await assert.rejects(
        () =>
          restoreWorkspaceBackup({
            backupPath: backupOne,
            targetWorkspacePath: targetTwo,
          }),
        (error) =>
          error instanceof StorageOpenError &&
          error.code === "RESTORE_TARGET_EXISTS",
      );
    } finally {
      restoredBefore.close();
      restoredAfter.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
