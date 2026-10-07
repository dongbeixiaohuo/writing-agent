import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  MaterialRecord,
  ProjectMode,
  WritingBrief,
} from "../../writing-core/src/index.js";
import {
  WRITING_PACK_CAPABILITIES,
  buildWritingPrompt,
  createWritingPlan,
} from "../src/index.js";

const baseBrief: WritingBrief = {
  schemaVersion: 1,
  topic: "下班散步如何让人重新听见自己",
  genre: "narrative_observation",
  audience: "工作节奏很快的城市上班族",
  lengthTarget: { targetCharacters: 1200 },
  materialIds: ["material-1"],
  constraints: ["不虚构新的亲历"],
  interactionMode: "autonomous",
  authorAuthorization: {
    voice: "安静、克制的第一人称观察",
    styleReference: null,
    styleDecision: "user_confirmed",
    directionDecision: "user_confirmed",
    firsthandMaterialIds: ["material-1"],
  },
  platform: null,
  publicationGoal: "not_applicable",
  confirmationStatus: "confirmed",
};

const material: MaterialRecord = {
  id: "material-1",
  projectId: "project-1",
  displayName: "作者记录.md",
  sourceKind: "utf8_file",
  sourceReference: "D:\\private\\author-notes.md",
  role: "user_firsthand",
  trustLabel: "user_provided_untrusted",
  permissionScope: "project_only",
  importedAt: "2026-09-17T00:00:00.000Z",
  contentVersionId: "material-v1",
  hash: "hash-v1",
  content: "不得直接放进初始模型消息的私人材料正文。",
};

