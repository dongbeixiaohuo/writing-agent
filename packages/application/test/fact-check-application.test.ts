import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { WritingApplicationService } from "../src/index.js";

const actor = { kind: "user", id: "application-fact-test" } as const;

class UnusedProvider extends ModelProviderBase {
  constructor() {
    super("unused", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "unsupported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    _request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    throw new Error("provider must not be called by fact status queries");
  }
}

describe("WritingApplicationService fact-check projection", () => {
  it("exposes the current computed gate and queryable input provenance", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-app-fact-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({
      storage,
      provider: new UnusedProvider(),
    });
    try {
      service.createProject({
        operationId: "create",
        projectId: "project-1",
        name: "Application fact projection",
        mode: "deep",
        actor,
      });
      const body = storage.commitArtifactVersion({
        operationId: "body",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 标题\n\n这是作者感受。",
        reason: "fixture",
        actor,
      });
      assert.equal(body.ok, true);
      if (!body.ok) return;
      const title = storage.commitArtifactVersion({
        operationId: "title",
        projectId: "project-1",
        expectedProjectRevision: body.projectRevision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: null,
        content: "- 选择状态：已锁定\n- 最终标题：「标题」\n",
        reason: "fixture",
        actor,
      });
      assert.equal(title.ok, true);
      if (!title.ok) return;
      const evidence = storage.commitArtifactVersion({
        operationId: "evidence",
        projectId: "project-1",
        expectedProjectRevision: title.projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: null,
        content: JSON.stringify({ claims: [], notes: "无外部事实" }),
        reason: "fixture",
        actor,
      });
      assert.equal(evidence.ok, true);
      if (!evidence.ok) return;

      const frozen = service.createFactCheckSnapshot({
        operationId: "freeze",
        projectId: "project-1",
        expectedProjectRevision: evidence.projectRevision,
        bodyVersionId: body.result.versionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozen.ok, true);
      if (!frozen.ok) return;
      const evaluated = service.evaluateFactCheckSnapshot({
        operationId: "evaluate",
        projectId: "project-1",
        expectedProjectRevision: frozen.projectRevision,
        snapshotId: frozen.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozen.result.snapshotId,
          bodyVersionId: body.result.versionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "仅有作者感受。",
        },
        actor,
      });
      assert.equal(evaluated.ok, true);

      const projection = service.getProjectProjection("project-1");
      assert.equal(projection.factCheck.status, "passed");
      assert.equal(projection.factCheck.snapshot?.bodyVersionId, body.result.versionId);
      assert.equal(projection.factCheck.assessment?.status, "passed");
      assert.equal(
        projection.provenance.filter(
          (edge) => edge.fromId === frozen.result.snapshotId && edge.relation === "CHECKED_IN",
        ).length,
        3,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("backs up the current body without a model provider and projects durable exports", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-app-export-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({ storage });
    try {
      const created = service.createProject({
        operationId: "create-export-project",
        projectId: "project-export",
        name: "Application export projection",
        mode: "quick",
        actor,
      });
      assert.equal(created.ok, true);
      const body = storage.commitArtifactVersion({
        operationId: "export-body",
        projectId: "project-export",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 工作稿\n\n尚未核查。",
        reason: "fixture",
        actor,
      });
      assert.equal(body.ok, true);
      if (!body.ok) return;

      const saved = service.saveWorkingCopy({
        operationId: "save-working-copy",
        projectId: "project-export",
        expectedProjectRevision: body.projectRevision,
        bodyVersionId: body.result.versionId,
        actor,
      });
      assert.equal(saved.ok, true);
      if (!saved.ok) return;
      assert.equal(saved.result.mode, "working_copy");

      const formal = service.exportPublication({
        operationId: "reject-formal-export",
        projectId: "project-export",
        expectedProjectRevision: saved.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: "missing-fact-snapshot",
        format: "txt",
        actor,
      });
      assert.equal(formal.ok, false);
      if (formal.ok) return;
      assert.equal(formal.code, "FACT_GATE_NOT_PASSED");

      const projection = service.getProjectProjection("project-export");
      assert.equal(projection.exports.length, 1);
      assert.equal(projection.exports[0]?.id, saved.result.id);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
