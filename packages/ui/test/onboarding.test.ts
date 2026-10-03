import assert from "node:assert/strict";
import test from "node:test";

import {
  commandErrorMessage,
  dataActionErrorMessage,
  materialPatchFromFile,
  normalizeBriefUpdate,
  normalizeProjectSetup,
  normalizeProviderSetup,
  providerConnectionMessage,
  setupErrorMessage,
  styleReferenceFromFile,
} from "../src/shell/onboarding.js";

test("brief editing validates and normalizes user changes without touching materials", () => {
  assert.deepEqual(normalizeBriefUpdate({
    topic: "  更新主题 ",
    genre: "explanatory_analysis",
    audience: " 内容负责人 ",
    targetCharacters: "1600",
    constraints: " 不虚构\n说明边界 ",
    interactionMode: "autonomous",
    authorVoice: " 清楚 ",
    styleReference: "",
    styleDecision: "user_delegated",
    directionDecision: "user_confirmed",
    platform: " 知识库 ",
    publicationGoal: "primary",
  }), {
    topic: "更新主题",
    genre: "explanatory_analysis",
    audience: "内容负责人",
    targetCharacters: 1600,
    constraints: ["不虚构", "说明边界"],
    interactionMode: "autonomous",
    authorVoice: "清楚",
    styleReference: null,
    styleDecision: "user_delegated",
    directionDecision: "user_confirmed",
    platform: "知识库",
    publicationGoal: "primary",
  });
});

test("local TXT and Markdown materials are read as private UTF-8 snapshots", async () => {
  assert.deepEqual(
    await materialPatchFromFile({
      name: " interview.md ",
      size: 18,
      text: async () => "访谈正文",
    }),
    {
      name: "interview.md",
      content: "访谈正文",
      sourceKind: "utf8_file",
      sourceReference: "interview.md",
    },
  );
  await assert.rejects(
    materialPatchFromFile({ name: "secret.pdf", size: 10, text: async () => "x" }),
    /PROJECT_MATERIAL_FILE_TYPE_INVALID/u,
  );
});

test("a local style file keeps its source name and bounded UTF-8 content", async () => {
  assert.equal(
    await styleReferenceFromFile({
      name: " house-style.md ",
      size: 40,
      text: async () => "短句；避免营销腔。",
    }),
    "[导入风格文件：house-style.md]\n短句；避免营销腔。",
  );
  await assert.rejects(
    styleReferenceFromFile({ name: "style.pdf", size: 10, text: async () => "x" }),
    /PROJECT_STYLE_FILE_TYPE_INVALID/u,
  );
});

test("project onboarding normalizes a complete user-confirmed setup", () => {
  assert.deepEqual(normalizeProjectSetup({
    name: "  产品说明  ",
    mode: "quick",
    topic: "  新品发布  ",
    genre: "argument_commentary",
    audience: " 企业客户 ",
    targetCharacters: "1200",
    constraints: " 不虚构数据\n避免营销腔 ",
    interactionMode: "co_creation",
    authorVoice: " 直接、克制 ",
    styleReference: " 既有公众号文章 ",
    styleDecision: "user_confirmed",
    directionDecision: "user_delegated",
    platform: " 微信公众号 ",
    publicationGoal: "primary",
    materials: [
      {
        name: " 访谈纪要 ",
        content: " 真实材料内容 ",
        role: "user_firsthand",
        sourceKind: "pasted_text",
        sourceReference: "",
      },
      {
        name: " 官方页面 ",
        content: " 页面快照内容 ",
        role: "source_verified",
        sourceKind: "web_snapshot",
        sourceReference: " https://example.test/source ",
      },
    ],
  }), {
    name: "产品说明",
    mode: "quick",
    topic: "新品发布",
    genre: "argument_commentary",
    audience: "企业客户",
    targetCharacters: 1200,
    constraints: ["不虚构数据", "避免营销腔"],
    interactionMode: "co_creation",
    authorVoice: "直接、克制",
    styleReference: "既有公众号文章",
    styleDecision: "user_confirmed",
    directionDecision: "user_delegated",
    platform: "微信公众号",
    publicationGoal: "primary",
    materials: [
      {
        name: "访谈纪要",
        content: "真实材料内容",
        role: "user_firsthand",
        sourceKind: "pasted_text",
        sourceReference: null,
      },
      {
        name: "官方页面",
        content: "页面快照内容",
        role: "source_verified",
        sourceKind: "web_snapshot",
        sourceReference: "https://example.test/source",
      },
    ],
  });
  assert.throws(
    () => normalizeProjectSetup({
      name: "空材料",
      mode: "quick",
      topic: "主题",
      genre: "explanatory_analysis",
      audience: "读者",
      targetCharacters: "800",
      constraints: "",
      interactionMode: "autonomous",
      authorVoice: "",
      styleReference: "",
      styleDecision: "unspecified",
      directionDecision: "tentative",
      platform: "",
      publicationGoal: "not_applicable",
      materials: [{
        name: "材料",
        content: "   ",
        role: "source_verified",
        sourceKind: "pasted_text",
        sourceReference: "",
      }],
    }),
    /PROJECT_MATERIAL_REQUIRED/u,
  );

  assert.throws(
    () => normalizeProjectSetup({
      name: "网页材料",
      mode: "deep",
      topic: "主题",
      genre: "explanatory_analysis",
      audience: "读者",
      targetCharacters: "1600",
      constraints: "",
      interactionMode: "autonomous",
      authorVoice: "",
      styleReference: "",
      styleDecision: "unspecified",
      directionDecision: "tentative",
      platform: "",
      publicationGoal: "not_applicable",
      materials: [{
        name: "网页",
        content: "快照",
        role: "source_verified",
        sourceKind: "web_snapshot",
        sourceReference: "not-a-url",
      }],
    }),
    /PROJECT_MATERIAL_URL_INVALID/u,
  );
});

