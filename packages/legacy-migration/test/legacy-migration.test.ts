import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  applyLegacyMigration,
  LegacyMigrationError,
  planLegacyMigration,
  rollbackLegacyMigration,
} from "../src/index.js";
import { openWorkspaceStorage, restoreWorkspaceBackup } from "../../storage/src/index.js";
import { WritingApplicationService } from "../../application/src/index.js";
import { ApplicationClientBridge } from "../../client-bridge/src/application-bridge.js";

const FIXTURES = resolve("tests", "fixtures", "legacy");

function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      hash.update(path.slice(root.length).replaceAll("\\", "/"));
      if (entry.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function createDesktopFixture(root: string): {
  databasePath: string;
  artifactsRoot: string;
  projectDirectory: string;
} {
  const databasePath = join(root, "writing-agent.db");
  const artifactsRoot = join(root, "workspace");
  const projectDirectory = join(artifactsRoot, "2026-09-16-synthetic-project");
  mkdirSync(projectDirectory, { recursive: true });
  const project = JSON.parse(
    readFileSync(join(FIXTURES, "desktop-v0.1.0", "project.json"), "utf8"),
  ) as {
    id: string;
    slug: string;
    title: string;
    mode: string;
    topic: string;
    audience: string;
    wordTarget: number;
    styleProfileId: string | null;
    modelProfileId: string;
    currentStage: string;
    status: string;
    workspacePath: string;
    createdAt: string;
    updatedAt: string;
  };
  project.styleProfileId = "legacy-style-fixture";
  project.workspacePath = "C:\\legacy\\workspace\\2026-09-16-synthetic-project";
  writeFileSync(join(projectDirectory, "project.json"), JSON.stringify(project, null, 2), "utf8");

  const outputs = [
    { id: "output-research-1", stage: "research", version: 1, file: "02_research.v1.md", markdown: "# 合成证据\n\n来源状态未知。" },
    { id: "output-titles-1", stage: "titles", version: 1, file: "04_titles.v1.md", markdown: "# 合成标题候选\n\n- 合成桌面项目" },
    { id: "output-draft-1", stage: "draft", version: 1, file: "draft.v1.md", markdown: "# 合成桌面项目\n\n这是旧桌面初稿。" },
    { id: "output-humanize-1", stage: "humanize", version: 1, file: "final.v1.md", markdown: "# 合成桌面项目\n\n这是旧桌面最终稿。" },
  ] as const;
  for (const output of outputs) {
    writeFileSync(join(projectDirectory, output.file), output.markdown, "utf8");
  }
  writeFileSync(join(root, "secrets.json"), JSON.stringify({ key: "fixture-secret-must-not-migrate" }), "utf8");

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(readFileSync(join(FIXTURES, "desktop-v0.1.0", "schema.sql"), "utf8"));
    database.prepare(
      `INSERT INTO writing_projects(
         id, slug, title, mode, topic, audience, word_target, style_profile_id,
         model_profile_id, current_stage, status, is_archived, archived_at,
         workspace_path, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.id,
      project.slug,
      project.title,
      project.mode,
      project.topic,
      project.audience,
      project.wordTarget,
      project.styleProfileId,
      project.modelProfileId,
      project.currentStage,
      project.status,
      0,
      null,
      project.workspacePath,
      project.createdAt,
      project.updatedAt,
    );
    const insertOutput = database.prepare(
      `INSERT INTO stage_outputs(
         id, project_id, run_id, stage_key, version, summary, word_count,
         markdown, structured_json, raw_text, artifact_path, status,
         usage_json, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '{}', NULL, ?, 'generated', NULL, ?, ?)`,
    );
    outputs.forEach((output, index) => {
      const time = `2026-09-16T0${index}:00:00+08:00`;
      insertOutput.run(
        output.id,
        project.id,
        output.stage,
        output.version,
        `${output.stage} summary`,
        output.markdown.length,
        output.markdown,
        `C:\\legacy\\workspace\\${String(project.slug)}\\${output.file}`,
        time,
        time,
      );
    });
  } finally {
    database.close();
  }
  return { databasePath, artifactsRoot, projectDirectory };
}

describe("legacy migration planning", () => {
  it("dry-runs a manifest project without creating the target workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-plan-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const plan = planLegacyMigration({
        source: { kind: "manifest", projectPath: sourcePath },
        targetWorkspacePath,
        clock: () => "2026-09-18T00:00:00.000Z",
      });

      assert.equal(plan.schemaVersion, 1);
      assert.equal(plan.source.kind, "manifest");
      assert.equal(plan.projects.length, 1);
      assert.equal(plan.projects[0]?.legacyFactStatus, "stale");
      assert.equal(plan.projects[0]?.migratedFactStatus, "not_checked");
      assert.equal(plan.projects[0]?.authorAttribution, "unknown/legacy_import");
      assert.equal(plan.credentialDisposition, "excluded_requires_explicit_consent");
      assert.equal(plan.spaceCheck.ok, true);
      assert.equal(existsSync(targetWorkspacePath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-runs the observed desktop 0.1 schema without reading its secret file", () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-desktop-plan-"));
    const source = createDesktopFixture(join(root, "legacy-desktop"));
    const targetWorkspacePath = join(root, "target-workspace");

    try {
      const plan = planLegacyMigration({
        source: { kind: "desktop_v0_1", databasePath: source.databasePath, artifactsRoot: source.artifactsRoot },
        targetWorkspacePath,
      });

      assert.equal(plan.source.kind, "desktop_v0_1");
      assert.equal(plan.projects.length, 1);
      assert.equal(plan.projects[0]?.artifactCount, 4);
      assert.equal(plan.projects[0]?.styleStatus, "legacy_unknown");
      assert.equal(plan.projects[0]?.migratedFactStatus, "not_checked");
      assert.equal(plan.credentialDisposition, "excluded_requires_explicit_consent");
      assert.equal(JSON.stringify(plan).includes("fixture-secret-must-not-migrate"), false);
      assert.equal(existsSync(targetWorkspacePath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports insufficient target space during dry-run and refuses to create a workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-space-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const plan = planLegacyMigration({
        source: { kind: "manifest", projectPath: sourcePath },
        targetWorkspacePath,
        spaceProbe: () => 0,
      });
      assert.equal(plan.spaceCheck.ok, false);
      await assert.rejects(
        () => applyLegacyMigration({ plan, spaceProbe: () => 0 }),
        (error) => error instanceof LegacyMigrationError && error.code === "TARGET_SPACE_INSUFFICIENT",
      );
      assert.equal(existsSync(targetWorkspacePath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails a stale dry-run before any backup or target write", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-stale-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      appendFileSync(join(sourcePath, "draft_v3.md"), "\nsource changed after scan\n", "utf8");
      await assert.rejects(
        () => applyLegacyMigration({ plan }),
        (error) => error instanceof LegacyMigrationError && error.code === "MIGRATION_PLAN_STALE",
      );
      assert.equal(existsSync(targetWorkspacePath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies an invalid or unwritable target before creating migration state", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-readonly-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-is-a-file");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    writeFileSync(targetWorkspacePath, "keep-target-sentinel", "utf8");
    const beforeHash = treeHash(sourcePath);

    try {
      const plan = planLegacyMigration({
        source: { kind: "manifest", projectPath: sourcePath },
        targetWorkspacePath,
      });
      await assert.rejects(
        () => applyLegacyMigration({ plan }),
        (error) =>
          error instanceof LegacyMigrationError &&
          error.code === "TARGET_NOT_WRITABLE",
      );
      assert.equal(readFileSync(targetWorkspacePath, "utf8"), "keep-target-sentinel");
      assert.equal(treeHash(sourcePath), beforeHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects future and corrupt desktop databases without changing either source", () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-desktop-invalid-"));
    try {
      const future = createDesktopFixture(join(root, "future"));
      const futureDb = new DatabaseSync(future.databasePath);
      futureDb.exec("PRAGMA user_version = 9");
      futureDb.close();
      const futureBytes = readFileSync(future.databasePath);
      assert.throws(
        () => planLegacyMigration({
          source: { kind: "desktop_v0_1", databasePath: future.databasePath, artifactsRoot: future.artifactsRoot },
          targetWorkspacePath: join(root, "future-target"),
        }),
        (error) => error instanceof LegacyMigrationError && error.code === "LEGACY_SCHEMA_UNSUPPORTED",
      );
      assert.deepEqual(readFileSync(future.databasePath), futureBytes);

      const corruptRoot = join(root, "corrupt");
      const corruptArtifacts = join(corruptRoot, "workspace");
      mkdirSync(corruptArtifacts, { recursive: true });
      const corruptPath = join(corruptRoot, "writing-agent.db");
      const corruptBytes = Buffer.from("not-a-sqlite-database", "utf8");
      writeFileSync(corruptPath, corruptBytes);
      assert.throws(
        () => planLegacyMigration({
          source: { kind: "desktop_v0_1", databasePath: corruptPath, artifactsRoot: corruptArtifacts },
          targetWorkspacePath: join(root, "corrupt-target"),
        }),
        (error) => error instanceof LegacyMigrationError && error.code === "LEGACY_DATABASE_CORRUPT",
      );
      assert.deepEqual(readFileSync(corruptPath), corruptBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy manifest migration", () => {
  it("backs up the selected source before importing and leaves every source byte unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-apply-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    const beforeHash = treeHash(sourcePath);

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      const report = await applyLegacyMigration({ plan });

      assert.equal(report.status, "completed");
      assert.equal(report.sourceUnchanged, true);
      assert.equal(treeHash(sourcePath), beforeHash);
      assert.equal(existsSync(report.sourceBackupPath), true);
      assert.equal(existsSync(report.reportPath), true);

      const storage = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      try {
        assert.equal(storage.listProjects().length, 1);
        const projectId = plan.projects[0]?.targetProjectId ?? "";
        const project = storage.inspectProject(projectId);
        assert.equal(project?.factGateStatus, "not_checked");
        const bodies = storage.listArtifactVersions(projectId, "body", "main");
        assert.equal(bodies.length, 1);
        assert.match(bodies[0]?.content ?? "", /用于迁移回归的合成文本/);
        assert.equal(bodies[0]?.actor.kind, "legacy_import");
      } finally {
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the persisted completion report when an already completed plan is applied again", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-repeat-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      const first = await applyLegacyMigration({
        plan,
        clock: () => "2026-09-18T01:00:00.000Z",
      });
      const repeated = await applyLegacyMigration({
        plan,
        clock: () => "2026-09-18T02:00:00.000Z",
      });
      assert.deepEqual(repeated, first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to resume from a source backup whose contents changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-backup-tamper-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    const sourceBefore = treeHash(sourcePath);

    try {
      const plan = planLegacyMigration({
        source: { kind: "manifest", projectPath: sourcePath },
        targetWorkspacePath,
      });
      await assert.rejects(
        () =>
          applyLegacyMigration({
            plan,
            checkpoint: (name) => {
              if (name === "source-backup.completed") {
                throw new Error("fixture interruption after source backup");
              }
            },
          }),
        /fixture interruption after source backup/,
      );
      appendFileSync(
        join(
          targetWorkspacePath,
          ".writing-agent",
          "legacy-imports",
          plan.importId,
          "source-backup",
          "files",
          "draft_v3.md",
        ),
        "\ntampered backup\n",
        "utf8",
      );

      await assert.rejects(
        () => applyLegacyMigration({ plan }),
        (error) =>
          error instanceof LegacyMigrationError &&
          error.code === "SOURCE_BACKUP_HASH_MISMATCH",
      );
      assert.equal(treeHash(sourcePath), sourceBefore);
      assert.equal(
        existsSync(join(targetWorkspacePath, ".writing-agent", "workspace.sqlite3")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a legacy passed claim in the report but never upgrades the imported project", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-pass-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    cpSync(
      join(sourcePath, "legacy_unbound_pass.json"),
      join(sourcePath, "run_manifest.json"),
    );

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      assert.equal(plan.projects[0]?.legacyFactStatus, "passed");
      const report = await applyLegacyMigration({ plan });
      assert.equal(report.projects[0]?.legacyFactStatus, "passed");
      assert.equal(report.projects[0]?.factGateStatus, "not_checked");

      const storage = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      try {
        assert.equal(
          storage.inspectProject(plan.projects[0]?.targetProjectId ?? "")?.factGateStatus,
          "not_checked",
        );
      } finally {
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens an imported project through the new bridge without loading the old application", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-ui-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      await applyLegacyMigration({ plan });
      const storage = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      const service = new WritingApplicationService({ storage });
      const importedProjectId = plan.projects[0]?.targetProjectId;
      assert.notEqual(importedProjectId, undefined);
      const bridge = new ApplicationClientBridge({
        service,
        workspaceId: "migration-ui-test",
        initialProjectId: importedProjectId ?? "",
        model: {
          model: "not-used",
          providerLabel: "未配置",
          credentialReference: null,
          parameters: { temperature: 0 },
        },
      });
      try {
        const snapshot = bridge.getSnapshot();
        assert.equal(snapshot.selectedProjectId, importedProjectId);
        assert.match(snapshot.previewDocument.body, /用于迁移回归的合成文本/);
        assert.equal(snapshot.revisionWorkspace.versions[0]?.actorLabel, "旧数据导入");
        assert.equal(snapshot.factCheckWorkspace.status, "not_checked");
        assert.equal(snapshot.deliveryWorkspace.formalExportEnabled, false);
      } finally {
        bridge.dispose();
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs up an existing target and resumes an interrupted import without duplicate versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-retry-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    const restoredBeforePath = join(root, "restored-before");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    const existing = openWorkspaceStorage({ workspacePath: targetWorkspacePath });
    try {
      assert.equal(
        existing.createProject({
          operationId: "existing-project-create",
          projectId: "existing-project",
          name: "Existing target project",
          mode: "quick",
          actor: { kind: "user", id: "fixture" },
        }).ok,
        true,
      );
    } finally {
      existing.close();
    }

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      await assert.rejects(
        () => applyLegacyMigration({
          plan,
          checkpoint: (name) => {
            if (name.endsWith(":artifact:1")) throw new Error("fixture interruption");
          },
        }),
        /fixture interruption/,
      );

      const report = await applyLegacyMigration({ plan });
      assert.notEqual(report.targetPreImportBackupPath, null);
      assert.equal(existsSync(report.targetPreImportBackupPath ?? ""), true);
      await restoreWorkspaceBackup({
        backupPath: report.targetPreImportBackupPath ?? "",
        targetWorkspacePath: restoredBeforePath,
      });
      const restored = openWorkspaceStorage({ workspacePath: restoredBeforePath, readOnly: true });
      try {
        assert.deepEqual(restored.listProjects().map((project) => project.id), ["existing-project"]);
      } finally {
        restored.close();
      }

      const migrated = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      try {
        const importedProjectId = plan.projects[0]?.targetProjectId ?? "";
        assert.equal(migrated.listProjects().length, 2);
        assert.equal(migrated.listArtifactVersions(importedProjectId, "body", "main").length, 1);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back only the explicitly confirmed imported project", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-legacy-rollback-"));
    const sourcePath = join(root, "source-project");
    const targetWorkspacePath = join(root, "target-workspace");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });
    const existing = openWorkspaceStorage({ workspacePath: targetWorkspacePath });
    try {
      assert.equal(existing.createProject({
        operationId: "keep-project-create",
        projectId: "keep-project",
        name: "Keep me",
        mode: "quick",
        actor: { kind: "user", id: "fixture" },
      }).ok, true);
    } finally {
      existing.close();
    }

    try {
      const plan = planLegacyMigration({ source: { kind: "manifest", projectPath: sourcePath }, targetWorkspacePath });
      const report = await applyLegacyMigration({ plan });
      const importedProjectId = plan.projects[0]?.targetProjectId ?? "";

      assert.throws(
        () => rollbackLegacyMigration({
          workspacePath: targetWorkspacePath,
          reportPath: report.reportPath,
          confirmedProjectId: "keep-project",
        }),
        (error) => error instanceof LegacyMigrationError && error.code === "ROLLBACK_CONFIRMATION_MISMATCH",
      );
      const rollback = rollbackLegacyMigration({
        workspacePath: targetWorkspacePath,
        reportPath: report.reportPath,
        confirmedProjectId: importedProjectId,
      });
      assert.equal(rollback.deletedProjectId, importedProjectId);
      assert.equal(existsSync(rollback.receiptPath), true);

      const storage = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      try {
        assert.equal(storage.inspectProject(importedProjectId), null);
        assert.notEqual(storage.inspectProject("keep-project"), null);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy desktop migration", () => {
  it("imports desktop projects and stage history while preserving unknown style and credential state", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-desktop-apply-"));
    const legacyRoot = join(root, "legacy-desktop");
    const source = createDesktopFixture(legacyRoot);
    const targetWorkspacePath = join(root, "target-workspace");
    const databaseBefore = createHash("sha256").update(readFileSync(source.databasePath)).digest("hex");
    const artifactsBefore = treeHash(source.artifactsRoot);

    try {
      const plan = planLegacyMigration({
        source: { kind: "desktop_v0_1", databasePath: source.databasePath, artifactsRoot: source.artifactsRoot },
        targetWorkspacePath,
      });
      const report = await applyLegacyMigration({ plan });

      assert.equal(report.sourceUnchanged, true);
      assert.equal(createHash("sha256").update(readFileSync(source.databasePath)).digest("hex"), databaseBefore);
      assert.equal(treeHash(source.artifactsRoot), artifactsBefore);
      assert.equal(JSON.stringify(report).includes("fixture-secret-must-not-migrate"), false);

      const storage = openWorkspaceStorage({ workspacePath: targetWorkspacePath, readOnly: true });
      try {
        const projectId = plan.projects[0]?.targetProjectId ?? "";
        const project = storage.inspectProject(projectId);
        assert.equal(project?.factGateStatus, "not_checked");
        const brief = project?.currentBriefVersionId === null || project?.currentBriefVersionId === undefined
          ? null
          : storage.getWritingBriefVersion(project.currentBriefVersionId);
        assert.equal(brief?.brief.confirmationStatus, "tentative");
        assert.equal(brief?.brief.authorAuthorization.styleDecision, "unspecified");
        const styles = storage.listActiveDecisions(projectId).filter((decision) => decision.type === "style");
        assert.equal(styles.length, 1);
        assert.deepEqual(styles[0]?.value, {
          legacyReference: "legacy-style-fixture",
          requiresUserConfirmation: true,
          validationStatus: "legacy_unknown",
        });
        const bodies = storage.listArtifactVersions(projectId, "body", "main");
        assert.equal(bodies.length, 2);
        assert.match(bodies.at(-1)?.content ?? "", /旧桌面最终稿/);
        assert.equal(bodies.every((version) => version.actor.kind === "legacy_import"), true);
        assert.equal(storage.listArtifactVersions(projectId, "title", "main").length, 1);
        assert.equal(storage.listArtifactVersions(projectId, "evidence", "legacy-research").length, 1);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
