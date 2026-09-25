import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../src/index.js";

const user = { kind: "user", id: "revision-test" } as const;
const agent = { kind: "agent", id: "writer", runId: "run-1" } as const;

describe("revision proposals, locks, and CAS", () => {
  it("previews and accepts a block revision while refusing locked or stale writes", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-revisions-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      assert.equal(storage.createProject({
        operationId: "create",
        projectId: "project-1",
        name: "局部修改",
        mode: "deep",
        actor: user,
      }).ok, true);
      const initial = storage.commitArtifactVersion({
        operationId: "initial-body",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 标题\n\n锁定段落。\n\n可以修改的段落。",
        reason: "initial",
        actor: user,
      });
      assert.equal(initial.ok, true);
      if (!initial.ok) return;
      const document = storage.getBodyDocument(initial.result.versionId);
      assert.notEqual(document, null);
      const locked = document?.blocks[0];
      const editable = document?.blocks[2];
      assert.notEqual(locked, undefined);
      assert.notEqual(editable, undefined);
      if (locked === undefined || editable === undefined) return;
      assert.equal(locked.kind, "heading");

      const lock = storage.setBodyBlockLock({
        operationId: "lock-block",
        projectId: "project-1",
        expectedProjectRevision: 1,
        baseBodyVersionId: initial.result.versionId,
        blockId: locked.id,
        blockHash: locked.contentHash,
        action: "lock",
        actor: user,
      });
      assert.equal(lock.ok, true);
      if (!lock.ok) return;

      const modelOverwrite = storage.commitArtifactVersion({
        operationId: "model-overwrite",
        projectId: "project-1",
        expectedProjectRevision: lock.projectRevision,
        kind: "body",
        logicalKey: "main",
        baseVersionId: initial.result.versionId,
        content: "# 模型改掉标题\n\n锁定段落。\n\n可以修改的段落。",
        reason: "agent rewrite",
        actor: agent,
      });
      assert.equal(modelOverwrite.ok, false);
      if (!modelOverwrite.ok) assert.equal(modelOverwrite.code, "LOCK_CONFLICT");

      const proposed = storage.proposeRevision({
        operationId: "propose-edit",
        proposalId: "proposal-1",
        projectId: "project-1",
        expectedProjectRevision: lock.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        instruction: "让末段更具体",
        constraints: ["保持锁定段落"],
        edits: [{
          type: "replace",
          targetBlockId: editable.id,
          baseBlockHash: editable.contentHash,
          content: "可以修改，并且已经写得更具体。",
        }],
        actor: agent,
      });
      assert.equal(proposed.ok, true);
      if (!proposed.ok) return;
      assert.equal(proposed.result.diff[0]?.before, "可以修改的段落。");
      assert.equal(proposed.result.diff[0]?.after, "可以修改，并且已经写得更具体。");

      const accepted = storage.acceptRevisionProposal({
        operationId: "accept-edit",
        projectId: "project-1",
        proposalId: "proposal-1",
        expectedProjectRevision: proposed.projectRevision,
        actor: user,
      });
      assert.equal(accepted.ok, true);
      if (!accepted.ok) return;
      assert.equal(accepted.result.status, "created");
      assert.equal(storage.getArtifactVersion(accepted.result.versionId)?.content,
        "# 标题\n\n锁定段落。\n\n可以修改，并且已经写得更具体。");
      assert.equal(storage.listBodyBlockLocks("project-1")[0]?.blockId, locked.id);

      const staleSave = storage.saveBody({
        operationId: "stale-manual-save",
        projectId: "project-1",
        expectedProjectRevision: lock.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        content: "用户旧窗口中的内容",
        reason: "stale editor",
        actor: user,
      });
      assert.equal(staleSave.ok, false);
      if (!staleSave.ok) assert.equal(staleSave.code, "REVISION_CONFLICT");
      assert.equal(storage.inspectProject("project-1")?.latestBodyVersionId,
        accepted.result.versionId);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rechecks locks at acceptance, keeps no-op saves versionless, and records rollback", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-revision-accept-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      storage.createProject({
        operationId: "create",
        projectId: "project-1",
        name: "接受冲突",
        mode: "quick",
        actor: user,
      });
      const initial = storage.commitArtifactVersion({
        operationId: "initial",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "第一段。\n\n第二段。",
        reason: "initial",
        actor: user,
      });
      assert.equal(initial.ok, true);
      if (!initial.ok) return;
      const block = storage.getBodyDocument(initial.result.versionId)?.blocks[0];
      assert.notEqual(block, undefined);
      if (block === undefined) return;
      assert.equal(block.kind, "paragraph");
      const proposal = storage.proposeRevision({
        operationId: "propose",
        proposalId: "proposal-lock-race",
        projectId: "project-1",
        expectedProjectRevision: 1,
        baseBodyVersionId: initial.result.versionId,
        instruction: "改第一段",
        constraints: [],
        edits: [{
          type: "replace",
          targetBlockId: block.id,
          baseBlockHash: block.contentHash,
          content: "修改后的第一段。",
        }],
        actor: agent,
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok) return;
      const lock = storage.setBodyBlockLock({
        operationId: "lock-after-proposal",
        projectId: "project-1",
        expectedProjectRevision: proposal.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        blockId: block.id,
        blockHash: block.contentHash,
        action: "lock",
        actor: user,
      });
      assert.equal(lock.ok, true);
      if (!lock.ok) return;
      const conflict = storage.acceptRevisionProposal({
        operationId: "accept-after-lock",
        projectId: "project-1",
        proposalId: "proposal-lock-race",
        expectedProjectRevision: lock.projectRevision,
        actor: user,
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.code, "LOCK_CONFLICT");
      assert.equal(storage.getRevisionProposal("proposal-lock-race")?.status, "conflicted");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 1);

      const unlocked = storage.setBodyBlockLock({
        operationId: "unlock",
        projectId: "project-1",
        expectedProjectRevision: lock.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        blockId: block.id,
        blockHash: block.contentHash,
        action: "unlock",
        actor: user,
      });
      assert.equal(unlocked.ok, true);
      if (!unlocked.ok) return;
      const noChange = storage.saveBody({
        operationId: "no-change",
        projectId: "project-1",
        expectedProjectRevision: unlocked.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        content: "第一段。\n\n第二段。",
        reason: "manual no-op",
        actor: user,
      });
      assert.equal(noChange.ok, true);
      if (!noChange.ok) return;
      assert.equal(noChange.result.status, "no_change");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 1);

      const changed = storage.saveBody({
        operationId: "manual-change",
        projectId: "project-1",
        expectedProjectRevision: noChange.projectRevision,
        baseBodyVersionId: initial.result.versionId,
        content: "第一段。\n\n第二段已修改。",
        reason: "manual edit",
        actor: user,
      });
      assert.equal(changed.ok, true);
      if (!changed.ok) return;
      const rolledBack = storage.rollbackArtifactVersion({
        operationId: "rollback",
        projectId: "project-1",
        expectedProjectRevision: changed.projectRevision,
        kind: "body",
        logicalKey: "main",
        baseVersionId: changed.result.versionId,
        targetVersionId: initial.result.versionId,
        reason: "explicit rollback",
        actor: user,
      });
      assert.equal(rolledBack.ok, true);
      if (!rolledBack.ok) return;
      assert.equal(rolledBack.result.status, "rolled_back");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 3);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
