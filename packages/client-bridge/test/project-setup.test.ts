import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WritingApplicationService } from "../../application/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { createApplicationBridge } from "../src/application-bridge.js";
import { ImmediateWorkflowProvider } from "./helpers/workflow-provider.js";

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= expires) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("first-run project setup persists the full brief and waits for explicit confirmation", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "wa-project-setup-"));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage });
  const bridge = createApplicationBridge({
    service,
    workspaceId: "setup-workspace",
    model: {
      model: "not-configured",
      providerLabel: "未配置模型",
      credentialReference: null,
      parameters: { temperature: 0, toolChoice: "auto" },
    },
    operationIdFactory: () => "setup-operation",
  });
  try {
    const created = await bridge.createProject({
      name: "企业知识库文章",
      mode: "quick",
      topic: "如何建立可恢复的写作流程",
      genre: "practical_experience",
      audience: "企业 IT 负责人",
      targetCharacters: 1200,
      constraints: ["不得虚构数据", "保留失败经验"],
      interactionMode: "co_creation",
      authorVoice: "务实、具体",
      styleReference: "内部技术复盘",
      styleDecision: "user_confirmed",
      directionDecision: "tentative",
      platform: "企业知识库",
      publicationGoal: "primary",
      materials: [
        {
          name: "访谈纪要",
          content: "受访者强调：每次提交都要有版本记录。",
          role: "user_firsthand",
          sourceKind: "pasted_text",
          sourceReference: null,
        },
        {
          name: "产品文档",
          content: "恢复流程必须从已提交版本继续。",
          role: "source_verified",
          sourceKind: "web_snapshot",
          sourceReference: "https://example.test/recovery",
        },
      ],
    });
    assert.equal(created.projectId, "project:setup-operation");
    const projection = service.getProjectProjection(created.projectId);
    assert.equal(projection.materials.length, 2);
    assert.equal(projection.brief?.brief.confirmationStatus, "tentative");
    assert.equal(projection.brief?.brief.genre, "practical_experience");
    assert.equal(projection.brief?.brief.interactionMode, "co_creation");
    assert.equal(projection.brief?.brief.authorAuthorization.voice, "务实、具体");
    assert.equal(projection.brief?.brief.authorAuthorization.styleReference, "内部技术复盘");
    assert.equal(projection.brief?.brief.authorAuthorization.directionDecision, "tentative");
    assert.deepEqual(projection.brief?.brief.constraints, ["不得虚构数据", "保留失败经验"]);
    assert.equal(bridge.getSnapshot().selectedProjectId, created.projectId);
    assert.equal(bridge.getSnapshot().brief?.topic, "如何建立可恢复的写作流程");
    assert.equal(bridge.getSnapshot().brief?.confirmationStatus, "tentative");

    await bridge.updateBrief({
      topic: "如何建立可验证、可恢复的写作流程",
      genre: "explanatory_analysis",
      audience: "企业内容负责人",
      targetCharacters: 1600,
      constraints: ["不得虚构数据", "说明恢复边界"],
      interactionMode: "autonomous",
      authorVoice: "务实、清楚",
      styleReference: null,
      styleDecision: "user_delegated",
      directionDecision: "user_confirmed",
      platform: "企业知识库",
      publicationGoal: "primary",
    }, { operationId: "setup-edit-brief" });
    const revised = service.getProjectProjection(created.projectId);
    assert.equal(revised.materials.length, 2);
    assert.equal(revised.brief?.brief.topic, "如何建立可验证、可恢复的写作流程");
    assert.equal(revised.brief?.brief.audience, "企业内容负责人");
    assert.equal(revised.brief?.brief.lengthTarget.targetCharacters, 1600);
    assert.equal(revised.brief?.brief.confirmationStatus, "tentative");

    await bridge.confirmBrief({ operationId: "setup-confirm" });
    const confirmed = service.getProjectProjection(created.projectId).brief?.brief;
    assert.equal(confirmed?.confirmationStatus, "confirmed");
    assert.equal(confirmed?.authorAuthorization.directionDecision, "user_confirmed");

    const repeated = await bridge.createProject({
      name: "企业知识库文章",
      mode: "quick",
      topic: "如何建立可恢复的写作流程",
      genre: "practical_experience",
      audience: "企业 IT 负责人",
      targetCharacters: 1200,
      constraints: ["不得虚构数据", "保留失败经验"],
      interactionMode: "co_creation",
      authorVoice: "务实、具体",
      styleReference: "内部技术复盘",
      styleDecision: "user_confirmed",
      directionDecision: "tentative",
      platform: "企业知识库",
      publicationGoal: "primary",
      materials: [
        {
          name: "访谈纪要",
          content: "受访者强调：每次提交都要有版本记录。",
          role: "user_firsthand",
          sourceKind: "pasted_text",
          sourceReference: null,
        },
        {
          name: "产品文档",
          content: "恢复流程必须从已提交版本继续。",
          role: "source_verified",
          sourceKind: "web_snapshot",
          sourceReference: "https://example.test/recovery",
        },
      ],
    }, { operationId: "setup-operation" });
    assert.equal(repeated.projectId, created.projectId);
    assert.equal(service.listProjects().length, 1);
  } finally {
    bridge.dispose();
    storage.close();
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("a quick first-run project starts even when the desktop-wide budget allows two revisions", async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "wa-project-submit-"));
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({
    storage,
    provider: new ImmediateWorkflowProvider("project-setup-test"),
  });
  const bridge = createApplicationBridge({
    service,
    workspaceId: "submit-workspace",
    model: {
      model: "project-setup-model",
      providerLabel: "隔离回归模型",
      credentialReference: "TEST_ONLY",
      parameters: { temperature: 0, toolChoice: "auto" },
      budget: {
        maxModelRequests: 48,
        maxToolCalls: 64,
        maxRetriesPerRequest: 0,
        maxMajorRevisions: 2,
      },
    },
  });
  try {
    const created = await bridge.createProject({
      name: "快速写作",
      mode: "quick",
      topic: "提交回归",
      genre: "explanatory_analysis",
      audience: "测试人员",
      targetCharacters: 600,
      constraints: ["不得虚构数据"],
      interactionMode: "autonomous",
      authorVoice: null,
      styleReference: null,
      styleDecision: "unspecified",
      directionDecision: "tentative",
      platform: null,
      publicationGoal: "not_applicable",
      materials: [{
        name: "合成材料",
        content: "这是不访问外部模型的合成材料。",
        role: "source_verified",
        sourceKind: "pasted_text",
        sourceReference: null,
      }],
    }, { operationId: "quick-project" });

    await bridge.confirmBrief({ operationId: "quick-confirm" });
    const submitted = await bridge.sendMessage("请开始写作", {
      operationId: "quick-submit",
    });
    assert.equal(submitted.runId.length > 0, true);
    await waitUntil(() => service.getProjectProjection(created.projectId).runs[0]?.status === "completed");
  } finally {
    bridge.dispose();
    storage.close();
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
