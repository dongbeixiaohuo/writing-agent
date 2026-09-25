import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../src/index.js";

const user = { kind: "user", id: "user-1" } as const;

describe("writing inputs in workspace storage", () => {
  it("persists project-scoped material, a versioned brief, and an explicit authorization decision", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-inputs-"));
    let id = 0;
    const storage = openWorkspaceStorage({
      workspacePath,
      clock: () => "2026-09-17T00:00:00.000Z",
      idFactory: () => `generated-${++id}`,
    });

    try {
      assert.equal(
        storage.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "材料闭环",
          mode: "quick",
          actor: user,
        }).ok,
        true,
      );
      assert.equal(
        storage.createProject({
          operationId: "create-other-project",
          projectId: "project-2",
          name: "隔离项目",
          mode: "quick",
          actor: user,
        }).ok,
        true,
      );

      const imported = storage.importMaterial({
        operationId: "import-material",
        projectId: "project-1",
        expectedProjectRevision: 0,
        materialId: "material-1",
        displayName: "作者记录.md",
        sourceKind: "utf8_file",
        sourceReference: "author-notes.md",
        role: "user_firsthand",
        trustLabel: "user_provided_untrusted",
        permissionScope: "project_only",
        content: "下班后我沿着河边走了二十分钟。",
        actor: user,
      });
      assert.equal(imported.ok, true);
      if (!imported.ok) return;
      assert.equal(imported.projectRevision, 1);
      assert.equal(imported.result.contentVersionId, "generated-3");
      assert.equal(imported.result.hash.length, 64);

      const material = storage.getMaterial("project-1", "material-1");
      assert.equal(material?.content, "下班后我沿着河边走了二十分钟。");
      assert.equal(material?.role, "user_firsthand");
      assert.equal(material?.permissionScope, "project_only");
      assert.equal(storage.getMaterial("project-2", "material-1"), null);
      assert.deepEqual(
        storage.listMaterials("project-1").map((entry) => entry.id),
        ["material-1"],
      );

      const brief = {
        schemaVersion: 1 as const,
        topic: "下班散步如何让人重新听见自己",
        genre: "narrative_observation" as const,
        audience: "工作节奏很快的城市上班族",
        lengthTarget: { targetCharacters: 1200 },
        materialIds: ["material-1"],
        constraints: ["不虚构新的亲历"],
        interactionMode: "autonomous" as const,
        authorAuthorization: {
          voice: "安静、克制的第一人称观察",
          styleReference: null,
          styleDecision: "user_confirmed" as const,
          directionDecision: "user_confirmed" as const,
          firsthandMaterialIds: ["material-1"],
        },
        platform: null,
        publicationGoal: "not_applicable" as const,
        confirmationStatus: "confirmed" as const,
      };
      const savedBrief = storage.saveWritingBrief({
        operationId: "save-brief",
        projectId: "project-1",
        expectedProjectRevision: 1,
        baseVersionId: null,
        brief,
        actor: user,
      });
      assert.equal(savedBrief.ok, true);
      if (!savedBrief.ok) return;
      assert.equal(savedBrief.projectRevision, 2);
      assert.equal(savedBrief.result.status, "created");
      assert.equal(
        storage.inspectProject("project-1")?.currentBriefVersionId,
        savedBrief.result.versionId,
      );
      assert.deepEqual(
        storage.getWritingBriefVersion(savedBrief.result.versionId)?.brief,
        brief,
      );

      const decision = storage.recordDecision({
        operationId: "record-style-authorization",
        projectId: "project-1",
        expectedProjectRevision: 2,
        decisionId: "decision-style-1",
        type: "style",
        value: {
          status: "user_confirmed",
          voice: "安静、克制的第一人称观察",
        },
        scope: "current_article",
        sourceEventId: null,
        actor: user,
      });
      assert.equal(decision.ok, true);
      if (!decision.ok) return;
      assert.equal(decision.projectRevision, 3);
      assert.deepEqual(storage.listActiveDecisions("project-1"), [
        {
          id: "decision-style-1",
          projectId: "project-1",
          type: "style",
          value: {
            status: "user_confirmed",
            voice: "安静、克制的第一人称观察",
          },
          scope: "current_article",
          actor: user,
          sourceEventId: null,
          createdAt: "2026-09-17T00:00:00.000Z",
        },
      ]);

      assert.deepEqual(
        storage.listEvents("project-1").map((event) => event.type),
        [
          "project.created",
          "material.imported",
          "brief.confirmed",
          "decision.recorded",
        ],
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects a brief that claims an unscoped material is first-hand author experience", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-brief-scope-"));
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      assert.equal(
        storage.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "授权校验",
          mode: "deep",
          actor: user,
        }).ok,
        true,
      );
      const result = storage.saveWritingBrief({
        operationId: "save-invalid-brief",
        projectId: "project-1",
        expectedProjectRevision: 0,
        baseVersionId: null,
        brief: {
          schemaVersion: 1,
          topic: "不能冒充亲历",
          genre: "explanatory_analysis",
          audience: "普通读者",
          lengthTarget: { targetCharacters: 1000 },
          materialIds: ["missing-material"],
          constraints: [],
          interactionMode: "autonomous",
          authorAuthorization: {
            voice: null,
            styleReference: null,
            styleDecision: "unspecified",
            directionDecision: "tentative",
            firsthandMaterialIds: ["missing-material"],
          },
          platform: null,
          publicationGoal: "not_applicable",
          confirmationStatus: "tentative",
        },
        actor: user,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "MATERIAL_SCOPE_INVALID");
      assert.equal(storage.inspectProject("project-1")?.revision, 0);
      assert.equal(storage.listEvents("project-1").length, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
