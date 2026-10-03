import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../../storage/src/index.js";
import type { WritingBrief } from "../../writing-core/src/index.js";
import {
  ConversationMaterialError,
  addConversationMaterialToBrief,
} from "../src/conversation-materials.js";

const initialBrief: WritingBrief = {
  schemaVersion: 1,
  topic: "夜跑复盘",
  genre: "practical_experience",
  audience: "刚开始夜跑的人",
  lengthTarget: { targetCharacters: 1200 },
  materialIds: [],
  constraints: ["不编造亲历"],
  interactionMode: "co_creation",
  authorAuthorization: {
    voice: null,
    styleReference: null,
    styleDecision: "unspecified",
    directionDecision: "user_confirmed",
    firsthandMaterialIds: [],
  },
  platform: null,
  publicationGoal: "not_applicable",
  confirmationStatus: "confirmed",
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "conversation-materials-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const created = storage.createProject({
    operationId: "create-project",
    projectId: "project-1",
    name: "补料项目",
    mode: "quick",
    actor: { kind: "user", id: "user-1" },
  });
  assert.equal(created.ok, true);
  const saved = storage.saveWritingBrief({
    operationId: "save-initial-brief",
    projectId: "project-1",
    expectedProjectRevision: 0,
    baseVersionId: null,
    brief: initialBrief,
    actor: { kind: "user", id: "user-1" },
  });
  assert.equal(saved.ok, true);
  return {
    directory,
    storage,
    close() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("conversation materials", () => {
  it("imports a post-writing user material and binds it to the current brief idempotently", () => {
    const f = fixture();
    try {
      const input = {
        storage: f.storage,
        projectId: "project-1",
        userOperationText: "补充说明：这里的三公里训练计划只是说明性示例，不是我的真实经历。",
        materialName: "三公里训练计划说明",
        role: "illustrative" as const,
        operationId: "append-example",
        expectedProjectRevision: 1,
      };
      const first = addConversationMaterialToBrief(input);
      const replay = addConversationMaterialToBrief(input);
      assert.deepEqual(replay, first);
      const retriedTurn = addConversationMaterialToBrief({ ...input, operationId: 'retry-new-operation', expectedProjectRevision: first.projectRevision });
      assert.deepEqual(retriedTurn, first, 'retrying the same material must not create another brief version');
      assert.equal(f.storage.listMaterials("project-1").length, 1);
      const material = f.storage.getMaterial("project-1", first.materialId);
      assert.equal(material?.displayName, input.materialName);
      assert.equal(material?.content, input.userOperationText);
      assert.equal(material?.role, "illustrative");
      assert.equal(material?.trustLabel, "user_provided_untrusted");
      assert.deepEqual(
        f.storage.getWritingBriefVersion(first.briefVersionId)?.brief.materialIds,
        [first.materialId],
      );
    } finally {
      f.close();
    }
  });

  it("requires explicit user wording before binding a post-writing material as firsthand", () => {
    const f = fixture();
    try {
      const first = addConversationMaterialToBrief({
        storage: f.storage,
        projectId: "project-1",
        userOperationText: "这是我的亲身经历：去年冬天我第一次夜跑只跑了两公里。",
        materialName: "第一次夜跑记录",
        role: "user_firsthand",
        operationId: "append-firsthand",
        expectedProjectRevision: 1,
      });
      const material = f.storage.getMaterial("project-1", first.materialId);
      const brief = f.storage.getWritingBriefVersion(first.briefVersionId)?.brief;
      assert.equal(material?.role, "user_firsthand");
      assert.equal(material?.trustLabel, "user_provided_untrusted");
      assert.deepEqual(brief?.authorAuthorization.firsthandMaterialIds, [first.materialId]);

      const current = f.storage.inspectProject("project-1")!;
      assert.throws(
        () => addConversationMaterialToBrief({
          storage: f.storage,
          projectId: "project-1",
          userOperationText: "再补一段夜跑内容。",
          materialName: "模型声称已授权的记录",
          role: "user_firsthand",
          operationId: "model-boolean-is-not-authority",
          expectedProjectRevision: current.revision,
          firsthandAuthorized: true,
        } as Parameters<typeof addConversationMaterialToBrief>[0]),
        (error: unknown) => error instanceof ConversationMaterialError &&
          error.code === "FIRSTHAND_AUTHORIZATION_REQUIRED",
      );
      assert.equal(f.storage.listMaterials("project-1").length, 1);
    } finally {
      f.close();
    }
  });

  it("does not bind named third-party original text or a quoted block as the user's firsthand material", () => {
    for (const [index, userOperationText] of [
      "以下是小王原文：\n这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
      "原文摘录：\n> 这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
    ].entries()) {
      const f = fixture();
      try {
        assert.throws(
          () => addConversationMaterialToBrief({
            storage: f.storage,
            projectId: "project-1",
            userOperationText,
            materialName: `第三方原文 ${index + 1}`,
            role: "user_firsthand",
            operationId: `reject-third-party-${index + 1}`,
            expectedProjectRevision: 1,
          }),
          (error: unknown) => error instanceof ConversationMaterialError &&
            error.code === "FIRSTHAND_AUTHORIZATION_REQUIRED",
        );
        assert.equal(f.storage.listMaterials("project-1").length, 0);
      } finally {
        f.close();
      }
    }
  });
});
