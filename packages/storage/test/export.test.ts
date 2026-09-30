import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  contentHash,
  preparePublicationContent,
} from "../../writing-core/src/index.js";
import { openWorkspaceStorage } from "../src/index.js";

const actor = { kind: "user", id: "export-storage-test" } as const;
const titleContent = [
  "- 选择状态：已锁定",
  "- 最终标题：正式交付标题",
  "- 平台分发文案：",
  "- 分发文案选择：A",
  "- 最终分发文案：不会绕过事实门禁",
  "",
].join("\n");
const evidenceContent = JSON.stringify({
  claims: [],
  notes: "正文仅包含作者感受",
});

type ExportRecordView = {
  id: string;
  operationId: string;
  projectId: string;
  mode: "working_copy" | "publication";
  format: "markdown" | "txt" | "html";
  state: "prepared" | "completed";
  bodyVersionId: string;
  factSnapshotId: string | null;
  assessmentId: string | null;
  gateStatus: string;
  relativePath: string;
  manifestRelativePath: string | null;
  contentHash: string;
  manifestHash: string | null;
  completedAt: string | null;
};

function requireExportApi(storage: ReturnType<typeof openWorkspaceStorage>) {
  const candidate = storage as unknown as Record<string, unknown>;
  for (const method of ["saveWorkingCopy", "exportPublication", "listExports"]) {
    assert.equal(typeof candidate[method], "function", `${method} must be implemented`);
  }
  return storage as unknown as {
    saveWorkingCopy(command: Record<string, unknown>): {
      ok: boolean;
      projectRevision: number;
      operationId: string;
      code?: string;
      result: ExportRecordView;
    };
    exportPublication(command: Record<string, unknown>): {
      ok: boolean;
      projectRevision: number;
      operationId: string;
      code?: string;
      result: ExportRecordView;
    };
    listExports(projectId: string): ExportRecordView[];
  };
}

function absoluteExportPath(workspacePath: string, relativePath: string): string {
  return join(workspacePath, ...relativePath.split("/"));
}

function createProjectWithBody(
  storage: ReturnType<typeof openWorkspaceStorage>,
  bodyContent = "# 草稿标题\n\n这是尚未核查的工作草稿。",
) {
  const created = storage.createProject({
    operationId: "create-project",
    projectId: "project-1",
    name: "导出测试项目",
    mode: "deep",
    actor,
  });
  assert.equal(created.ok, true);
  const body = storage.commitArtifactVersion({
    operationId: "body-v1",
    projectId: "project-1",
    expectedProjectRevision: 0,
    kind: "body",
    logicalKey: "main",
    baseVersionId: null,
    content: bodyContent,
    reason: "export fixture",
    actor,
  });
  assert.equal(body.ok, true);
  if (!body.ok) throw new Error("body fixture failed");
  return body;
}