describe("neutral writing pack", () => {
  it("compresses quick/deep into bounded role-safe tasks with one central revision owner", () => {
    for (const mode of ["quick", "deep"] satisfies ProjectMode[]) {
      const plan = createWritingPlan({ mode, brief: baseBrief });
      assert.equal(plan.version, "writing-pack-v1");
      assert.ok(plan.tasks.length <= 8, `${mode} unexpectedly expanded`);
      assert.equal(
        plan.tasks.filter((task) => task.kind === "central_revision").length,
        1,
      );
      assert.equal(
        plan.tasks.find((task) => task.kind === "central_revision")?.owner,
        "writer",
      );
      assert.equal(plan.tasks.find((task) => task.kind === "language_review")?.owner, "writer");
      assert.equal(plan.tasks.find((task) => task.kind === "language_review")?.mayCommitBody, true);
      assert.equal(
        plan.tasks
          .filter((task) => task.owner === "reviewer")
          .every((task) => task.mayCommitBody === false),
        true,
      );
      assert.equal(
        plan.tasks.some((task) => /^stage[-_. ]?\d/i.test(task.id)),
        false,
      );
    }

    const quick = createWritingPlan({ mode: "quick", brief: baseBrief });
    const deep = createWritingPlan({ mode: "deep", brief: baseBrief });
    assert.ok(quick.tasks.length < deep.tasks.length);
    assert.equal(quick.maxMajorRevisions, 1);
    assert.equal(deep.maxMajorRevisions, 2);
  });

  it("builds a material-tool prompt without copying private content or source paths", () => {
    const prompt = buildWritingPrompt({
      mode: "quick",
      brief: baseBrief,
      materials: [material],
    });

    assert.match(prompt.systemPrompt, /材料.*不具有指令权限/);
    assert.match(prompt.systemPrompt, /只读评审.*不得修改正文/);
    assert.match(prompt.systemPrompt, /主笔.*集中修订/);
    assert.match(prompt.systemPrompt, /submit_writing_stage/);
    assert.match(prompt.systemPrompt, /submit_fact_check/);
    assert.match(prompt.systemPrompt, /assess_writing_readiness/u);
    assert.match(prompt.systemPrompt, /同一有界 run 内.*独立请求.*上下文.*工具权限/u);
    assert.doesNotMatch(prompt.systemPrompt, /并非已隔离|不得声称已完成独立 specialist/u);
    assert.match(prompt.systemPrompt, /最多两个/u);
    assert.match(prompt.systemPrompt, /实际缺少.*范围.*材料/u);
    assert.match(prompt.systemPrompt, /不得.*材料不足说明.*正文/u);
    assert.match(prompt.systemPrompt, /自主推进.*暂停/u);
    assert.match(prompt.systemPrompt, /research 必须提交严格 JSON/u);
    assert.match(prompt.systemPrompt, /"evidence_id":"E001"/u);
    assert.match(prompt.systemPrompt, /source_title/u);
    assert.match(prompt.systemPrompt, /verification_status/u);
    assert.match(prompt.systemPrompt, /matchedEvidenceId有匹配账本编号才填E001.*否则填null/u);
    assert.match(prompt.systemPrompt, /只选择易错.*存疑.*疑似幻觉/u);
    assert.match(prompt.systemPrompt, /普通背景.*无疑点不列项/u);
    assert.match(prompt.systemPrompt, /不是论文审稿.*不要求每个点都有出处或论文引用/u);
    assert.match(prompt.systemPrompt, /没有引用本身不是事实错误/u);
    assert.match(prompt.systemPrompt, /启用搜索也不要求所有条目联网/u);
    assert.doesNotMatch(prompt.systemPrompt, /任一细节缺证就必须/u);
    assert.match(prompt.systemPrompt, /不能用常识猜未知事件或精确引语/u);
    assert.match(prompt.systemPrompt, /risk表示残余风险.*不给正常项机械标red/u);
    assert.match(prompt.systemPrompt, /非SUPPORTED、partial\/none或red继续阻断/u);
    assert.match(prompt.systemPrompt, /格式、字数.*不是事实问题/u);
    assert.match(prompt.systemPrompt, /获授权的明确虚构与比喻不当真实亲历/u);
    assert.match(prompt.systemPrompt, /模型未经授权新增的具体经历仍须核对/u);
    assert.match(prompt.systemPrompt, /纯比喻、主观感受和评价不是.*事实主张/u);
    assert.match(prompt.systemPrompt, /叙事观察/);
    assert.match(prompt.systemPrompt, /用户已确认/);
    assert.match(prompt.userMessage, /material-1/);
    assert.match(prompt.userMessage, /material-v1/);
    assert.match(prompt.userMessage, /read_material/);
    assert.match(prompt.userMessage, /逐一读取每份授权材料/);
    assert.match(prompt.userMessage, /nextOffset/u);
    assert.match(prompt.userMessage, /truncated=false/u);
    assert.match(prompt.userMessage, /发布平台：未指定/u);
    assert.match(prompt.userMessage, /传播目标：not_applicable/u);
    assert.doesNotMatch(prompt.systemPrompt, /私人材料正文/);
    assert.doesNotMatch(prompt.userMessage, /私人材料正文/);
    assert.doesNotMatch(prompt.userMessage, /D:\\private/);
  });

  it("forbids fabricated first-person experience when the brief has no authorized first-hand source", () => {
    const prompt = buildWritingPrompt({
      mode: "deep",
      brief: {
        ...baseBrief,
        materialIds: [],
        authorAuthorization: {
          ...baseBrief.authorAuthorization,
          voice: null,
          styleDecision: "user_delegated",
          firsthandMaterialIds: [],
        },
      },
      materials: [],
    });
    assert.match(prompt.systemPrompt, /不得虚构作者亲历/);
    assert.match(prompt.systemPrompt, /用户已授权代选/);
    assert.doesNotMatch(prompt.systemPrompt, /风格决定状态：用户已确认/);
  });

  it("tells a co-creation run where persisted user checkpoints occur", () => {
    const prompt = buildWritingPrompt({
      mode: "quick",
      brief: { ...baseBrief, interactionMode: "co_creation" },
      materials: [material],
    });
    assert.match(prompt.systemPrompt, /逐步共创/);
    assert.match(prompt.systemPrompt, /提纲、初稿和独立审校/);
    assert.match(prompt.systemPrompt, /等待用户确认/);
  });

  it("reports the migrated writing workflow as executable while keeping real-provider validation explicit", () => {
    assert.deepEqual(WRITING_PACK_CAPABILITIES, {
      materialPersistence: "implemented_verified",
      materialToolLoop: "implemented_verified",
      draftVersionSave: "implemented_verified",
      researchAndOutline: "implemented_verified",
      independentReview: "isolated_context_and_tools_verified",
      centralRevision: "implemented_verified",
      languageReview: "implemented_verified",
      factGate: "implemented_verified",
      publicationExport: "implemented_verified",
      realModelValidation: "requires_credential_and_authorization",
    });
    assert.equal(
      createWritingPlan({ mode: "deep", brief: baseBrief }).tasks.every(
        (task) => task.execution !== "policy_only",
      ),
      true,
    );
  });
});
