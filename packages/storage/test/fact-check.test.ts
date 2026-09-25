import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../src/index.js";

const actor = { kind: "user", id: "fact-check-test" } as const;
const titleContent = "- 选择状态：已锁定\n- 最终标题：「事实核查标题」\n";
const evidenceContent = JSON.stringify({
  claims: [],
  notes: "正文只有作者感受，没有外部事实",
});

function requireFactApi(storage: ReturnType<typeof openWorkspaceStorage>) {
  const candidate = storage as unknown as Record<string, unknown>;
  for (const method of [
    "createFactCheckSnapshot",
    "evaluateFactCheckSnapshot",
    "getFactCheckStatus",
  ]) {
    assert.equal(typeof candidate[method], "function", `${method} must be implemented`);
  }
  return storage as unknown as {
    createFactCheckSnapshot(command: Record<string, unknown>): {
      ok: boolean;
      projectRevision: number;
      result: { snapshotId: string; status: "checking" };
    };
    evaluateFactCheckSnapshot(command: Record<string, unknown>): {
      ok: boolean;
      projectRevision: number;
      result: {
        snapshotId: string;
        assessmentId: string;
        status: "passed" | "blocked";
        blockers: readonly string[];
      };
    };
    getFactCheckStatus(projectId: string): {
      status: "not_checked" | "checking" | "passed" | "blocked" | "error" | "stale";
      currentSnapshotId: string | null;
      snapshot: null | {
        bodyVersionId: string;
        bodyHash: string;
        titleVersionId: string;
        titleHash: string;
        evidenceVersionId: string;
        evidenceHash: string;
        policyVersion: string;
      };
      assessment: null | {
        status: "passed" | "blocked";
        claimsHash: string;
        reportHash: string;
        blockers: readonly string[];
      };
      invalidations: ReadonlyArray<{ reason: string; changedVersionId: string }>;
    };
  };
}