function passFactGate(
  storage: ReturnType<typeof openWorkspaceStorage>,
  body: ReturnType<typeof createProjectWithBody>,
) {
  const title = storage.commitArtifactVersion({
    operationId: "title-v1",
    projectId: "project-1",
    expectedProjectRevision: body.projectRevision,
    kind: "title",
    logicalKey: "main",
    baseVersionId: null,
    content: titleContent,
    reason: "locked title",
    actor,
  });
  assert.equal(title.ok, true);
  if (!title.ok) throw new Error("title fixture failed");
  const evidence = storage.commitArtifactVersion({
    operationId: "evidence-v1",
    projectId: "project-1",
    expectedProjectRevision: title.projectRevision,
    kind: "evidence",
    logicalKey: "main",
    baseVersionId: null,
    content: evidenceContent,
    reason: "evidence fixture",
    actor,
  });
  assert.equal(evidence.ok, true);
  if (!evidence.ok) throw new Error("evidence fixture failed");
  const snapshot = storage.createFactCheckSnapshot({
    operationId: "fact-snapshot",
    projectId: "project-1",
    expectedProjectRevision: evidence.projectRevision,
    bodyVersionId: body.result.versionId,
    titleVersionId: title.result.versionId,
    evidenceVersionId: evidence.result.versionId,
    actor,
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) throw new Error("snapshot fixture failed");
  const assessment = storage.evaluateFactCheckSnapshot({
    operationId: "fact-assessment",
    projectId: "project-1",
    expectedProjectRevision: snapshot.projectRevision,
    snapshotId: snapshot.result.snapshotId,
    payload: {
      schemaVersion: "fact-check-v2",
      snapshotId: snapshot.result.snapshotId,
      bodyVersionId: body.result.versionId,
      titleVersionId: title.result.versionId,
      coverage: { body: true, title: true, distributionCopy: true },
      claims: [],
      noFactualClaimsReason: "正文仅包含作者感受。",
    },
    actor,
  });
  assert.equal(assessment.ok, true);
  if (!assessment.ok) throw new Error("assessment fixture failed");
  return { title, evidence, snapshot, assessment };
}

describe("durable working-copy and publication exports", () => {
  it("saves an unverified Markdown working copy and status manifest without opening the publication gate", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-working-copy-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      const body = createProjectWithBody(storage);
      const api = requireExportApi(storage);
      const command = {
        operationId: "working-copy-1",
        projectId: "project-1",
        expectedProjectRevision: body.projectRevision,
        bodyVersionId: body.result.versionId,
        actor,
      };
      const saved = api.saveWorkingCopy(command);
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(saved.result.mode, "working_copy");
      assert.equal(saved.result.state, "completed");
      const bodyPath = absoluteExportPath(workspacePath, saved.result.relativePath);
      const manifestPath = absoluteExportPath(
        workspacePath,
        saved.result.manifestRelativePath as string,
      );
      assert.equal(readFileSync(bodyPath, "utf8"), "# 草稿标题\n\n这是尚未核查的工作草稿。");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      assert.equal(manifest.publicationStatus, "not_checked");
      assert.equal(manifest.warning, "WORKING_COPY_NOT_PUBLICATION");
      assert.equal(api.listExports("project-1").length, 1);

      const replay = api.saveWorkingCopy(command);
      assert.deepEqual(replay, saved);
      assert.equal(api.listExports("project-1").length, 1);

      const second = api.saveWorkingCopy({
        ...command,
        operationId: "working-copy-2",
        expectedProjectRevision: saved.projectRevision,
      });
      assert.equal(second.ok, true, JSON.stringify(second));
      if (!second.ok) throw new Error("second working copy failed");
      assert.notEqual(second.result.relativePath, saved.result.relativePath);
      assert.equal(api.listExports("project-1").length, 2);

      const publication = api.exportPublication({
        operationId: "publication-without-gate",
        projectId: "project-1",
        expectedProjectRevision: second.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: "missing",
        format: "txt",
        actor,
      });
      assert.equal(publication.ok, false);
      assert.equal(publication.code, "FACT_GATE_NOT_PASSED");
      assert.equal(api.listExports("project-1").length, 2);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("exports TXT and safe HTML through the same current gate and never overwrites a conflicting target", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-publication-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      const body = createProjectWithBody(
        storage,
        "# 临时标题\n\n正文有 **重点**。\n\n<script>alert('x')</script>",
      );
      const passed = passFactGate(storage, body);
      const api = requireExportApi(storage);
      const txt = api.exportPublication({
        operationId: "publication-txt",
        projectId: "project-1",
        expectedProjectRevision: passed.assessment.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: passed.snapshot.result.snapshotId,
        format: "txt",
        actor,
      });
      assert.equal(txt.ok, true, JSON.stringify(txt));
      assert.equal(txt.result.state, "completed");
      assert.equal(txt.result.assessmentId, passed.assessment.result.assessmentId);
      const txtPath = absoluteExportPath(workspacePath, txt.result.relativePath);
      assert.equal(contentHash(readFileSync(txtPath, "utf8")), txt.result.contentHash);

      const project = storage.inspectProject("project-1");
      const bodyVersion = storage.getArtifactVersion(body.result.versionId);
      const titleVersion = storage.getArtifactVersion(passed.title.result.versionId);
      const evidenceVersion = storage.getArtifactVersion(passed.evidence.result.versionId);
      assert.ok(project && bodyVersion && titleVersion && evidenceVersion);
      const preparedHtml = preparePublicationContent({
        project,
        body: bodyVersion,
        title: titleVersion,
        evidence: evidenceVersion,
        factCheck: storage.getFactCheckStatus("project-1"),
        factSnapshotId: passed.snapshot.result.snapshotId,
        format: "html",
      });
      const htmlPath = absoluteExportPath(workspacePath, preparedHtml.relativePath);
      mkdirSync(join(htmlPath, ".."), { recursive: true });
      writeFileSync(htmlPath, "existing-delivery", "utf8");

      const blockedByExisting = api.exportPublication({
        operationId: "publication-html",
        projectId: "project-1",
        expectedProjectRevision: txt.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: passed.snapshot.result.snapshotId,
        format: "html",
        actor,
      });
      assert.equal(blockedByExisting.ok, false);
      assert.equal(blockedByExisting.code, "EXPORT_TARGET_CONFLICT");
      assert.equal(readFileSync(htmlPath, "utf8"), "existing-delivery");

      rmSync(htmlPath, { force: true });
      const html = api.exportPublication({
        operationId: "publication-html",
        projectId: "project-1",
        expectedProjectRevision: txt.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: passed.snapshot.result.snapshotId,
        format: "html",
        actor,
      });
      assert.equal(html.ok, true);
      const htmlContent = readFileSync(htmlPath, "utf8");
      assert.equal(contentHash(htmlContent), html.result.contentHash);
      assert.doesNotMatch(htmlContent, /<script|onclick=|href="javascript:/iu);
      assert.equal(
        storage.listProvenanceEdges("project-1")
          .filter((edge) => edge.relation === "EXPORTED_AS").length,
        2,
      );

      const changed = storage.commitArtifactVersion({
        operationId: "body-v2",
        projectId: "project-1",
        expectedProjectRevision: html.projectRevision,
        kind: "body",
        logicalKey: "main",
        baseVersionId: body.result.versionId,
        content: "# 修改后\n\n门禁已失效。",
        reason: "stale export gate",
        actor,
      });
      assert.equal(changed.ok, true);
      if (!changed.ok) return;
      const staleAttempt = api.exportPublication({
        operationId: "publication-stale",
        projectId: "project-1",
        expectedProjectRevision: changed.projectRevision,
        bodyVersionId: changed.result.versionId,
        factSnapshotId: passed.snapshot.result.snapshotId,
        format: "txt",
        actor,
      });
      assert.equal(staleAttempt.ok, false);
      assert.equal(staleAttempt.code, "FACT_GATE_NOT_PASSED");
      assert.equal(contentHash(readFileSync(txtPath, "utf8")), txt.result.contentHash);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reconciles a file written before database completion and detects later tampering", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-export-reconcile-"));
    let injected = false;
    let storage = openWorkspaceStorage({
      workspacePath,
      faultInjector: (point) => {
        if (point === "after_export_file_replace" && !injected) {
          injected = true;
          throw new Error("simulated export crash");
        }
      },
    });
    const body = createProjectWithBody(storage);
    const passed = passFactGate(storage, body);
    const command = {
      operationId: "publication-reconcile",
      projectId: "project-1",
      expectedProjectRevision: passed.assessment.projectRevision,
      bodyVersionId: body.result.versionId,
      factSnapshotId: passed.snapshot.result.snapshotId,
      format: "txt",
      actor,
    };
    let relativePath = "";
    try {
      const failed = requireExportApi(storage).exportPublication(command);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, "EXPORT_WRITE_FAILED");
      const prepared = requireExportApi(storage).listExports("project-1");
      assert.equal(prepared.length, 1);
      assert.equal(prepared[0]?.state, "prepared");
      relativePath = prepared[0]?.relativePath ?? "";
      assert.equal(existsSync(absoluteExportPath(workspacePath, relativePath)), true);
    } finally {
      storage.close();
    }

    storage = openWorkspaceStorage({ workspacePath });
    try {
      const api = requireExportApi(storage);
      const reconciled = api.exportPublication(command);
      assert.equal(reconciled.ok, true);
      assert.equal(reconciled.result.state, "completed");
      assert.equal(api.listExports("project-1").length, 1);

      const targetPath = absoluteExportPath(workspacePath, relativePath);
      writeFileSync(targetPath, "tampered outside the application", "utf8");
      const tampered = api.exportPublication(command);
      assert.equal(tampered.ok, false);
      assert.equal(tampered.code, "EXPORT_FILE_MISMATCH");
      assert.equal(readFileSync(targetPath, "utf8"), "tampered outside the application");
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
