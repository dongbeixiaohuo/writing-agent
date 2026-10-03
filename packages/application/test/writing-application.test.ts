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
import type { WritingBrief } from "../../writing-core/src/index.js";
import { ApplicationServiceError, WritingApplicationService } from "../src/index.js";
import { assertCleanBodyStageContent } from "../src/workflow-tools.js";

it('keeps postscript process notes out of body versions and accepts cleanup of legacy baselines', () => {
  const article = '# 保留的标题\n\n我坐在窗边，看着晚风拂过树梢。\n\n屋里很安静，我把杯子放下。';
  const legacy = article + '\n\n---\n\n**改动说明（三处）：**\n\n' + '减少冗余表达，保留作者原意。'.repeat(15);
  assert.throws(() => assertCleanBodyStageContent('central_revision', legacy));
  assert.doesNotThrow(() => assertCleanBodyStageContent('language_review', article.replace('很安静', '安静'), legacy));
  assert.throws(() => assertCleanBodyStageContent('language_review', article.replace('# 保留的标题\n\n', ''), legacy), (error: any) => error.code === 'BODY_STAGE_STRUCTURE_MISMATCH' && error.details.requiredHeadings[0] === '# 保留的标题');
  assert.doesNotThrow(() => assertCleanBodyStageContent('language_review', '窗边的风吹进屋里。\n\n我把杯子放下。', '我坐在窗边。\n\n我把杯子放下。'));
});
import { collaborationState, directorFixtureTurn, publicStageFixtureEvents } from "./collaboration-fixture.js";
import { getPublicationCandidates, choosePublicationCandidate } from '../src/publication-choice.js';

const user = { kind: "user", id: "user-1" } as const;

