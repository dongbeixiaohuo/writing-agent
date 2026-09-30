import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  openWorkspaceStorage,
  type CommitFaultPoint,
} from "../src/index.js";

const actor = { kind: "user" as const, id: "user-1" };

function idFactory(): () => string {
  let next = 0;
  return () => `generated-${++next}`;
}

describe("immutable artifact versions", () => {
  it("enforces idempotency, CAS, no-op, gate invalidation, and explicit rollback", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-versioning-"));
    const storage = openWorkspaceStorage({
      workspacePath,
      clock: () => "2026-09-16T09:00:00.000Z",
      idFactory: idFactory(),
    });

    try {
      assert.equal(
        storage.createProject({
          operationId: "create-1",
          projectId: "project-1",
          name: "不可变版本测试",
          mode: "deep",
          actor,
        }).ok,
        true,
      );

      const invalidFactSnapshot = storage.createFactCheckSnapshot({
        operationId: "fact-non-json",
        projectId: "project-1",
        expectedProjectRevision: 0,
        bodyVersionId: null as never,
        titleVersionId: null as never,
        evidenceVersionId: null as never,
        actor,
      });
      assert.equal(invalidFactSnapshot.ok, false);
      if (!invalidFactSnapshot.ok) {
        assert.equal(invalidFactSnapshot.code, "INVALID_COMMAND");
      }
      assert.equal(storage.inspectProject("project-1")?.revision, 0);

      const firstCommand = {
        operationId: "body-1",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body" as const,
        logicalKey: "main",
        baseVersionId: null,
        content: "第一稿",
        reason: "初稿",
        actor,
      };
      const first = storage.commitArtifactVersion(firstCommand);
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.projectRevision, 1);
      assert.equal(first.result.status, "created");
      const firstVersionId = first.result.versionId;
      const storedFirst = storage.getArtifactVersion(firstVersionId);
      assert.equal(storedFirst?.createdEventSeq, 2);
      assert.equal(storedFirst?.requestSnapshotId, null);

      assert.deepEqual(storage.commitArtifactVersion(firstCommand), first);
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").length,
        1,
      );

      const reused = storage.commitArtifactVersion({
        ...firstCommand,
        content: "operationId 不得换内容",
      });
      assert.equal(reused.ok, false);
      if (!reused.ok) assert.equal(reused.code, "IDEMPOTENCY_KEY_REUSED");

      const staleRevision = storage.commitArtifactVersion({
        ...firstCommand,
        operationId: "body-stale-revision",
        content: "并发覆盖",
      });
      assert.equal(staleRevision.ok, false);
      if (!staleRevision.ok) {
        assert.equal(staleRevision.code, "PROJECT_REVISION_CONFLICT");
      }

      const noChange = storage.commitArtifactVersion({
        ...firstCommand,
        operationId: "body-no-change",
        expectedProjectRevision: 1,
        baseVersionId: firstVersionId,
      });
      assert.equal(noChange.ok, true);
      if (!noChange.ok) return;
      assert.equal(noChange.projectRevision, 1);
      assert.equal(noChange.result.status, "no_change");
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").length,
        1,
      );

      const title = storage.commitArtifactVersion({
        operationId: "title-1",
        projectId: "project-1",
        expectedProjectRevision: 1,
        kind: "title",
        logicalKey: "main",
        baseVersionId: null,
        content: "- 选择状态：已锁定\n- 最终标题：「不可变版本测试」\n",
        reason: "锁定标题",
        actor,
      });
      assert.equal(title.ok, true);
      if (!title.ok) return;
      const evidence = storage.commitArtifactVersion({
        operationId: "evidence-1",
        projectId: "project-1",
        expectedProjectRevision: title.projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: null,
        content: JSON.stringify({ claims: [], notes: "没有外部事实" }),
        reason: "证据账本",
        actor,
      });
      assert.equal(evidence.ok, true);
      if (!evidence.ok) return;
      const frozen = storage.createFactCheckSnapshot({
        operationId: "fact-snapshot-1",
        projectId: "project-1",
        expectedProjectRevision: evidence.projectRevision,
        bodyVersionId: firstVersionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozen.ok, true);
      if (!frozen.ok) return;
      const checked = storage.evaluateFactCheckSnapshot({
        operationId: "fact-1",
        projectId: "project-1",
        expectedProjectRevision: frozen.projectRevision,
        snapshotId: frozen.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozen.result.snapshotId,
          bodyVersionId: firstVersionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "没有可核查的外部事实。",
        },
        actor,
      });
      assert.equal(checked.ok, true);
      if (!checked.ok) return;
      assert.equal(checked.projectRevision, 5);
      assert.equal(storage.inspectProject("project-1")?.factGateStatus, "passed");

      const second = storage.commitArtifactVersion({
        ...firstCommand,
        operationId: "body-2",
        expectedProjectRevision: 5,
        baseVersionId: firstVersionId,
        content: "第二稿",
        reason: "补充事实",
      });
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.projectRevision, 6);
      const secondVersionId = second.result.versionId;
      const afterSecond = storage.inspectProject("project-1");
      assert.equal(afterSecond?.latestBodyVersionId, secondVersionId);
      assert.equal(afterSecond?.factGateStatus, "stale");
      assert.equal(afterSecond?.currentFactSnapshotId, checked.result.snapshotId);

      const staleBase = storage.commitArtifactVersion({
        ...firstCommand,
        operationId: "body-stale-base",
        expectedProjectRevision: 6,
        baseVersionId: firstVersionId,
        content: "错误基线",
      });
      assert.equal(staleBase.ok, false);
      if (!staleBase.ok) assert.equal(staleBase.code, "BASE_VERSION_CONFLICT");

      const rolledBack = storage.rollbackArtifactVersion({
        operationId: "rollback-1",
        projectId: "project-1",
        expectedProjectRevision: 6,
        kind: "body",
        logicalKey: "main",
        baseVersionId: secondVersionId,
        targetVersionId: firstVersionId,
        reason: "回退到经确认版本",
        actor,
      });
      assert.equal(rolledBack.ok, true);
      if (!rolledBack.ok) return;
      assert.equal(rolledBack.projectRevision, 7);
      assert.notEqual(rolledBack.result.versionId, firstVersionId);

      const versions = storage.listArtifactVersions(
        "project-1",
        "body",
        "main",
      );
      assert.equal(versions.length, 3);
      assert.equal(versions[0]?.content, "第一稿");
      assert.equal(versions[1]?.content, "第二稿");
      assert.equal(versions[2]?.content, "第一稿");
      assert.deepEqual(versions[2]?.parentVersionIds, [
        secondVersionId,
        firstVersionId,
      ]);
      assert.deepEqual(
        storage.listEvents("project-1", 0).map((event) => event.type),
        [
          "project.created",
          "artifact.version_committed",
          "artifact.version_committed",
          "artifact.version_committed",
          "fact.snapshot_created",
          "fact.assessment_recorded",
          "artifact.version_committed",
          "fact.invalidated",
          "artifact.rolled_back",
          "fact.invalidated",
        ],
      );
      assert.deepEqual(
        storage.listProvenanceEdges("project-1").map((edge) => ({
          fromId: edge.fromId,
          relation: edge.relation,
          toId: edge.toId,
        })),
        [
          {
            fromId: frozen.result.snapshotId,
            relation: "CHECKED_IN",
            toId: firstVersionId,
          },
          {
            fromId: frozen.result.snapshotId,
            relation: "CHECKED_IN",
            toId: title.result.versionId,
          },
          {
            fromId: frozen.result.snapshotId,
            relation: "CHECKED_IN",
            toId: evidence.result.versionId,
          },
          {
            fromId: secondVersionId,
            relation: "DERIVED_FROM",
            toId: firstVersionId,
          },
          {
            fromId: rolledBack.result.versionId,
            relation: "DERIVED_FROM",
            toId: secondVersionId,
          },
          {
            fromId: rolledBack.result.versionId,
            relation: "DERIVED_FROM",
            toId: firstVersionId,
          },
        ],
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rolls every write back when a commit fails before SQLite commit", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-atomic-"));
    let injectedPoint: CommitFaultPoint | null = null;
    const storage = openWorkspaceStorage({
      workspacePath,
      clock: () => "2026-09-16T10:00:00.000Z",
      idFactory: idFactory(),
      faultInjector: (point) => {
        if (point === injectedPoint) throw new Error(`injected:${point}`);
      },
    });

    try {
      storage.createProject({
        operationId: "create-atomic",
        projectId: "project-atomic",
        name: "原子性测试",
        mode: "quick",
        actor,
      });
      const commandBase = {
        projectId: "project-atomic",
        expectedProjectRevision: 0,
        kind: "body" as const,
        logicalKey: "main",
        baseVersionId: null,
        content: "不能留下半成品",
        reason: "原子性验证",
        actor,
      };

      for (const point of [
        "after_artifact_version_insert",
        "after_project_pointer_update",
        "before_transaction_commit",
      ] as const) {
        injectedPoint = point;
        const failed = storage.commitArtifactVersion({
          ...commandBase,
          operationId: `body-atomic-${point}`,
        });
        assert.equal(failed.ok, false);
        if (!failed.ok) assert.equal(failed.code, "STORAGE_WRITE_FAILED");
        assert.equal(storage.inspectProject("project-atomic")?.revision, 0);
        assert.equal(
          storage.inspectProject("project-atomic")?.latestBodyVersionId,
          null,
        );
        assert.equal(
          storage.listArtifactVersions("project-atomic", "body", "main").length,
          0,
        );
        assert.equal(storage.listEvents("project-atomic", 0).length, 1);
      }

      injectedPoint = null;
      const retried = storage.commitArtifactVersion({
        ...commandBase,
        operationId: "body-atomic-before_transaction_commit",
      });
      assert.equal(retried.ok, true);
      assert.equal(
        storage.listArtifactVersions("project-atomic", "body", "main").length,
        1,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("lets SQLite recover an uncommitted transaction after an actual process exit", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-crash-"));
    let storage = openWorkspaceStorage({ workspacePath });
    storage.createProject({
      operationId: "create-process-crash",
      projectId: "project-process-crash",
      name: "真实进程退出测试",
      mode: "quick",
      actor,
    });
    storage.close();

    const fixture = fileURLToPath(
      new URL("./fixtures/crash-writer.ts", import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fixture,
        workspacePath,
        "after_project_pointer_update",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(child.status, 91, child.stderr);

    storage = openWorkspaceStorage({ workspacePath });
    try {
      assert.equal(storage.inspectProject("project-process-crash")?.revision, 0);
      assert.equal(
        storage.inspectProject("project-process-crash")?.latestBodyVersionId,
        null,
      );
      assert.equal(
        storage.listArtifactVersions(
          "project-process-crash",
          "body",
          "main",
        ).length,
        0,
      );
      assert.equal(storage.listEvents("project-process-crash", 0).length, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