describe("persisted fact-check snapshots and invalidation", () => {
  it("computes the gate from frozen versions and records why a later body makes it stale", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-fact-check-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      storage.createProject({
        operationId: "create",
        projectId: "project-1",
        name: "事实门禁",
        mode: "deep",
        actor,
      });
      const body = storage.commitArtifactVersion({
        operationId: "body-v1",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 事实核查标题\n\n这是作者的感受。",
        reason: "initial body",
        actor,
      });
      assert.equal(body.ok, true);
      if (!body.ok) return;
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
      if (!title.ok) return;
      const evidence = storage.commitArtifactVersion({
        operationId: "evidence-v1",
        projectId: "project-1",
        expectedProjectRevision: title.projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: null,
        content: evidenceContent,
        reason: "evidence ledger",
        actor,
      });
      assert.equal(evidence.ok, true);
      if (!evidence.ok) return;

      const factApi = requireFactApi(storage);
      const frozen = factApi.createFactCheckSnapshot({
        operationId: "fact-snapshot",
        projectId: "project-1",
        expectedProjectRevision: evidence.projectRevision,
        bodyVersionId: body.result.versionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozen.ok, true);
      assert.equal(frozen.result.status, "checking");
      assert.equal(factApi.getFactCheckStatus("project-1").status, "checking");

      const assessed = factApi.evaluateFactCheckSnapshot({
        operationId: "fact-assessment",
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
          noFactualClaimsReason: "全文只有作者感受，没有可核查外部事实。",
        },
        actor,
      });
      assert.equal(assessed.ok, true);
      assert.equal(assessed.result.status, "passed");
      assert.deepEqual(assessed.result.blockers, []);

      const rewritten = storage.evaluateFactCheckSnapshot({
        operationId: "fact-assessment-rewrite",
        projectId: "project-1",
        expectedProjectRevision: assessed.projectRevision,
        snapshotId: frozen.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozen.result.snapshotId,
          bodyVersionId: body.result.versionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "试图改写已经提交的历史评估。",
        },
        actor,
      });
      assert.equal(rewritten.ok, false);
      if (!rewritten.ok) assert.equal(rewritten.code, "FACT_ASSESSMENT_EXISTS");

      const passed = factApi.getFactCheckStatus("project-1");
      assert.equal(passed.status, "passed");
      assert.equal(passed.currentSnapshotId, frozen.result.snapshotId);
      assert.equal(passed.snapshot?.bodyVersionId, body.result.versionId);
      assert.equal(passed.assessment?.status, "passed");
      assert.match(passed.assessment?.claimsHash ?? "", /^[a-f0-9]{64}$/u);
      assert.match(passed.assessment?.reportHash ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(
        storage.listProvenanceEdges("project-1")
          .filter((edge) => edge.fromId === frozen.result.snapshotId).length,
        3,
      );

      const changed = storage.commitArtifactVersion({
        operationId: "body-v2",
        projectId: "project-1",
        expectedProjectRevision: assessed.projectRevision,
        kind: "body",
        logicalKey: "main",
        baseVersionId: body.result.versionId,
        content: "# 事实核查标题\n\n正文已经变化。",
        reason: "change after pass",
        actor,
      });
      assert.equal(changed.ok, true);
      if (!changed.ok) return;
      const stale = factApi.getFactCheckStatus("project-1");
      assert.equal(stale.status, "stale");
      assert.equal(stale.assessment?.status, "passed");
      assert.equal(stale.invalidations.at(-1)?.reason, "body_version_changed");
      assert.equal(stale.invalidations.at(-1)?.changedVersionId, changed.result.versionId);

      const frozenAfterBody = factApi.createFactCheckSnapshot({
        operationId: "fact-snapshot-after-body",
        projectId: "project-1",
        expectedProjectRevision: changed.projectRevision,
        bodyVersionId: changed.result.versionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozenAfterBody.ok, true);
      const checkedAfterBody = factApi.evaluateFactCheckSnapshot({
        operationId: "fact-assessment-after-body",
        projectId: "project-1",
        expectedProjectRevision: frozenAfterBody.projectRevision,
        snapshotId: frozenAfterBody.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozenAfterBody.result.snapshotId,
          bodyVersionId: changed.result.versionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "正文变化后重新核查。",
        },
        actor,
      });
      assert.equal(checkedAfterBody.ok, true);
      const changedTitle = storage.commitArtifactVersion({
        operationId: "title-v2",
        projectId: "project-1",
        expectedProjectRevision: checkedAfterBody.projectRevision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: title.result.versionId,
        content: "- 选择状态：已锁定\n- 最终标题：「标题已经变化」\n- 平台分发文案：\n- 分发文案选择：A\n- 最终分发文案：新的分发文案\n",
        reason: "change title and distribution copy",
        actor,
      });
      assert.equal(changedTitle.ok, true);
      if (!changedTitle.ok) return;
      const titleStale = factApi.getFactCheckStatus("project-1");
      assert.equal(titleStale.status, "stale");
      assert.equal(titleStale.invalidations.at(-1)?.reason, "title_version_changed");

      const frozenAfterTitle = factApi.createFactCheckSnapshot({
        operationId: "fact-snapshot-after-title",
        projectId: "project-1",
        expectedProjectRevision: changedTitle.projectRevision,
        bodyVersionId: changed.result.versionId,
        titleVersionId: changedTitle.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozenAfterTitle.ok, true);
      const checkedAfterTitle = factApi.evaluateFactCheckSnapshot({
        operationId: "fact-assessment-after-title",
        projectId: "project-1",
        expectedProjectRevision: frozenAfterTitle.projectRevision,
        snapshotId: frozenAfterTitle.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozenAfterTitle.result.snapshotId,
          bodyVersionId: changed.result.versionId,
          titleVersionId: changedTitle.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "标题和分发文案变化后重新核查。",
        },
        actor,
      });
      assert.equal(checkedAfterTitle.ok, true);
      const changedEvidence = storage.commitArtifactVersion({
        operationId: "evidence-v2",
        projectId: "project-1",
        expectedProjectRevision: checkedAfterTitle.projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: evidence.result.versionId,
        content: JSON.stringify({ claims: [], notes: "账本内容已经变化" }),
        reason: "change evidence ledger",
        actor,
      });
      assert.equal(changedEvidence.ok, true);
      if (!changedEvidence.ok) return;
      const evidenceStale = factApi.getFactCheckStatus("project-1");
      assert.equal(evidenceStale.status, "stale");
      assert.equal(
        evidenceStale.invalidations.at(-1)?.reason,
        "evidence_version_changed",
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