describe("workflow body output contract", () => {
  it("preserves the bound article structure during minimal language polishing", () => {
    const baseline = "# 安静\n\n## 清晨\n\n窗边的光缓慢移动。".repeat(12);
    assert.throws(() => assertCleanBodyStageContent("language_review", "# 安静\n\n这篇文章很好。", baseline), /complete article/u);
    assert.doesNotThrow(() => assertCleanBodyStageContent("language_review", "无声。", "无声。"));
    assert.throws(() => assertCleanBodyStageContent("language_review", "审校完成。\n\n文章整体清晰，节奏自然，建议维持当前写法，没有明显问题。", "一次安静的散步\n\n我沿着河边走，耳边只剩下风声。"), /complete article/u);
  });
  it("rejects language-review commentary wrapped around the final article", () => {
    assert.throws(
      () => assertCleanBodyStageContent(
        "language_review",
        "# 语言终审\n\n结论：保留原稿。\n\n终稿如下：\n\n# 真正标题\n\n正文。",
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "BODY_STAGE_CONTAINS_PROCESS_NOTES",
    );
  });

  it("accepts an article-only final body", () => {
    assert.doesNotThrow(() => assertCleanBodyStageContent(
      "language_review",
      "# 真正标题\n\n这是可以直接交付的正文。",
    ));
  });
  it("rejects a language review report that would overwrite the article, while accepting plain titles", () => {
    assert.throws(() => assertCleanBodyStageContent("language_review", "本稿语言底子良好。\n\n建议优先处理：句子长度和节奏。\n\n整体可保留。"), /complete article/u);
    assert.doesNotThrow(() => assertCleanBodyStageContent("language_review", "一次安静的散步\n\n我沿着河边走，耳边只剩下风声。"));
    for (const report of ["无需修改，当前表达已经清晰。", "整体表达流畅，没有需要调整的地方。", "未发现明显问题。"])
      assert.throws(() => assertCleanBodyStageContent("language_review", report), /complete article/u);
  });
});

const brief: WritingBrief = {
  schemaVersion: 1,
  topic: "一次安静的下班散步",
  genre: "narrative_observation",
  audience: "忙碌的城市上班族",
  lengthTarget: { targetCharacters: 800 },
  materialIds: ["material-1"],
  constraints: ["只使用材料中的亲历细节"],
  interactionMode: "autonomous",
  authorAuthorization: {
    voice: "克制、具体",
    styleReference: null,
    styleDecision: "user_confirmed",
    directionDecision: "user_confirmed",
    firsthandMaterialIds: ["material-1"],
  },
  platform: null,
  publicationGoal: "not_applicable",
  confirmationStatus: "confirmed",
};

class MaterialThenDraftProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly materialId: string,
    private readonly contentVersionId: string,
  ) {
    super("writing-closure-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const directorTurn = directorFixtureTurn(request);
    if (directorTurn !== null) { yield* directorTurn; return; }
    const collaboration = collaborationState(request);
    const expert = collaboration !== null && collaboration.actor !== "director";
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    const currentDraftVersionId = request.messages
      .find((message) => message.role === "user")
      ?.content.match(/当前正文版本：([^。；\s]+)/u)?.[1];
    if (
      !expert && currentDraftVersionId !== undefined && collaboration?.unreadArtifactVersionIds.includes(currentDraftVersionId) &&
      !toolMessages.some((message) =>
        message.role === "tool" && message.name === "read_artifact_version"
      )
    ) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-read-current-draft",
        name: "read_artifact_version",
        argumentsDelta: JSON.stringify({ versionId: currentDraftVersionId }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const cachedMaterials = (collaboration as unknown as { materials?: { materialId: string }[] } | null)?.materials ?? [];
    if (!expert && !cachedMaterials.some(m => m.materialId === this.materialId) && !toolMessages.some((message) => message.role === "tool" && message.name === "read_material")) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-read-material",
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 0,
          maxChars: 20_000,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    if (!expert && !toolMessages.some(
      (message) => message.role === "tool" && message.name === "assess_writing_readiness",
    )) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-writing-ready",
        name: "assess_writing_readiness",
        argumentsDelta: JSON.stringify({
          status: "ready",
          reason: "已读取授权材料和当前执行段要求的上下文，可以继续。",
          questions: [],
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const submittedStages = toolMessages
      .filter((message) => message.role === "tool" && message.name === "submit_writing_stage")
      .map((message) => {
        if (message.role !== "tool") return "";
        const result = JSON.parse(message.content) as { result?: { stage?: string } };
        return result.result?.stage ?? "";
      });
    const factSubmitted = toolMessages.some(
      (message) => message.role === "tool" && message.name === "submit_fact_check",
    );
    const deepMode = request.messages.some(
      (message) => message.role === "system" && message.content.includes("review_publish"),
    );
    const stages: readonly (readonly [string, string])[] = [
      ["research", "# 研究与证据\n\n仅使用授权材料；未发现需要外部补证的数据。"],
      ["outline", "# 结构\n\n1. 下班后的环境\n2. 身体重新感知\n3. 留给读者的方法"],
      ["draft", "# 一次安静的下班散步\n\n我沿着河边走了二十分钟，终于听见鞋底与路面的摩擦声。"],
      ["review_editor", "结构清楚；第二段需要更具体，禁止补造经历。"],
      ...(deepMode
        ? [["review_publish", "发布边界清楚；建议保留克制表达。"]] as const
        : []),
      ["review_reader", "读者能理解方法，但开头可以更快进入现场。"],
      ["central_revision", "# 一次安静的下班散步\n\n下班后的河边，我走了二十分钟。鞋底与路面的摩擦声，让一天第一次慢下来。"],
      ["language_review", "# 一次安静的下班散步\n\n下班后的河边，我走了二十分钟。鞋底擦过路面的声音，让这一天第一次慢下来。"],
    ];
    const next = expert ? stages.find(([stage]) => stage === collaboration.stage) : stages[submittedStages.length];
    if (next !== undefined) {
      const prose = publicStageFixtureEvents(request, 'submit_writing_stage', { stage: next[0], content: next[1] });
      if (prose) { yield* prose; return; }
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `call-stage-${next[0]}`,
        name: "submit_writing_stage",
        argumentsDelta: JSON.stringify({ stage: next[0], content: next[1] }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    if (!factSubmitted) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-fact-check",
        name: "submit_fact_check",
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: "正文只包含已授权的一手感受，没有需要外部核实的事实主张。",
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield {
      type: "text_delta",
      delta: "完整写作工作流已执行；最终稿、评审和核查结果均已保存。",
    };
    yield {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
    };
    yield { type: "completed", finishReason: "stop" };
  }
}

class FactCheckOnlyProvider extends ModelProviderBase {
  constructor(
    private readonly bodyVersionId: string,
    private readonly evidenceVersionId: string,
  ) {
    super("fact-check-only-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const context = JSON.parse(request.messages.find(message => message.role === 'user')!.content);
    assert.equal(context.authorizedMaterials[0].materialId, 'material-1');
    assert.ok(context.authorizedMaterials[0].content.length > 0);
    assert.equal(context.authorizedMaterials[0].instructionAuthority, 'none');
    assert.ok(context.authorizedMaterials[0].role);
    const artifactReads = request.messages.filter(
      (message) => message.role === "tool" && message.name === "read_artifact_version",
    );
    if (artifactReads.length < 2) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `fact-read-${artifactReads.length}`,
        name: "read_artifact_version",
        argumentsDelta: JSON.stringify({
          versionId: artifactReads.length === 0
            ? this.bodyVersionId
            : this.evidenceVersionId,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const factSubmitted = request.messages.some(
      (message) => message.role === "tool" && message.name === "submit_fact_check",
    );
    if (!factSubmitted) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "fact-only-submit",
        name: "submit_fact_check",
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: "修改后的正文仍只包含授权的一手感受。",
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "当前正文的事实核查已经保存。" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class ResearchBeforeReadingProvider extends ModelProviderBase {
  constructor() {
    super("research-before-reading-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const attempted = request.messages.some(
      (message) => message.role === "tool" && message.name === "director_decide",
    );
    if (!attempted) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-research-without-reading",
        name: "director_decide",
        argumentsDelta: JSON.stringify({
          action: "dispatch", stage: "research", reason: "没有读取材料就直接分派研究。", inputVersionIds: [], questions: [],
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "已结束。" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class MissingInputProvider extends ModelProviderBase {
  constructor() {
    super("missing-input-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    yield {
      type: "tool_call_delta",
      index: 0,
      id: "assess-missing-input",
      name: "assess_writing_readiness",
      argumentsDelta: JSON.stringify({
        status: "needs_input",
        reason: "缺少文章要回应的具体经历",
        questions: ["这篇文章要围绕哪一次真实经历展开？"],
      }),
    };
    yield {
      type: "tool_call_delta",
      index: 1,
      id: "must-not-run-after-pause",
      name: "assess_writing_readiness",
      argumentsDelta: JSON.stringify({
        status: "ready", reason: "不能绕过输入缺口。", questions: [],
      }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class ReassessAfterAnswerProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor() {
    super("reassess-after-answer-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    yield {
      type: "tool_call_delta",
      index: 0,
      id: "reassess-still-missing",
      name: "assess_writing_readiness",
      argumentsDelta: JSON.stringify({
        status: "needs_input",
        reason: "回答仍未指定可写的真实事件",
        questions: ["请指定一件希望文章展开的真实事件。"],
      }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class PrematureReadyProvider extends ModelProviderBase {
  constructor() {
    super("premature-ready-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const readinessAttempted = request.messages.some(
      (message) => message.role === "tool" && message.name === "assess_writing_readiness",
    );
    yield {
      type: "tool_call_delta",
      index: 0,
      id: readinessAttempted ? "pause-after-premature-ready" : "premature-ready",
      name: "assess_writing_readiness",
      argumentsDelta: JSON.stringify(readinessAttempted
        ? {
            status: "needs_input",
            reason: "需要先恢复必读上下文",
            questions: ["是否继续读取已保存上下文？"],
          }
        : {
            status: "ready",
            reason: "尚未读取要求的输入就错误地声称已就绪。",
            questions: [],
          }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class MaterialThenPrematureReadyProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly materialId: string,
    private readonly contentVersionId: string,
  ) {
    super("material-then-premature-ready-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    if (!toolMessages.some(
      (message) => message.role === "tool" && message.name === "read_material",
    )) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "recovery-read-material",
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 0,
          maxChars: 20_000,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const readinessAttempted = toolMessages.some(
      (message) => message.role === "tool" && message.name === "assess_writing_readiness",
    );
    yield {
      type: "tool_call_delta",
      index: 0,
      id: readinessAttempted ? "recovery-pause-after-failed-ready" : "recovery-ready-without-body",
      name: "assess_writing_readiness",
      argumentsDelta: JSON.stringify(readinessAttempted
        ? {
            status: "needs_input",
            reason: "仍需读取恢复绑定的当前正文",
            questions: ["是否读取恢复绑定的当前正文？"],
          }
        : {
            status: "ready",
            reason: "已读材料但错误地跳过了当前正文。",
            questions: [],
          }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class SlicedMaterialReadinessProvider extends ModelProviderBase {
  constructor(
    private readonly materialId: string,
    private readonly contentVersionId: string,
  ) {
    super("sliced-material-readiness-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    const materialReads = toolMessages.filter(
      (message) => message.role === "tool" && message.name === "read_material",
    ).length;
    const assessments = toolMessages.filter(
      (message) => message.role === "tool" && message.name === "assess_writing_readiness",
    ).length;
    if (materialReads === 0) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "read-first-character",
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 0,
          maxChars: 1,
        }),
      };
    } else if (assessments === 0 || materialReads === 2 && assessments === 1) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: assessments === 0 ? "ready-after-partial-read" : "ready-after-complete-read",
        name: "assess_writing_readiness",
        argumentsDelta: JSON.stringify({
          status: "ready",
          reason: assessments === 0
            ? "错误地把一个字符视为完整材料。"
            : "已通过连续切片读取完整授权材料。",
          questions: [],
        }),
      };
    } else if (materialReads === 1) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "read-remaining-characters",
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 1,
          maxChars: 20_000,
        }),
      };
    } else {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "pause-after-complete-sliced-read",
        name: "assess_writing_readiness",
        argumentsDelta: JSON.stringify({
          status: "needs_input",
          reason: "切片读取门禁测试结束",
          questions: ["是否继续正式写作？"],
        }),
      };
    }
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class CheckpointWorkflowProvider extends ModelProviderBase {
  constructor(
    private readonly materialId: string,
    private readonly contentVersionId: string,
  ) {
    super("checkpoint-workflow-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const directorTurn = directorFixtureTurn(request);
    if (directorTurn !== null) { yield* directorTurn; return; }
    const collaboration = collaborationState(request);
    const expert = collaboration !== null && collaboration.actor !== "director";
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    const userMessage = request.messages.find((message) => message.role === "user");
    if (collaboration?.actor === 'title') {
      yield { type: 'tool_call_delta', index: 0, id: `title-${request.requestId}`, name: 'submit_publication_candidates',
        argumentsDelta: JSON.stringify({ candidates: [{ title: '观察日常', opening: null, distributionCopy: null, rationale: '与正文一致的观察方向' }] }) };
      yield { type: 'completed', finishReason: 'tool_calls' }; return;
    }
    const continuation = userMessage?.role === "user"
      ? userMessage.content.match(/下一必需阶段：([a-z_]+)/u)?.[1]
      : undefined;
    const recoveryContextMatch = userMessage?.role === "user"
      ? userMessage.content.match(/恢复必读上下文：(\[[^\n]+\])/u)
      : null;
    if (continuation !== undefined && recoveryContextMatch === null && collaboration === null) {
      throw new Error("resumed workflow did not identify its persisted context artifacts");
    }
    const recoveryContext = recoveryContextMatch === null
      ? (collaboration?.unreadArtifactVersionIds ?? []).map(artifactVersionId => ({ stage: 'current', artifactVersionId }))
      : JSON.parse(recoveryContextMatch[1] ?? "[]") as Array<{
          stage: string;
          artifactVersionId: string;
        }>;
    const completedArtifactReads = new Set(toolMessages.flatMap((message) => {
      if (message.role !== "tool" || message.name !== "read_artifact_version") return [];
      const envelope = JSON.parse(message.content) as { result?: { versionId?: string } };
      return typeof envelope.result?.versionId === "string" ? [envelope.result.versionId] : [];
    }));
    const unreadContext = recoveryContext.filter(entry => collaboration?.unreadArtifactVersionIds.includes(entry.artifactVersionId)).find(
      (entry) => !completedArtifactReads.has(entry.artifactVersionId),
    );
    if (!expert && unreadContext !== undefined) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `checkpoint-context-${unreadContext.stage}-${request.requestId}`,
        name: "read_artifact_version",
        argumentsDelta: JSON.stringify({ versionId: unreadContext.artifactVersionId }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    let nextStage = continuation;
    if (!expert && !collaboration?.materials.some(m => m.materialId === this.materialId) && !toolMessages.some(
      (message) => message.role === "tool" && message.name === "read_material",
    )) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `checkpoint-read-${request.requestId}`,
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 0,
          maxChars: 20_000,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    if (!expert && !toolMessages.some(
      (message) => message.role === "tool" && message.name === "assess_writing_readiness",
    )) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `checkpoint-ready-${request.requestId}`,
        name: "assess_writing_readiness",
        argumentsDelta: JSON.stringify({
          status: "ready",
          reason: "已读取本执行段要求的材料与恢复上下文，可以继续。",
          questions: [],
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const latestTool = toolMessages.at(-1);
    if (latestTool?.role === "tool") {
      if (latestTool.name === "read_material") {
        nextStage = continuation ?? "research";
      } else if (latestTool.name === "read_artifact_version") {
        nextStage = continuation;
      } else {
        const result = JSON.parse(latestTool.content) as {
          result?: { nextStage?: string | null; stage?: string };
        };
        if (result.result?.stage === "fact_check") {
          yield { type: "text_delta", delta: "共创写作流程已完成。" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        nextStage = result.result?.nextStage ?? undefined;
      }
    }
    if (expert) nextStage = collaboration.stage ?? undefined;
    if (nextStage === "fact_check") {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `checkpoint-fact-${request.requestId}`,
        name: "submit_fact_check",
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: "正文只使用授权的一手材料。",
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const content: Readonly<Record<string, string>> = {
      research: JSON.stringify({ claims: [], notes: "只使用授权材料。" }),
      outline: "# 共创提纲\n\n1. 场景\n2. 观察\n3. 收束",
      draft: "# 共创初稿\n\n这是等待用户确认的完整初稿。",
      review_editor: "必须修改：无。\n可选优化：补充节奏。\n建议保留：真实视角。",
      review_reader: "必须修改：无。\n可选优化：开头更直接。\n建议保留：结尾。",
      central_revision: "# 共创修订稿\n\n这是经过独立审校后的集中修订稿。",
      language_review: "# 共创修订稿\n\n这是经过语言终审的共创稿件。",
    };
    if (nextStage === undefined || content[nextStage] === undefined) {
      throw new Error(`unexpected checkpoint stage ${String(nextStage)}`);
    }
    const prose = publicStageFixtureEvents(request, 'submit_writing_stage', { stage: nextStage, content: content[nextStage] });
    if (prose) { yield* prose; return; }
    yield {
      type: "tool_call_delta",
      index: 0,
      id: `checkpoint-${nextStage}-${request.requestId}`,
      name: "submit_writing_stage",
      argumentsDelta: JSON.stringify({ stage: nextStage, content: content[nextStage] }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

function seedWritingInputs(
  service: WritingApplicationService,
  writingBrief: WritingBrief = brief,
  mode: "quick" | "deep" = "quick",
  materialContent = "下班后我沿着河边走了二十分钟。",
): { readonly contentVersionId: string; readonly projectRevision: number } {
  const created = service.createProject({
    operationId: "create-project",
    projectId: "project-1",
    name: "文章闭环",
    mode,
    actor: user,
  });
  assert.equal(created.ok, true);
  const imported = service.importMaterial({
    operationId: "import-material",
    projectId: "project-1",
    expectedProjectRevision: 0,
    materialId: "material-1",
    displayName: "散步记录.md",
    sourceKind: "utf8_file",
    sourceReference: "D:\\private\\散步记录.md",
    role: "user_firsthand",
    trustLabel: "user_provided_untrusted",
    permissionScope: "project_only",
    content: materialContent,
    actor: user,
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) throw new Error("fixture material import failed");
  const saved = service.saveWritingBrief({
    operationId: "save-brief",
    projectId: "project-1",
    expectedProjectRevision: 1,
    baseVersionId: null,
    brief: writingBrief,
    actor: user,
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("fixture brief save failed");
  return {
    contentVersionId: imported.result.contentVersionId,
    projectRevision: saved.projectRevision,
  };
}

describe("WritingApplicationService draft closure", () => {
  it("waits for required writing input and skips later tools from the same response", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-input-required-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const service = new WritingApplicationService({
      storage,
      provider: new MissingInputProvider(),
    });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 2,
          maxToolCalls: 2,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "USER_CONFIRMATION_REQUIRED");
      assert.equal(storage.getRun(result.runId)?.status, "waiting_user");
      assert.equal(storage.getRun(result.runId)?.stopReason, "WRITING_INPUT_REQUIRED");
      assert.deepEqual(
        storage.listRunEvents(result.runId)
          .filter((event) => event.type === "tool.requested")
          .map((event) => event.payload.toolName),
        ["assess_writing_readiness"],
      );
      assert.equal(
        storage.listArtifactVersions("project-1", "evidence", "main").length,
        0,
      );
      const waiting = storage.listRunEvents(result.runId)
        .find((event) => event.type === "run.waiting_user");
      assert.deepEqual(waiting?.payload.questions, [
        "这篇文章要围绕哪一次真实经历展开？",
      ]);
      assert.equal(waiting?.payload.nextStage, "research");
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects an empty answer before mutating an input-waiting run; nonempty replies belong to readiness assessment", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-input-answer-required-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const service = new WritingApplicationService({
      storage,
      provider: new MissingInputProvider(),
    });

    try {
      const waiting = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
      });
      assert.equal(waiting.ok, false);
      if (waiting.ok) return;
      const beforeEvents = storage.listRunEvents(waiting.runId);
      const project = storage.inspectProject("project-1")!;

      for (const [index, answer] of [
        "",
        "   ",
      ].entries()) {
        assert.throws(
          () => service.resumeDraft({
            projectId: "project-1",
            runId: waiting.runId,
            operationId: `resume-without-answer-${index}`,
            decision: "resume",
            expectedProjectRevision: project.revision,
            expectedBriefVersionId: project.currentBriefVersionId!,
            model: "mock-writing-model",
            userInstruction: answer,
            parameters: { temperature: 0, toolChoice: "auto" },
          }),
          (error: unknown) =>
            error instanceof ApplicationServiceError &&
            error.code === "WRITING_INPUT_ANSWER_REQUIRED",
          `expected empty answer to be rejected: ${answer}`,
        );
      }
      assert.equal(storage.getRun(waiting.runId)?.status, "waiting_user");
      assert.equal(storage.getRun(waiting.runId)?.stopReason, "WRITING_INPUT_REQUIRED");
      assert.deepEqual(storage.listRunEvents(waiting.runId), beforeEvents);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reopens an input-waiting run with persisted questions and reassesses an inadequate answer", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-input-reopen-"));
    let storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const firstService = new WritingApplicationService({
      storage,
      provider: new MissingInputProvider(),
    });

    try {
      const first = await firstService.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
      });
      assert.equal(first.ok, false);
      if (first.ok) return;
      const runId = first.runId;
      storage.close();

      storage = openWorkspaceStorage({ workspacePath });
      const provider = new ReassessAfterAnswerProvider();
      const reopenedService = new WritingApplicationService({ storage, provider });
      const project = storage.inspectProject("project-1")!;
      const answer = "发生在去年，但我还没有选定要写哪一件事。";
      const second = await reopenedService.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId,
        operationId: "resume-with-inadequate-answer",
        decision: "resume",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: answer,
        parameters: { temperature: 0, toolChoice: "auto" },
      })).result;

      assert.equal(second.runId, runId);
      assert.equal(second.ok, false);
      if (second.ok) return;
      assert.equal(storage.getRun(runId)?.status, "waiting_user");
      assert.equal(storage.getRun(runId)?.stopReason, "WRITING_INPUT_REQUIRED");
      const userMessage = provider.requests[0]?.messages.find(
        (message) => message.role === "user",
      )?.content ?? "";
      assert.match(userMessage, /历史输入问答/u);
      assert.match(userMessage, /这篇文章要围绕哪一次真实经历展开/u);
      assert.match(userMessage, new RegExp(answer, "u"));
      assert.match(userMessage, /不可信用户事实信息/u);
      assert.doesNotMatch(userMessage, /source_verified/u);
      const events = storage.listRunEvents(runId);
      const resumed = events.find((event) => event.type === "run.resumed");
      assert.equal(resumed?.payload.displayInstruction, answer);
      const waits = events.filter((event) => event.type === "run.waiting_user");
      assert.equal(waits.length, 2);
      assert.deepEqual(waits[1]?.payload.questions, [
        "请指定一件希望文章展开的真实事件。",
      ]);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("restores the original edit goal and bound current body after input-required recovery", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-edit-input-recovery-"));
    let storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const seededBody = storage.commitArtifactVersion({
      operationId: "seed-current-body-before-input-pause",
      projectId: "project-1",
      expectedProjectRevision: seeded.projectRevision,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 原稿\n\n这是必须读取后才能继续编辑的现有正文。",
      reason: "测试现有正文恢复绑定",
      requestSnapshotId: null,
      actor: user,
    });
    assert.equal(seededBody.ok, true);
    if (!seededBody.ok) return;
    const firstService = new WritingApplicationService({
      storage,
      provider: new MissingInputProvider(),
    });

    try {
      const originalGoal = "把现稿压到800字，并保留原来的现场感。";
      const first = await firstService.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seededBody.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: originalGoal,
        parameters: { temperature: 0, toolChoice: "auto" },
      });
      assert.equal(first.ok, false);
      if (first.ok) return;
      const runId = first.runId;
      const firstEvents = storage.listRunEvents(runId);
      const started = firstEvents.find((event) => event.type === "run.started");
      assert.deepEqual(started?.payload.requiredArtifactVersionIds, [
        seededBody.result.versionId,
      ]);
      const firstWait = firstEvents
        .find((event) => event.type === "run.waiting_user");
      assert.deepEqual(firstWait?.payload.requiredArtifactVersionIds, [
        seededBody.result.versionId,
      ]);
      storage.resumeRun({
        projectId: "project-1",
        runId,
        operationId: "first-resume-before-process-crash",
        decision: "resume",
        displayInstruction: "第一次回答后进程在提交 draft 前崩溃。",
      });
      const recovered = storage.recoverProjectRuns("project-1");
      assert.deepEqual(recovered.map((run) => run.runId), [runId]);
      assert.equal(storage.getRun(runId)?.status, "interrupted");
      storage.close();

      storage = openWorkspaceStorage({ workspacePath });
      const provider = new MaterialThenPrematureReadyProvider(
        "material-1",
        seeded.contentVersionId,
      );
      const service = new WritingApplicationService({ storage, provider });
      const project = storage.inspectProject("project-1")!;
      const answer = "围绕去年冬天那次下班散步展开。";
      const resumed = await service.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId,
        operationId: "resume-edit-after-input",
        decision: "resume",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: answer,
        parameters: { temperature: 0, toolChoice: "auto" },
      })).result;
      assert.equal(resumed.ok, false);
      const failed = storage.listRunEvents(runId)
        .filter((event) => event.type === "tool.failed")
        .at(-1);
      assert.equal(
        ((failed?.payload.result as { error?: { code?: string } } | undefined)
          ?.error?.code),
        "READINESS_CONTEXT_READ_REQUIRED",
      );
      assert.deepEqual(
        ((failed?.payload.result as {
          error?: { details?: { unreadArtifacts?: unknown } };
        } | undefined)?.error?.details?.unreadArtifacts),
        [{
          artifactVersionId: seededBody.result.versionId,
          source: "current_body",
        }],
      );
      const resumedMessage = provider.requests[0]?.messages.find(
        (message) => message.role === "user",
      )?.content ?? "";
      assert.match(resumedMessage, /原始用户写作目标/u);
      assert.match(resumedMessage, new RegExp(originalGoal, "u"));
      assert.match(resumedMessage, /这篇文章要围绕哪一次真实经历展开/u);
      assert.match(resumedMessage, new RegExp(answer, "u"));
      assert.doesNotMatch(resumedMessage, /source_verified/u);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("restores the existing-body baseline when the first process crashes before waiting or draft", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-edit-start-crash-"));
    let storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const seededBody = storage.commitArtifactVersion({
      operationId: "seed-body-before-start-crash",
      projectId: "project-1",
      expectedProjectRevision: seeded.projectRevision,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 崩溃前现稿\n\n恢复时必须读取这份正文。",
      reason: "测试启动恢复基线",
      requestSnapshotId: null,
      actor: user,
    });
    assert.equal(seededBody.ok, true, JSON.stringify(seededBody));
    if (!seededBody.ok) return;
    const runId = "run-crashed-before-first-wait";
    storage.createSession({
      sessionId: "session-crashed-before-first-wait",
      projectId: "project-1",
      purpose: "writing-pack:draft",
    });
    const startInput = {
      runId,
      sessionId: "session-crashed-before-first-wait",
      projectId: "project-1",
      planVersion: "bounded-writing-loop-v2",
      displayInstruction: "在现稿基础上续写结尾。",
      requiredArtifactVersionIds: [seededBody.result.versionId],
    };
    storage.startRun(startInput);
    assert.deepEqual(
      storage.listRunEvents(runId)[0]?.payload.requiredArtifactVersionIds,
      [seededBody.result.versionId],
    );
    const recovered = storage.recoverProjectRuns("project-1");
    assert.deepEqual(recovered.map((run) => run.runId), [runId]);
    storage.close();

    storage = openWorkspaceStorage({ workspacePath });
    const provider = new MaterialThenPrematureReadyProvider(
      "material-1",
      seeded.contentVersionId,
    );
    const service = new WritingApplicationService({ storage, provider });
    const project = storage.inspectProject("project-1")!;
    try {
      const resumed = await service.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId,
        operationId: "resume-after-start-crash",
        decision: "resume",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: "继续围绕原稿的河边场景收束。",
        parameters: { temperature: 0, toolChoice: "auto" },
      })).result;
      assert.equal(resumed.ok, false);
      const failed = storage.listRunEvents(runId)
        .filter((event) => event.type === "tool.failed")
        .at(-1);
      assert.equal(
        (failed?.payload.result as { error?: { code?: string } } | undefined)?.error?.code,
        "READINESS_CONTEXT_READ_REQUIRED",
      );
      const unread = (failed?.payload.result as {
        error?: { details?: { unreadArtifacts?: Array<{ artifactVersionId?: string }> } };
      } | undefined)?.error?.details?.unreadArtifacts ?? [];
      assert.equal(
        unread.some((artifact) => artifact.artifactVersionId === seededBody.result.versionId),
        true,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("preserves the existing-body baseline across an outline co-creation checkpoint", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-edit-co-checkpoint-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap, {
      ...brief,
      interactionMode: "co_creation",
    });
    const seededBody = storage.commitArtifactVersion({
      operationId: "seed-body-before-outline-checkpoint",
      projectId: "project-1",
      expectedProjectRevision: seeded.projectRevision,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 原始基线\n\n恢复后必须先读取这份正文再起草。",
      reason: "测试共创恢复基线",
      requestSnapshotId: null,
      actor: user,
    });
    assert.equal(seededBody.ok, true, JSON.stringify(seededBody));
    if (!seededBody.ok) return;
    const firstService = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("material-1", seeded.contentVersionId),
    });

    try {
      const first = await firstService.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seededBody.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: "在现稿基础上压缩结构。",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 20,
          maxToolCalls: 20,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(first.ok, false);
      if (first.ok) return;
      assert.equal(storage.getRun(first.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
      const waiting = storage.listRunEvents(first.runId)
        .find((event) => event.type === "run.waiting_user");
      assert.deepEqual(waiting?.payload.requiredArtifactVersionIds, [
        seededBody.result.versionId,
      ]);

      const project = storage.inspectProject("project-1")!;
      const resumedService = new WritingApplicationService({
        storage,
        provider: new MaterialThenPrematureReadyProvider(
          "material-1",
          seeded.contentVersionId,
        ),
      });
      const resumed = await resumedService.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId: first.runId,
        operationId: "resume-outline-without-baseline",
        decision: "resume",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 20,
          maxToolCalls: 20,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      })).result;
      assert.equal(resumed.ok, false);
      const failed = storage.listRunEvents(first.runId)
        .filter((event) => event.type === "tool.failed")
        .at(-1);
      const unread = (failed?.payload.result as {
        error?: { details?: { unreadArtifacts?: Array<{ artifactVersionId?: string }> } };
      } | undefined)?.error?.details?.unreadArtifacts ?? [];
      assert.equal(
        (failed?.payload.result as { error?: { code?: string } } | undefined)?.error?.code,
        "READINESS_CONTEXT_READ_REQUIRED",
      );
      assert.equal(
        unread.some((artifact) => artifact.artifactVersionId === seededBody.result.versionId),
        true,
      );

      const afterInputProject = storage.inspectProject("project-1")!;
      const draftingService = new WritingApplicationService({
        storage,
        provider: new CheckpointWorkflowProvider("material-1", seeded.contentVersionId),
      });
      const afterDraft = await draftingService.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId: first.runId,
        operationId: "resume-outline-with-baseline",
        decision: "resume",
        expectedProjectRevision: afterInputProject.revision,
        expectedBriefVersionId: afterInputProject.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: "读取已保存基线后继续起草。",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 24,
          maxToolCalls: 24,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      })).result;
      assert.equal(afterDraft.ok, false);
      assert.equal(storage.getRun(first.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
      const latestWait = storage.listRunEvents(first.runId)
        .filter((event) => event.type === "run.waiting_user")
        .at(-1);
      assert.deepEqual(latestWait?.payload.requiredArtifactVersionIds, []);
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").length,
        2,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects a ready assessment before large authorized materials are read", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-ready-before-material-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap, brief, 'quick', '真实的长材料。'.repeat(1000));
    const service = new WritingApplicationService({
      storage,
      provider: new PrematureReadyProvider(),
    });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 2,
          maxToolCalls: 2,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(result.ok, false);
      const failed = storage.listRunEvents(result.runId)
        .find((event) => event.type === "tool.failed");
      assert.equal(
        ((failed?.payload.result as { error?: { code?: string } } | undefined)
          ?.error?.code),
        "READINESS_MATERIAL_READ_REQUIRED",
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("requires contiguous current-version material slices before ready", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-sliced-material-ready-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const service = new WritingApplicationService({
      storage,
      provider: new SlicedMaterialReadinessProvider(
        "material-1",
        seeded.contentVersionId,
      ),
    });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 5,
          maxToolCalls: 5,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(result.ok, false);
      assert.equal(storage.getRun(result.runId)?.stopReason, "WRITING_INPUT_REQUIRED");
      const events = storage.listRunEvents(result.runId);
      const readinessFailures = events.filter((event) => event.type === "tool.failed");
      assert.equal(
        ((readinessFailures[0]?.payload.result as {
          error?: { code?: string };
        } | undefined)?.error?.code),
        "READINESS_MATERIAL_READ_REQUIRED",
      );
      const successfulReady = events.filter((event) => event.type === "tool.completed")
        .map((event) => event.payload.result)
        .find((execution) =>
          typeof execution === "object" && execution !== null && !Array.isArray(execution) &&
          (execution as { toolName?: unknown }).toolName === "assess_writing_readiness" &&
          ((execution as { result?: { status?: unknown } }).result?.status === "ready")
        );
      assert.notEqual(successfulReady, undefined);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects a resumed-segment ready assessment before recovery context is read", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-ready-before-recovery-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap, {
      ...brief,
      interactionMode: "co_creation",
    });
    const firstService = new WritingApplicationService({
      storage,
      provider: new CheckpointWorkflowProvider("material-1", seeded.contentVersionId),
    });
    const budget = {
      maxModelRequests: 30,
      maxToolCalls: 30,
      maxRetriesPerRequest: 0,
      maxMajorRevisions: 1,
    } as const;

    try {
      const first = await firstService.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget,
      });
      assert.equal(first.ok, false);
      if (first.ok) return;
      assert.equal(storage.getRun(first.runId)?.stopReason, "CO_CREATION_CHECKPOINT");

      const project = storage.inspectProject("project-1")!;
      const resumedService = new WritingApplicationService({
        storage,
        provider: new MaterialThenPrematureReadyProvider(
          "material-1",
          seeded.contentVersionId,
        ),
      });
      const resumed = await resumedService.resumeDraft(withCheckpointIntent(storage, {
        projectId: "project-1",
        runId: first.runId,
        operationId: "resume-before-reading-context",
        decision: "resume",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget,
      })).result;
      assert.equal(resumed.ok, false);
      const failed = storage.listRunEvents(first.runId)
        .filter((event) => event.type === "tool.failed")
        .at(-1);
      assert.equal(
        ((failed?.payload.result as { error?: { code?: string } } | undefined)
          ?.error?.code),
        "READINESS_CONTEXT_READ_REQUIRED",
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs the deep workflow with a separately persisted publication review", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-deep-workflow-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap, brief, "deep");
    const service = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("material-1", seeded.contentVersionId),
    });
    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId: storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 32,
          maxToolCalls: 40,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 2,
        },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.modelRequestCount, 28);
      assert.equal(result.toolCallCount, 28);
      assert.equal(
        storage.listArtifactVersions("project-1", "review", `review_publish:${result.runId}`).length,
        1,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("pauses co-creation at persisted checkpoints and resumes from the next required stage", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-co-creation-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap, {
      ...brief,
      interactionMode: "co_creation",
    });
    const service = new WritingApplicationService({
      storage,
      provider: new CheckpointWorkflowProvider("material-1", seeded.contentVersionId),
    });
    const budget = {
      maxModelRequests: 48,
      maxToolCalls: 64,
      maxRetriesPerRequest: 0,
      maxMajorRevisions: 1,
    } as const;
    try {
      const first = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId: storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget,
      });
      assert.equal(first.ok, false);
      if (first.ok) return;
      assert.equal(first.error.code, "USER_CONFIRMATION_REQUIRED", JSON.stringify({
        first,
        events: storage.listRunEvents(first.runId),
      }));
      assert.equal(storage.getRun(first.runId)?.status, "waiting_user");
      assert.equal(storage.getRun(first.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
      assert.equal(storage.listArtifactVersions("project-1", "outline", "main").length, 1);
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 0);

      const resume = async (operationId: string) => {
        await Promise.resolve();
        const project = storage.inspectProject("project-1")!;
        return service.resumeDraft(withCheckpointIntent(storage, {
          projectId: "project-1",
          runId: first.runId,
          operationId,
          decision: "resume",
          userInstruction: "认可当前阶段，继续下一步",
          expectedProjectRevision: project.revision,
          expectedBriefVersionId: project.currentBriefVersionId!,
          model: "mock-writing-model",
          parameters: { temperature: 0, toolChoice: "auto" },
          budget,
        })).result;
      };

      const afterOutline = await resume("resume-after-outline");
      assert.equal(afterOutline.ok, false);
      if (afterOutline.ok) return;
      assert.equal(afterOutline.error.code, "USER_CONFIRMATION_REQUIRED");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 1);

      const afterDraft = await resume("resume-after-draft");
      assert.equal(afterDraft.ok, false);
      if (afterDraft.ok) return;
      assert.equal(afterDraft.error.code, "USER_CONFIRMATION_REQUIRED");
      assert.equal(storage.listArtifactVersions("project-1", "review", `review_editor:${first.runId}`).length, 1);
      assert.equal(storage.listArtifactVersions("project-1", "review", `review_reader:${first.runId}`).length, 0);
      const afterEditor = await resume("resume-after-editor");
      assert.equal(afterEditor.ok, false);
      assert.equal(storage.listArtifactVersions("project-1", "review", `review_reader:${first.runId}`).length, 1);

      await resume("resume-after-reviews");
      assert.equal(storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'central_revision');
      await resume("resume-after-revision");
      assert.equal(storage.listRunEvents(first.runId).findLast(e => e.type === 'run.waiting_user')?.payload.stage, 'language_review');
      const awaitingTitle = await resume("resume-after-language");
      assert.equal(awaitingTitle.ok, false);
      assert.equal(storage.inspectProject('project-1')!.currentTitleVersionId, null);
      const publication = getPublicationCandidates(storage, 'project-1')!;
      choosePublicationCandidate(storage, 'project-1', 'select-title', `确认标题：${publication.candidates[0]!.title}`, publication.id, 1);
      const completed = await resume("resume-after-title-selection");
      assert.equal(completed.ok, true, JSON.stringify(completed));
      assert.equal(storage.getRun(first.runId)?.status, "completed");
      assert.equal(storage.getFactCheckStatus("project-1").status, "passed");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 3);
      const restoredContextReads = storage.listRunEvents(first.runId).filter((event) => {
        if (event.type !== "tool.completed") return false;
        const execution = event.payload.result;
        return typeof execution === "object" && execution !== null && !Array.isArray(execution) &&
          (execution as Readonly<Record<string, unknown>>).toolName === "read_artifact_version";
      });
      assert.equal(restoredContextReads.length, 16, 'each review/revision/language confirmation restores only its currently bound inputs');
      const repeatedMaterialReads = storage.listRunEvents(first.runId).filter((event) => {
        if (event.type !== "tool.completed") return false;
        const execution = event.payload.result;
        return typeof execution === "object" && execution !== null && !Array.isArray(execution) &&
          (execution as Readonly<Record<string, unknown>>).toolName === "read_material";
      });
      assert.equal(repeatedMaterialReads.length, 0);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs the bounded writing workflow and persists every user-visible stage", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-application-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrapProvider = new MaterialThenDraftProvider("unused", "unused");
    const bootstrap = new WritingApplicationService({
      storage,
      provider: bootstrapProvider,
    });
    const seeded = seedWritingInputs(bootstrap);
    const provider = new MaterialThenDraftProvider(
      "material-1",
      seeded.contentVersionId,
    );
    const service = new WritingApplicationService({ storage, provider });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 32,
          maxToolCalls: 40,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });

      assert.equal(result.ok, true, JSON.stringify({
        result,
        toolEvents: storage.listRunEvents(result.runId).filter((event) => event.type.startsWith("tool.")),
      }));
      if (!result.ok) return;
      assert.equal(result.validationKind, "mock_verified");
      assert.equal(result.publicationReady, true);
      assert.equal(result.modelRequestCount, 25);
      assert.equal(result.toolCallCount, 25);
      assert.notEqual(result.artifactVersionId, null);
      assert.equal(provider.requests.length, 25);
      assert.equal(
        JSON.stringify(provider.requests[0]).includes("下班后我沿着河边"),
        true,
      );
      assert.equal(
        JSON.stringify(provider.requests[0]).includes("D:\\private"),
        false,
      );
      const supplied = JSON.parse(provider.requests[0]!.messages.find(m => m.role === 'user')!.content.split('\nCOLLABORATION_STATE=')[1]!).materials[0];
      assert.match(supplied.content, /下班后我沿着河边/);
      assert.equal(supplied.instructionAuthority, 'none');
      assert.equal(supplied.delivery, 'inline_full');
      const version = storage.getArtifactVersion(result.artifactVersionId!);
      assert.match(version?.content ?? "", /鞋底擦过路面的声音/u);
      assert.equal(version?.requestSnapshotId, null);
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 3);
      assert.equal(storage.listArtifactVersions("project-1", "outline", "main").length, 1);
      assert.equal(storage.listArtifactVersions("project-1", "evidence", "main").length, 1);
      assert.equal(storage.listArtifactVersions("project-1", "review", `review_editor:${result.runId}`).length, 1);
      assert.equal(storage.listArtifactVersions("project-1", "review", `review_reader:${result.runId}`).length, 1);
      const draftVersionId = storage.listArtifactVersions("project-1", "body", "main")[0]?.id;
      assert.notEqual(draftVersionId, undefined);
      for (const reviewStage of ["review_editor", "review_reader"] as const) {
        const review = storage.listArtifactVersions(
          "project-1",
          "review",
          `${reviewStage}:${result.runId}`,
        )[0];
        assert.notEqual(review, undefined);
        const envelope = JSON.parse(review!.content) as {
          schemaVersion?: string;
          reviewType?: string;
          bodyVersionId?: string;
          content?: string;
        };
        assert.equal(envelope.schemaVersion, "writing-review-v1");
        assert.equal(envelope.reviewType, reviewStage);
        assert.equal(envelope.bodyVersionId, draftVersionId);
        assert.match(envelope.content ?? "", /结构|读者/u);
      }
      assert.equal(storage.inspectProject("project-1")?.factGateStatus, "passed");
      const projection = service.getProjectProjection("project-1");
      assert.equal(
        projection.workflowArtifacts.filter((artifact) => artifact.kind === "evidence").length,
        1,
      );
      assert.equal(
        projection.workflowArtifacts.filter((artifact) => artifact.kind === "outline").length,
        1,
      );
      assert.equal(
        projection.workflowArtifacts.filter((artifact) => artifact.kind === "review").length,
        2,
      );
      assert.deepEqual(
        storage.listRunEvents(result.runId)
          .filter((event) => event.type === "tool.requested" && event.payload.toolName !== "director_decide")
          .map((event) => (event.payload.arguments as { stage?: string }).stage ?? event.payload.toolName),
        [
          "assess_writing_readiness",
          "research",
          "assess_writing_readiness",
          "outline",
          "assess_writing_readiness",
          "draft",
          "assess_writing_readiness",
          "review_editor",
          "assess_writing_readiness",
          "review_reader",
          "assess_writing_readiness",
          "central_revision",
          "assess_writing_readiness",
          "language_review",
          "assess_writing_readiness",
          "submit_fact_check",
        ],
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("treats a later message as an edit of the saved draft and requires reading it first", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-continuous-edit-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const provider = new MaterialThenDraftProvider("material-1", seeded.contentVersionId);
    const service = new WritingApplicationService({ storage, provider });
    const budget = {
      maxModelRequests: 32,
      maxToolCalls: 40,
      maxRetriesPerRequest: 0,
      maxMajorRevisions: 1,
    } as const;

    try {
      const initial = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId: storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget,
      });
      assert.equal(initial.ok, true, JSON.stringify(initial));
      if (!initial.ok || initial.artifactVersionId === null) return;

      const project = storage.inspectProject("project-1")!;
      const requestOffset = provider.requests.length;
      const revised = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: project.revision,
        expectedBriefVersionId: project.currentBriefVersionId!,
        model: "mock-writing-model",
        userInstruction: "把当前稿压缩到 300 字，保留结尾的现场感。",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget,
      });
      assert.equal(revised.ok, true, JSON.stringify(revised));
      assert.match(
        provider.requests[requestOffset]?.messages.find((message) => message.role === "user")?.content ?? "",
        /同一份作品的后续交流/u,
      );
      const firstRevisionTool = storage.listRunEvents(revised.runId)
        .find((event) => event.type === "tool.requested");
      assert.equal(
        (firstRevisionTool?.payload as { toolName?: string } | undefined)?.toolName,
        "read_artifact_version",
      );
      const currentDraftRead = provider.requests[requestOffset + 1]?.messages.find(
        (message) => message.role === "tool" && message.name === "read_artifact_version",
      );
      assert.equal(currentDraftRead?.role, "tool");
      if (currentDraftRead?.role === "tool") {
        assert.match(currentDraftRead.content, /鞋底擦过路面的声音/u);
      }
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reruns fact checking for a manually edited body without rewriting the article", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-fact-rerun-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const draftService = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("material-1", seeded.contentVersionId),
    });
    try {
      const drafted = await draftService.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId: storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 32,
          maxToolCalls: 40,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(drafted.ok, true);
      if (!drafted.ok || drafted.artifactVersionId === null) return;
      const project = storage.inspectProject("project-1")!;
      const edited = draftService.saveBody({
        operationId: "manual-edit-before-recheck",
        projectId: "project-1",
        expectedProjectRevision: project.revision,
        baseBodyVersionId: drafted.artifactVersionId,
        content: "# 一次安静的下班散步\n\n我下班后又沿河走了一次，仍只记录自己的感受。",
        reason: "用户手工修订",
        actor: user,
      });
      assert.equal(edited.ok, true);
      if (!edited.ok) return;
      assert.equal(storage.getFactCheckStatus("project-1").status, "stale");
      const evidenceVersionId = storage.inspectProject("project-1")!.currentEvidenceVersionId!;
      const checker = new WritingApplicationService({
        storage,
        provider: new FactCheckOnlyProvider(edited.result.versionId, evidenceVersionId),
      });
      const checked = await checker.runFactCheck({
        projectId: "project-1",
        expectedProjectRevision: edited.projectRevision,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 5,
          maxToolCalls: 4,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 0,
        },
      });
      assert.equal(checked.ok, true);
      assert.equal(checked.publicationReady, true);
      assert.equal(storage.getFactCheckStatus("project-1").status, "passed");
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 4);
      assert.equal(storage.inspectProject("project-1")?.latestBodyVersionId, edited.result.versionId);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("stops at the shared run budget and preserves inputs without creating a draft", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-application-budget-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const provider = new MaterialThenDraftProvider(
      "material-1",
      seeded.contentVersionId,
    );
    const service = new WritingApplicationService({ storage, provider });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0 },
        budget: {
          maxModelRequests: 1,
          maxToolCalls: 1,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "BUDGET_EXHAUSTED");
      assert.equal(storage.getRun(result.runId)?.status, "budget_exhausted");
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").length,
        0,
      );
      assert.equal(storage.listMaterials("project-1").length, 1);
      assert.notEqual(storage.inspectProject("project-1")?.currentBriefVersionId, null);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects workflow submission until the current execution segment is ready", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-material-read-gate-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const bootstrap = new WritingApplicationService({
      storage,
      provider: new MaterialThenDraftProvider("unused", "unused"),
    });
    const seeded = seedWritingInputs(bootstrap);
    const service = new WritingApplicationService({
      storage,
      provider: new ResearchBeforeReadingProvider(),
    });

    try {
      const result = await service.runDraft({
        projectId: "project-1",
        expectedProjectRevision: seeded.projectRevision,
        expectedBriefVersionId:
          storage.inspectProject("project-1")!.currentBriefVersionId!,
        model: "mock-writing-model",
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 3,
          maxToolCalls: 2,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 1,
        },
      });
      assert.equal(result.ok, false);
      assert.equal(
        storage.listArtifactVersions("project-1", "evidence", "main").length,
        0,
      );
      const events = storage.listRunEvents(result.runId);
      // Dispatch is now available for an explicit combined readiness decision,
      // but omitting that decision still cannot start an expert or save output.
      assert.ok(events.some(event => event.type === 'tool.failed' && (event.payload.result as any)?.error?.code === 'WRITING_READINESS_REQUIRED'));
      assert.equal(events.filter(event => event.type === 'tool.completed').length, 0);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
import { withCheckpointIntent } from './intent-fixture.js';