test("provider onboarding requires HTTPS and never invents a credential", () => {
  assert.deepEqual(normalizeProviderSetup({
    kind: "openai_compatible",
    providerId: " example ",
    baseURL: " https://api.example.test/v1 ",
    model: " model-1 ",
    tools: "supported",
    usage: "reported",
    apiKey: " secret-not-real ",
    persistence: "system",
  }), {
    kind: "openai_compatible",
    providerId: "example",
    baseURL: "https://api.example.test/v1",
    model: "model-1",
    tools: "supported",
    usage: "reported",
    apiKey: "secret-not-real",
    persistence: "system",
  });
  assert.throws(
    () => normalizeProviderSetup({
      kind: "openai_compatible",
      providerId: "example",
      baseURL: "http://api.example.test/v1",
      model: "model-1",
      tools: "supported",
      usage: "unknown",
      apiKey: "secret-not-real",
      persistence: "session",
    }),
    /PROVIDER_HTTPS_REQUIRED/u,
  );
});

test("onboarding errors are translated into actionable Chinese copy", () => {
  assert.equal(
    setupErrorMessage(new Error("PROJECT_NAME_REQUIRED"), "项目创建失败"),
    "请填写项目名称。",
  );
  assert.equal(
    setupErrorMessage(new Error("PROVIDER_URL_REQUIRED"), "模型配置保存失败"),
    "请填写 API 地址。",
  );
  assert.equal(
    setupErrorMessage(new Error("SOMETHING_UNEXPECTED"), "项目创建失败"),
    "项目创建失败：SOMETHING_UNEXPECTED",
  );
  assert.equal(setupErrorMessage(null, "项目创建失败"), "项目创建失败");
});

test("desktop command failures become visible user actions instead of transport text", () => {
  const generic = Object.assign(new Error("Desktop command failed"), {
    code: "DESKTOP_COMMAND_FAILED",
  });
  assert.equal(
    commandErrorMessage(generic, "写作命令提交失败"),
    "本次操作未能完成，原因尚未确认。请重试；若仍失败，请反馈操作位置和时间。",
  );

  const active = Object.assign(new Error("Desktop command failed"), {
    code: "RUN_ALREADY_ACTIVE",
  });
  assert.equal(
    commandErrorMessage(active, "写作命令提交失败"),
    "已有写作任务正在运行，请等待完成或先停止。",
  );

  const feedbackTooLong = Object.assign(new Error("Desktop command failed"), {
    code: "CHECKPOINT_FEEDBACK_TOO_LONG",
  });
  assert.equal(
    commandErrorMessage(feedbackTooLong, "继续运行失败"),
    "本次修改意见过长，请精简到 4,000 字符以内。",
  );

  assert.equal(
    commandErrorMessage(new Error("CHECKPOINT_DECISION_REQUIRED"), "继续运行失败"),
    "请先回复当前共创节点；只有经过本轮对话确认后才会继续。",
  );
  assert.equal(
    commandErrorMessage(new Error("INTENT_CONTEXT_STALE"), "继续运行失败"),
    "等待确认的内容已变化，本次未继续。请查看最新回复后重新确认。",
  );
  assert.equal(
    commandErrorMessage(new Error("RUN_NOT_RECOVERABLE"), "继续运行失败"),
    "这个等待项已处理或已失效，未重复执行。请查看最新进度。",
  );
});

test("diagnostic and migration failures explain the safe next action", () => {
  // Electron contextBridge retains only standard Error fields, not custom code.
  assert.equal(dataActionErrorMessage(new Error("PROJECT_DELETE_RUN_ACTIVE"), "删除失败"),
    "这个项目仍在写作中。请先停止该项目的任务，再删除；其他项目不受影响。");
  assert.match(dataActionErrorMessage(new Error("STORAGE_WRITE_FAILED"), "删除失败"), /已回滚/);
  assert.equal(
    dataActionErrorMessage(
      Object.assign(new Error("Desktop command failed"), { code: "TARGET_SPACE_INSUFFICIENT" }),
      "旧项目扫描失败",
    ),
    "可用磁盘空间不足，无法安全备份并导入。",
  );
  assert.equal(
    dataActionErrorMessage(
      Object.assign(new Error("Desktop command failed"), { code: "DIAGNOSTIC_TARGET_EXISTS" }),
      "诊断包导出失败",
    ),
    "所选文件已经存在，请换一个文件名后重试。",
  );
});

test("model connection results explain what the user must correct", () => {
  assert.deepEqual(
    providerConnectionMessage({
      ok: false,
      provider: "primary",
      model: "minimax",
      adapterVersion: "anthropic-messages-v1",
      stage: "model",
      errorCode: "MODEL_UNSUPPORTED",
      retryable: false,
    }),
    {
      tone: "failure",
      text: "模型名称不可用，请检查服务商提供的模型 ID。",
    },
  );
  assert.deepEqual(
    providerConnectionMessage({
      ok: false,
      provider: "primary",
      model: "deepseek-flash",
      adapterVersion: "openai-responses-v1",
      stage: "provider",
      errorCode: "INVALID_REQUEST",
      retryable: false,
      providerDetail: "unknown parameter: include",
    }),
    {
      tone: "failure",
      text: "服务拒绝了测试请求，请检查服务类型、API 地址和模型 ID。（上游返回：unknown parameter: include）",
    },
  );
  assert.deepEqual(
    providerConnectionMessage({
      ok: true,
      provider: "primary",
      model: "valid-model",
      adapterVersion: "test-v1",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    }),
    {
      tone: "success",
      text: "连接验证通过：鉴权、模型、流式响应和工具调用均可用。",
    },
  );
});
