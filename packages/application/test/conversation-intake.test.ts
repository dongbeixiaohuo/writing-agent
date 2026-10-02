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
import type { StoragePort, WritingBrief } from "../../writing-core/src/index.js";
import {
  ApplicationServiceError,
  WritingApplicationService,
} from "../src/index.js";
import { confirmConversationBriefState } from "../src/conversation-intake.js";
import { createConversationIntent } from "../src/conversation-intent.js";
import { intentFixtureEvents } from './intent-fixture.js';

type ToolArgs = Readonly<Record<string, unknown>>;

class IntakeProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];
  readonly #turns: readonly (readonly ToolArgs[])[];
  #turnIndex = 0;

  constructor(turns: readonly (readonly ToolArgs[])[]) {
    super("intake-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
    this.#turns = turns;
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const intent = intentFixtureEvents(request);
    if (intent) { yield* intent; return; }
    this.requests.push(structuredClone(request));
    const hasToolResult = request.messages.some((message) => message.role === "tool");
    if (hasToolResult) {
      yield { type: "text_delta", delta: "不应依赖的模型尾声" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const calls = this.#turns[this.#turnIndex++] ?? [];
    for (const [index, args] of calls.entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: `call-${this.#turnIndex}-${index}`,
        name: "respond_writing_intake",
        argumentsDelta: JSON.stringify(args),
      };
    }
    yield { type: "completed", finishReason: calls.length === 0 ? "stop" : "tool_calls" };
  }
}

const ideaResponse = {
  reply: "这个方向可以先聊清楚。你更想写个人观察，还是一篇实用经验？",
  summary: "想写一篇关于城市夜跑的文章，具体角度仍待确认。",
  questions: ["你更想写个人观察，还是一篇实用经验？"],
};

function proposedBrief(topic: string): WritingBrief {
  return {
    schemaVersion: 1,
    topic,
    genre: "practical_experience",
    audience: "刚开始夜跑的人",
    lengthTarget: { targetCharacters: 1200 },
    materialIds: [],
    constraints: ["不编造个人经历或效果数据"],
    interactionMode: "co_creation",
    authorAuthorization: {
      voice: null,
      styleReference: null,
      styleDecision: "unspecified",
      directionDecision: "tentative",
      firsthandMaterialIds: [],
    },
    platform: null,
    publicationGoal: "not_applicable",
    confirmationStatus: "tentative",
  };
}

function proposalResponse(topic: string) {
  return {
    reply: `我建议把它收敛为“${topic}”，以实用经验为主；篇幅和读者定位是当前建议值，确认后再开始写。`,
    summary: `主题为“${topic}”，面向刚开始夜跑的人，约 1200 字；篇幅与读者定位为建议值。`,
    questions: [],
    proposal: {
      brief: { topic, genre: "practical_experience", audience: "刚开始夜跑的人", targetCharacters: 1200,
        constraints: ["不编造个人经历或效果数据"], voice: null, styleReference: null, platform: null, publicationGoal: "not_applicable" },
      assumptions: ["约 1200 字是建议值", "读者定位为建议值"],
      sourceQuotes: [],
    },
  };
}

function fixture(provider: IntakeProvider) {
  const directory = mkdtempSync(join(tmpdir(), "writing-intake-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  let sequence = 0;
  const idFactory = () => `intake-id-${++sequence}`;
  const service = new WritingApplicationService({ storage, provider, idFactory });
  service.createProject({
    operationId: "create-project",
    projectId: "project-1",
    name: "对话项目",
    mode: "quick",
    actor: { kind: "user", id: "user-1" },
  });
  return {
    directory,
    storage,
    service,
    idFactory,
    close() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const runInput = (userInstruction: string, operationId: string, sessionId?: string) => ({
  projectId: "project-1",
  model: "mock",
  parameters: {},
  userInstruction,
  operationId,
  ...(sessionId === undefined ? {} : { sessionId }),
});

describe("conversation intake", () => {
  it("binds semantic intent provenance to the complete current message even when model sourceQuote is absent or rewritten", () => {
    const f = fixture(new IntakeProvider([]));
    try {
      f.storage.createSession({ projectId: "project-1", sessionId: "intent-session", purpose: "writing-pack:author-conversation" });
      for (const [index, sourceQuote] of ([undefined, "只摘录了一部分"] as const).entries()) {
        const runId = `intent-run-${index}`;
        const message = `这是第 ${index + 1} 条完整作者消息，包含不能丢失的上下文。`;
        f.storage.startRun({ projectId: "project-1", sessionId: "intent-session", runId, planVersion: "test", purpose: "writing-pack:author-conversation", displayInstruction: message });
        const intent = createConversationIntent({ storage: f.storage, projectId: "project-1", sessionId: "intent-session",
          userMessage: message, context: {}, allowedIntents: ["discuss"] });
        const result = intent.definition.execute({ intent: "discuss", ...(sourceQuote === undefined ? {} : { sourceQuote }),
          selectionIndex: null, reason: "模型只负责语义判断" }, {
          projectId: "project-1", runId, operationId: `${runId}:intent`, abortSignal: new AbortController().signal,
          expectedBodyVersionId: null, permissionGrant: { permissions: ["author:intent"] } as any,
        });
        assert.equal((result as any).sourceQuote, message);
        const receipt = f.storage.listArtifactVersions("project-1", "report", `author-intent:${runId}`)[0]!;
        assert.equal(JSON.parse(receipt.content).sourceQuote, message);
        assert.equal(JSON.parse(receipt.content).userMessage, message);
      }
    } finally { f.close(); }
  });

  it('switches a text-only intake reply to a required save instead of repeatedly asking for another reply', async () => {
    class TextFirstProvider extends IntakeProvider {
      protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        if (request.parameters.toolChoice !== 'required') {
          this.requests.push(structuredClone(request));
          yield { type: 'text_delta', delta: ideaResponse.reply };
          yield { type: 'completed', finishReason: 'stop' };
          return;
        }
        yield* super.providerStream(request);
      }
    }
    const provider = new TextFirstProvider([[ideaResponse]]);
    const f = fixture(provider);
    try {
      const result = await f.service.startConversationTurn(runInput('写一个人天天内耗怎么办', 'text-first')).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.modelRequestCount, 2);
      assert.equal(result.toolCallCount, 1);
      assert.deepEqual(provider.requests.map(r => r.parameters.toolChoice), ['auto', 'required']);
      assert.match(provider.requests[1]!.messages[0]!.content, /只调用.*respond_writing_intake/u);
      assert.doesNotMatch(provider.requests[1]!.messages[0]!.content, /先以普通文本/u);
      assert.equal(f.service.getConversationIntake('project-1').reply, ideaResponse.reply);
      assert.equal(f.service.getConversationIntake('project-1').phase, 'collecting');
      assert.equal(f.storage.inspectProject('project-1')!.currentBriefVersionId, null);
      assert.equal(f.storage.inspectProject('project-1')!.latestBodyVersionId, null);
    } finally { f.close(); }
  });
  for (const sourceQuotes of [undefined, ['分析一种“觉得自己重要就可以放松要求”的心理'], ['模型改写的内容，不是用户原话']]) {
    it(`binds proposal provenance from persisted messages instead of regenerated quotations: ${JSON.stringify(sourceQuotes)}`, async () => {
      const proposed = proposalResponse('职场心理观察');
      const provider = new IntakeProvider([[{ ...proposed, proposal: {
        brief: proposed.proposal.brief, assumptions: [], ...(sourceQuotes === undefined ? {} : { sourceQuotes }),
      } }]]);
      const f = fixture(provider);
      const original = '分析一种"觉得自己重要就可以放松要求"的心理';
      try {
        const result = await f.service.startConversationTurn(runInput(original, 'provenance')).result;
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.modelRequestCount, 1);
        const state = f.service.getConversationIntake('project-1');
        assert.equal(state.phase, 'proposal');
        assert.deepEqual(state.sourceTurns.map(turn => turn.quote), [original]);
        assert.deepEqual(state.brief!.materialIds, state.sourceTurns.map(turn => turn.materialId));
        assert.equal(state.brief!.authorAuthorization.styleDecision, 'unspecified');
        assert.deepEqual(state.brief!.authorAuthorization.firsthandMaterialIds, []);
        assert.equal(state.pendingAuthorization, null);
        assert.equal(f.storage.inspectProject('project-1')!.latestBodyVersionId, null);
      } finally { f.close(); }
    });
  }

  it('discloses tentative status in saved reply without requiring the model to reproduce a magic keyword', async () => {
    const proposed = proposalResponse('职场心理观察');
    const provider = new IntakeProvider([[{ ...proposed, reply: '我替你做了几个判断：用个案开头，再解释心理。你看看要不要调整。',
      summary: '面向普通读者，约1000字。', proposal: { ...proposed.proposal, assumptions: ['从个案引出普遍心理'] } }]]);
    const f = fixture(provider);
    try {
      const result = await f.service.startConversationTurn(runInput('1000字，具体案例切入', 'disclosure')).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.modelRequestCount, 1);
      const state = f.service.getConversationIntake('project-1');
      assert.equal(state.phase, 'proposal');
      assert.match(state.reply, /待你确认/u);
      assert.match(state.summary, /建议或暂定项/u);
      assert.equal(state.brief!.confirmationStatus, 'tentative');
    } finally { f.close(); }
  });

  it('formats the direction for readers without implementation fields or source-turn bookkeeping', async () => {
    const proposed = proposalResponse('与想象中的自己和解');
    const provider = new IntakeProvider([[{ ...proposed, proposal: { ...proposed.proposal,
      assumptions: ['genre 选 narrative_observation 是因为轻散文', 'targetCharacters=1000 来自用户消息 6', 'voice 设为第二人称，是建议', 'platform 暂无来源，设为 null', 'publicationGoal 设为 not_applicable', '结尾轻微和解是我根据对话推导的建议，用户尚未确认'] } }]]);
    const f = fixture(provider);
    try {
      await f.service.startConversationTurn(runInput('想写与想象中的自己和解', 'readable')).result;
      const summary = f.service.getConversationIntake('project-1').summary;
      assert.match(summary, /### 写作方向\n/u);
      assert.match(summary, /\n- 读者：/u);
      assert.match(summary, /待你确认/u);
      assert.match(summary, /结尾轻微和解/u);
      assert.doesNotMatch(summary, /genre|narrative_observation|targetCharacters|voice|platform|publicationGoal|not_applicable|null|用户消息 6/u);
      const state = f.service.getConversationIntake('project-1');
      const stored = f.storage.getArtifactVersion(state.stateArtifactVersionId!)!;
      const legacy = { ...JSON.parse(stored.content), summary: '主题：旧摘要；建议或暂定项：genre=narrative_observation；结尾轻微和解是我根据对话推导的建议' };
      assert.equal(f.storage.commitArtifactVersion({ operationId: 'legacy-summary', projectId: 'project-1', expectedProjectRevision: f.storage.inspectProject('project-1')!.revision, kind: 'report', logicalKey: 'conversation-intake', baseVersionId: stored.id, content: JSON.stringify(legacy), reason: 'legacy fixture', actor: { kind: 'user', id: 'test' } }).ok, true);
      const revision = f.storage.inspectProject('project-1')!.revision;
      assert.match(f.service.getConversationIntake('project-1').summary, /### 写作方向/u);
      assert.doesNotMatch(f.service.getConversationIntake('project-1').summary, /genre|narrative_observation/u);
      assert.equal(f.storage.inspectProject('project-1')!.revision, revision, 'legacy formatting is read-only');
    } finally { f.close(); }
  });

  it("constructs internal brief fields from a small business proposal, accepting an exact numeric string and empty optional preferences", async () => {
    const proposal = proposalResponse("夜跑观察");
    const provider = new IntakeProvider([[{ ...proposal, proposal: { ...proposal.proposal,
      brief: { ...proposal.proposal.brief, targetCharacters: "1200", voice: "", styleReference: "", platform: "" } } }]]);
    const f = fixture(provider);
    try {
      const result = await f.service.startConversationTurn(runInput("你建议个方向吧", "small-proposal")).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      const brief = f.service.getConversationIntake("project-1").brief!;
      assert.equal(brief.schemaVersion, 1);
      assert.equal(brief.lengthTarget.targetCharacters, 1200);
      assert.equal(brief.confirmationStatus, "tentative");
      assert.equal(brief.interactionMode, "co_creation");
      assert.deepEqual(brief.authorAuthorization, { voice: null, styleReference: null, styleDecision: "unspecified", directionDecision: "tentative", firsthandMaterialIds: [] });
      assert.equal(brief.platform, null);
      assert.deepEqual(brief.materialIds, f.storage.listMaterials("project-1").map(material => material.id));
      const schema = JSON.stringify(provider.requests[0]?.tools?.[0]?.inputSchema);
      for (const field of ["schemaVersion", "firsthandMaterialIds", "materialIds", "confirmationStatus", "interactionMode", "authorAuthorization"]) {
        assert.ok(!schema.includes(`\"${field}\"`), `model must not generate ${field}`);
      }
      assert.equal(result.modelRequestCount, 1);
    } finally { f.close(); }
  });

  for (const plainReplies of [0, 3]) it(`completes on the saved reply without a model epilogue after ${plainReplies} plain replies`, async () => {
    class DelayedToolProvider extends IntakeProvider {
      protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        if (this.requests.length < plainReplies) {
          this.requests.push(structuredClone(request));
          yield { type: "text_delta", delta: "先聊聊你想写的观察角度。" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield* super.providerStream(request);
      }
    }
    const provider = new DelayedToolProvider([[ideaResponse]]);
    const f = fixture(provider);
    try {
      const result = await f.service.startConversationTurn({
        ...runInput("想聊聊城市夜跑", "bounded-turn"),
        budget: { maxModelRequests: plainReplies + 1, maxToolCalls: 1, maxRetriesPerRequest: 1, maxMajorRevisions: 0 },
      }).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.content, ideaResponse.reply);
      assert.equal(result.modelRequestCount, plainReplies + 1);
      assert.equal(provider.requests.length, plainReplies + 1);
      assert.equal(f.storage.getRun(result.runId)?.status, "completed");
      const events = f.storage.listRunEvents(result.runId);
      assert.equal(events.filter(event => event.type === "request.prepared").length, plainReplies + 1);
      assert.equal(events.filter(event => event.type === "tool.completed").length, 1);
      assert.equal(events.filter(event => event.type === "run.completed").length, 1);
      assert.equal(events.some(event => event.type === "run.budget_exhausted"), false);
      assert.equal(result.artifactVersionId, result.intake.stateArtifactVersionId);
      assert.equal(provider.requests[0]!.parameters.toolChoice, 'auto');
      assert.match(provider.requests[0]!.messages[0]!.content, /先以普通文本/u);
      assert.ok(provider.requests.slice(1).every(request => request.parameters.toolChoice === 'required'));
    } finally { f.close(); }
  });

  it("adopts an existing tentative legacy brief without requiring a form migration", () => {
    const f = fixture(new IntakeProvider([]));
    try {
      const project = f.storage.inspectProject("project-1")!;
      const saved = f.service.saveWritingBrief({
        operationId: "legacy-tentative",
        projectId: "project-1",
        expectedProjectRevision: project.revision,
        baseVersionId: null,
        brief: proposedBrief("已有的暂定方向"),
        actor: { kind: "user", id: "legacy-user" },
      });
      assert.equal(saved.ok, true);
      const state = f.service.getConversationIntake("project-1");
      assert.equal(state.phase, "proposal");
      assert.equal(state.proposalVersionId, saved.ok ? saved.result.versionId : null);
      assert.equal(state.brief?.topic, "已有的暂定方向");
      assert.equal(state.stateArtifactVersionId, null);
    } finally {
      f.close();
    }
  });

  it("bounds a provider that ignores the response contract without consuming a conversation-wide allowance", async () => {
    class PlainProvider extends IntakeProvider {
      allowTool = false;
      protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        if (this.allowTool) { yield* super.providerStream(request); return; }
        this.requests.push(structuredClone(request));
        yield { type: "text_delta", delta: "没有按约定保存的回复" };
        yield { type: "completed", finishReason: "stop" };
      }
    }
    const provider = new PlainProvider([[ideaResponse]]);
    const f = fixture(provider);
    try {
      const failed = await f.service.startConversationTurn(runInput("想写夜跑", "plain-turn")).result;
      assert.equal(failed.ok, false);
      if (failed.ok) return;
      assert.equal(failed.error.code, "MODEL_REQUIRED_TOOL_MISSING");
      assert.equal(failed.modelRequestCount, 4);
      assert.equal(failed.toolCallCount, 0);
      assert.equal(f.storage.listArtifactVersions("project-1", "report", "conversation-intake").length, 0);
      assert.equal(f.storage.listMaterials("project-1")[0]?.content, "想写夜跑");
      provider.allowTool = true;
      const next = await f.service.startConversationTurn(runInput("我们继续聊聊", "retry-turn", failed.sessionId)).result;
      assert.equal(next.ok, true);
      assert.equal(next.modelRequestCount, 1);
      assert.equal(next.sessionId, failed.sessionId);
      assert.equal(f.storage.getRun(failed.runId)?.status, "failed");
    } finally { f.close(); }
  });

  it("keeps a one-line idea conversational without fabricating a brief or body", async () => {
    const provider = new IntakeProvider([[ideaResponse]]);
    const f = fixture(provider);
    try {
      const result = await f.service.startConversationTurn(
        runInput("我想写写城市夜跑", "turn-1"),
      ).result;
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.reply, ideaResponse.reply);
      assert.equal(result.content, ideaResponse.reply);
      assert.equal(result.intake.phase, "collecting");
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      assert.equal(f.storage.inspectProject("project-1")?.latestBodyVersionId, null);
      const source = f.storage.listMaterials("project-1")[0];
      assert.equal(source?.content, "我想写写城市夜跑");
      assert.equal(source?.trustLabel, "user_provided_untrusted");
      assert.equal(source?.role, "illustrative");
      const completed = f.storage.listRunEvents(result.runId)
        .find((event) => event.type === "tool.completed");
      assert.equal((completed?.payload.result as { result?: { reply?: string } })?.result?.reply, ideaResponse.reply);
      const started = f.storage.listRunEvents(result.runId)
        .find((event) => event.type === "run.started");
      assert.equal(started?.payload.purpose, "writing-pack:intake");
      const responseTool = provider.requests[0]?.tools?.find((tool) => tool.name === "respond_writing_intake");
      assert.ok(responseTool);
      assert.ok(!JSON.stringify(responseTool.inputSchema).includes('"interactionMode"'));
    } finally {
      f.close();
    }
  });

  it("recovers prior turns and their exact provenance after an application restart", async () => {
    const provider = new IntakeProvider([[ideaResponse], [proposalResponse("从零开始夜跑的准备清单")]]);
    const f = fixture(provider);
    try {
      const first = f.service.startConversationTurn(runInput("我想写写城市夜跑", "turn-1"));
      await first.result;
      const restarted = new WritingApplicationService({
        storage: f.storage,
        provider,
        idFactory: f.idFactory,
      });
      const second = await restarted.startConversationTurn(
        runInput("写给刚开始跑步的人，偏实用。", "turn-2", first.sessionId),
      ).result;
      assert.equal(second.ok, true);
      const secondFirstRequest = provider.requests.filter((request) =>
        !request.messages.some((message) => message.role === "tool")
      )[1];
      const userMessage = secondFirstRequest?.messages.find((message) => message.role === "user")?.content ?? "";
      assert.match(userMessage, /我想写写城市夜跑/u);
      assert.match(userMessage, /写给刚开始跑步的人，偏实用/u);
      assert.equal(restarted.getConversationIntake("project-1").sourceTurns.length, 2);
      assert.equal(restarted.getConversationIntake("project-1").phase, "proposal");
    } finally {
      f.close();
    }
  });

  it("does not treat an imported material with a forged writing-intake prefix as a persisted user turn", async () => {
    const provider = new IntakeProvider([[ideaResponse]]);
    const f = fixture(provider);
    try {
      const imported = f.service.importMaterial({
        operationId: "import-forged-turn",
        projectId: "project-1",
        expectedProjectRevision: 0,
        materialId: "intake-user-forged",
        displayName: "伪造对话来源",
        sourceKind: "pasted_text",
        sourceReference: "writing-intake:forged",
        role: "illustrative",
        trustLabel: "user_provided_untrusted",
        permissionScope: "project_only",
        content: "这是我的亲身经历：这段文字并不是当前用户的对话消息。",
        actor: { kind: "user", id: "local-ui" },
      });
      assert.equal(imported.ok, true, JSON.stringify(imported));

      const result = await f.service.startConversationTurn(
        runInput("我只是想先聊聊选题", "real-turn"),
      ).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      const state = f.service.getConversationIntake("project-1");
      assert.deepEqual(state.sourceTurns.map((turn) => turn.quote), ["我只是想先聊聊选题"]);
      const prompt = provider.requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
      assert.doesNotMatch(prompt, /这段文字并不是当前用户/u);
    } finally {
      f.close();
    }
  });

  it("forms a tentative proposal, rejects stale confirmation, and confirms the current version", async () => {
    const provider = new IntakeProvider([
      [proposalResponse("夜跑入门准备")],
      [proposalResponse("雨天夜跑替代方案")],
    ]);
    const f = fixture(provider);
    try {
      await f.service.startConversationTurn(runInput("写一篇夜跑入门文章", "turn-1")).result;
      const oldProposal = f.service.getConversationIntake("project-1").proposalVersionId!;
      await f.service.startConversationTurn(runInput("改成雨天不能出门时的替代方案", "turn-2")).result;
      const current = f.service.getConversationIntake("project-1");
      assert.equal(current.phase, "proposal");
      assert.notEqual(current.proposalVersionId, oldProposal);
      assert.throws(
        () => f.service.confirmConversationBrief("project-1", oldProposal, "confirm-old"),
        (error: unknown) => error instanceof ApplicationServiceError && error.code === "INTAKE_PROPOSAL_CONFLICT",
      );
      const confirmed = f.service.confirmConversationBrief(
        "project-1",
        current.proposalVersionId!,
        "confirm-current",
      );
      assert.equal(confirmed.phase, "confirmed");
      assert.equal(confirmed.brief?.confirmationStatus, "confirmed");
      assert.equal(confirmed.brief?.authorAuthorization.directionDecision, "user_confirmed");
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, confirmed.proposalVersionId);
    } finally {
      f.close();
    }
  });

  it("rejects a first-turn self-confirmed brief and fabricated material references", async () => {
    const validSelfConfirmed = proposalResponse("模型自行确认");
    const selfConfirmed = {
      ...validSelfConfirmed,
      proposal: {
        ...validSelfConfirmed.proposal,
        brief: { ...validSelfConfirmed.proposal.brief, confirmationStatus: "confirmed" },
      },
    };
    const validForged = proposalResponse("伪造材料");
    const forged = {
      ...validForged,
      proposal: {
        ...validForged.proposal,
        brief: { ...validForged.proposal.brief, materialIds: ["model-invented-material"] },
      },
    };
    const f = fixture(new IntakeProvider([[selfConfirmed], [forged]]));
    try {
      const first = await f.service.startConversationTurn(runInput("随便写一篇", "turn-1")).result;
      assert.equal(first.ok, false);
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      const second = await f.service.startConversationTurn(runInput("继续", "turn-2")).result;
      assert.equal(second.ok, false);
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      assert.equal(f.service.getConversationIntake("project-1").phase, "collecting");
    } finally {
      f.close();
    }
  });

  for (const fields of [
    { targetCharacters: "1200到1500" },
    { targetCharacters: "1000001" },
    { interactionMode: "autonomous" },
    { authorAuthorization: { firsthandMaterialIds: ["invented"], directionDecision: "user_confirmed" } },
  ]) it(`does not normalize ambiguous length or model-supplied authority: ${JSON.stringify(fields)}`, async () => {
    const proposal = proposalResponse("不能越权的建议");
    const f = fixture(new IntakeProvider([[{ ...proposal, proposal: { ...proposal.proposal, brief: { ...proposal.proposal.brief, ...fields } } }]]));
    try {
      const result = await f.service.startConversationTurn(runInput("给我建议", "bad-preference")).result;
      assert.equal(result.ok, false);
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      assert.equal(f.storage.inspectProject("project-1")?.latestBodyVersionId, null);
    } finally { f.close(); }
  });

  it("accepts natural-language confirmation only against the existing proposal and current source quote", async () => {
    const provider = new IntakeProvider([[proposalResponse("夜跑入门准备")]]);
    const f = fixture(provider);
    try {
      const proposed = await f.service.startConversationTurn(runInput("写一篇夜跑入门文章", "turn-1")).result;
      assert.equal(proposed.ok, true);
      const proposalVersionId = f.service.getConversationIntake("project-1").proposalVersionId!;
      const confirmProvider = new IntakeProvider([[
        {
          reply: "收到，需求已确认，可以进入写作。",
          summary: "夜跑入门准备的需求已由用户确认。",
          questions: [],
          confirmation: { proposalVersionId, sourceQuote: "好的" },
        },
      ]]);
      const restarted = new WritingApplicationService({ storage: f.storage, provider: confirmProvider, idFactory: f.idFactory });
      const confirmed = await restarted.startConversationTurn(
        runInput("好的", "turn-2", proposed.ok ? proposed.sessionId : undefined),
      ).result;
      assert.equal(confirmed.ok, true);
      if (!confirmed.ok) return;
      assert.equal(confirmed.intake.phase, "confirmed");
      assert.equal(confirmed.intake.brief?.confirmationStatus, "confirmed");
      assert.equal(confirmed.intake.brief?.authorAuthorization.directionDecision, "user_confirmed");
    } finally {
      f.close();
    }
  });

  it("rejects negated, modified, or substring-only natural-language confirmation", async () => {
    for (const [message, sourceQuote] of [
      ["不要确认，我还要想想", "确认"],
      ["确认，但改成写给管理者", "确认，但改成写给管理者"],
    ] as const) {
      const provider = new IntakeProvider([[proposalResponse("夜跑入门准备")]]);
      const f = fixture(provider);
      try {
        await f.service.startConversationTurn(runInput("写一篇夜跑入门文章", "turn-1")).result;
        const proposalVersionId = f.service.getConversationIntake("project-1").proposalVersionId!;
        const rejectingProvider = new IntakeProvider([[
          {
            reply: "误判确认",
            summary: "不应确认",
            questions: [],
            confirmation: { proposalVersionId, sourceQuote },
          },
        ]]);
        const restarted = new WritingApplicationService({ storage: f.storage, provider: rejectingProvider, idFactory: f.idFactory });
        const result = await restarted.startConversationTurn(runInput(message, `negative-${message}`)).result;
        assert.equal(result.ok, false);
        const state = restarted.getConversationIntake("project-1");
        assert.equal(state.phase, "collecting");
        assert.equal(state.brief, null);
        assert.equal(state.invalidatedProposalVersionId, proposalVersionId);
      } finally {
        f.close();
      }
    }
  });

  it("invalidates an old proposal when the user changes direction before a replacement is ready", async () => {
    const firstReply = proposalResponse("夜跑入门准备");
    const provider = new IntakeProvider([
      [firstReply],
      [{
        reply: "明白，旧方案已作废。新的角度还需要确认你更关注室内训练还是装备。",
        summary: "用户已改变原方向，替代方向仍在收集中。",
        questions: ["你更关注室内训练还是装备？"],
      }],
    ]);
    const f = fixture(provider);
    try {
      const first = await f.service.startConversationTurn(runInput("写一篇夜跑入门文章", "turn-1")).result;
      assert.equal(first.ok, true);
      const oldProposal = f.service.getConversationIntake("project-1").proposalVersionId!;
      const second = await f.service.startConversationTurn(
        runInput("不写夜跑入门了，改聊下雨天在家怎么练", "turn-2", first.ok ? first.sessionId : undefined),
      ).result;
      assert.equal(second.ok, true);
      const state = f.service.getConversationIntake("project-1");
      assert.equal(state.phase, "collecting");
      assert.equal(state.proposalVersionId, null);
      assert.equal(state.brief, null);
      assert.equal(state.invalidatedProposalVersionId, oldProposal);
      const afterRestart = new WritingApplicationService({ storage: f.storage }).getConversationIntake("project-1");
      assert.equal(afterRestart.phase, "collecting");
      assert.equal(afterRestart.proposalVersionId, null);
      assert.equal(afterRestart.invalidatedProposalVersionId, oldProposal);
      assert.throws(
        () => f.service.confirmConversationBrief("project-1", oldProposal, "confirm-invalidated"),
        (error: unknown) => error instanceof ApplicationServiceError && error.code === "INTAKE_PROPOSAL_CONFLICT",
      );
      const secondRequest = provider.requests.filter((request) =>
        !request.messages.some((message) => message.role === "tool")
      )[1];
      const prompt = secondRequest?.messages.find((message) => message.role === "user")?.content ?? "";
      assert.match(prompt, /我建议把它收敛为/u);
      assert.match(prompt, /"topic":"夜跑入门准备"/u);
    } finally {
      f.close();
    }
  });

  it("binds every intake source and existing authorized material into the proposed brief", async () => {
    const f = fixture(new IntakeProvider([[proposalResponse("一次真实夜跑复盘")]]));
    try {
      const project = f.storage.inspectProject("project-1")!;
      f.service.importMaterial({
        operationId: "source-material",
        projectId: "project-1",
        expectedProjectRevision: project.revision,
        materialId: "firsthand-note",
        displayName: "用户夜跑笔记",
        sourceKind: "pasted_text",
        sourceReference: "user-note",
        role: "user_firsthand",
        trustLabel: "user_provided_untrusted",
        permissionScope: "project_only",
        content: "昨晚跑了三公里，第二公里开始下雨。",
        actor: { kind: "user", id: "user-1" },
      });
      await f.service.startConversationTurn(runInput("帮我把这次经历写成复盘", "turn-1")).result;
      const state = f.service.getConversationIntake("project-1");
      assert.equal(state.phase, "proposal");
      assert.deepEqual(
        new Set(state.brief?.materialIds),
        new Set(f.storage.listMaterials("project-1").map((material) => material.id)),
      );
      assert.deepEqual(state.brief?.authorAuthorization.firsthandMaterialIds, ["firsthand-note"]);
      assert.match(state.summary, /主题：/u);
      assert.match(state.summary, /读者：刚开始夜跑的人/u);
      assert.match(state.summary, /篇幅：约 1200 字/u);
      assert.match(state.summary, /协作模式：共创/u);
      assert.match(state.summary, /材料边界：/u);
    } finally {
      f.close();
    }
  });

  it("keeps explicit firsthand, chosen style, and autonomous mode tentative until the user confirms the proposal", async () => {
    const userMessage = "这是我的亲身经历：去年冬天我第一次夜跑只跑了两公里。风格就用朴素真诚。请自主推进，不用逐步确认。";
    const proposal = proposalResponse("第一次夜跑复盘");
    const authorizedProposal = {
      ...proposal,
      proposal: {
        ...proposal.proposal,
        brief: {
          ...proposal.proposal.brief,
          styleReference: "朴素真诚",
        },
        authorization: {
          firsthand: [{
            sourceMaterialId: "intake-user-intake-id-2",
            sourceQuote: userMessage,
          }],
          style: {
            sourceMaterialId: "intake-user-intake-id-2",
            sourceQuote: userMessage,
            decision: "user_confirmed",
            styleReference: "朴素真诚",
          },
          interaction: {
            sourceMaterialId: "intake-user-intake-id-2",
            sourceQuote: userMessage,
            mode: "autonomous",
          },
        },
      },
    };
    const f = fixture(new IntakeProvider([[authorizedProposal]]));
    try {
      const result = await f.service.startConversationTurn(
        runInput(userMessage, "authorized-turn"),
      ).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      const tentative = f.service.getConversationIntake("project-1");
      assert.equal(tentative.phase, "proposal");
      assert.equal(tentative.brief?.interactionMode, "co_creation");
      assert.equal(tentative.pendingAuthorization?.interaction?.mode, "autonomous");
      assert.equal(tentative.brief?.authorAuthorization.styleReference, "朴素真诚");
      assert.equal(tentative.brief?.authorAuthorization.styleDecision, "unspecified");
      assert.deepEqual(tentative.brief?.authorAuthorization.firsthandMaterialIds, []);
      assert.equal(
        f.storage.listMaterials("project-1").filter((material) => material.role === "user_firsthand").length,
        0,
      );

      const confirmed = f.service.confirmConversationBrief(
        "project-1",
        tentative.proposalVersionId!,
        "confirm-authorizations",
      );
      assert.equal(confirmed.brief?.interactionMode, "autonomous");
      assert.equal(confirmed.brief?.authorAuthorization.styleDecision, "user_confirmed");
      assert.equal(confirmed.brief?.authorAuthorization.firsthandMaterialIds.length, 1);
      const firsthand = f.storage.getMaterial(
        "project-1",
        confirmed.brief!.authorAuthorization.firsthandMaterialIds[0]!,
      );
      assert.equal(firsthand?.role, "user_firsthand");
      assert.equal(firsthand?.trustLabel, "user_provided_untrusted");
      assert.equal(firsthand?.content, userMessage);
      assert.match(firsthand?.sourceReference ?? "", /writing-intake-authorized:/u);
      assert.notEqual(firsthand?.id, "intake-user-intake-id-2");
      assert.equal(f.storage.getMaterial("project-1", "intake-user-intake-id-2")?.role, "illustrative");
    } finally {
      f.close();
    }
  });

  it("keeps a failed-confirmation firsthand material recoverable without inheriting its authorization", async () => {
    const userMessage = "这是我的亲身经历：去年冬天我第一次夜跑只跑了两公里。";
    const proposal = proposalResponse("第一次夜跑复盘");
    const authorizedProposal = {
      ...proposal,
      proposal: {
        ...proposal.proposal,
        authorization: {
          firsthand: [{
            sourceMaterialId: "intake-user-intake-id-2",
            sourceQuote: userMessage,
          }],
        },
      },
    };
    const f = fixture(new IntakeProvider([
      [authorizedProposal],
      [proposalResponse("改写为夜跑准备清单")],
    ]));
    try {
      const proposed = await f.service.startConversationTurn(
        runInput(userMessage, "orphan-source-turn"),
      ).result;
      assert.equal(proposed.ok, true, JSON.stringify(proposed));
      const tentative = f.service.getConversationIntake("project-1");
      assert.equal(tentative.phase, "proposal");

      const failingStorage = new Proxy(f.storage, {
        get(target, property, receiver) {
          if (property === "saveWritingBrief") {
            return (command: { readonly operationId: string }) => ({
              ok: false as const,
              operationId: command.operationId,
              code: "FORCED_CONFIRM_FAILURE",
              message: "forced failure after firsthand materialization",
              retryable: true,
              details: {},
            });
          }
          const member = Reflect.get(target, property, receiver) as unknown;
          return typeof member === "function" ? member.bind(target) : member;
        },
      }) as StoragePort;
      assert.throws(
        () => confirmConversationBriefState({
          storage: failingStorage,
          projectId: "project-1",
          proposalVersionId: tentative.proposalVersionId!,
          operationId: "forced-failed-confirmation",
        }),
        (error: unknown) => error instanceof Error &&
          (error as { code?: string }).code === "FORCED_CONFIRM_FAILURE",
      );

      const orphan = f.storage.listMaterials("project-1").find((material) =>
        material.sourceReference?.startsWith("writing-intake-authorized:") === true
      );
      assert.equal(orphan?.role, "user_firsthand");

      const replacement = await f.service.startConversationTurn(
        runInput("改成只写夜跑前的准备清单", "replace-after-failed-confirmation"),
      ).result;
      assert.equal(replacement.ok, true, JSON.stringify(replacement));
      const replacementBrief = f.service.getConversationIntake("project-1").brief;
      assert.equal(replacementBrief?.materialIds.includes(orphan!.id), true);
      assert.equal(replacementBrief?.authorAuthorization.firsthandMaterialIds.includes(orphan!.id), false);
    } finally {
      f.close();
    }
  });

  it("distinguishes delegated style from a user-selected style and preserves co-creation", async () => {
    const userMessage = "风格你来定，保持作者自己的表达；请逐步共创，每一步都让我确认。";
    const proposal = proposalResponse("夜跑中的自我观察");
    const f = fixture(new IntakeProvider([[
      {
        ...proposal,
        proposal: {
          ...proposal.proposal,
          authorization: {
            firsthand: [],
            style: {
              sourceMaterialId: "intake-user-intake-id-2",
              sourceQuote: userMessage,
              decision: "user_delegated",
              styleReference: null,
            },
            interaction: {
              sourceMaterialId: "intake-user-intake-id-2",
              sourceQuote: userMessage,
              mode: "co_creation",
            },
          },
        },
      },
    ]]));
    try {
      const proposed = await f.service.startConversationTurn(
        runInput(userMessage, "delegated-style-turn"),
      ).result;
      assert.equal(proposed.ok, true, JSON.stringify(proposed));
      const tentative = f.service.getConversationIntake("project-1");
      assert.equal(tentative.brief?.authorAuthorization.styleDecision, "unspecified");
      const confirmed = f.service.confirmConversationBrief(
        "project-1",
        tentative.proposalVersionId!,
        "confirm-delegated-style",
      );
      assert.equal(confirmed.brief?.authorAuthorization.styleDecision, "user_delegated");
      assert.equal(confirmed.brief?.authorAuthorization.styleReference, null);
      assert.equal(confirmed.brief?.interactionMode, "co_creation");
    } finally {
      f.close();
    }
  });

  for (const [name, userMessage, authorization] of [
    [
      "third-party quotation",
      "朋友说：“这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。”",
      {
        firsthand: [{
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "朋友说：“这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。”",
        }],
      },
    ],
    [
      "named third-party original text",
      "以下是小王原文：\n这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
      {
        firsthand: [{
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "以下是小王原文：\n这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
        }],
      },
    ],
    [
      "quoted block without a relationship keyword",
      "原文摘录：\n> 这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
      {
        firsthand: [{
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "原文摘录：\n> 这是我的亲身经历：去年冬天第一次夜跑只跑了两公里。",
        }],
      },
    ],
    [
      "model-invented style authority",
      "我想写一篇夜跑文章。",
      {
        style: {
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "我想写一篇夜跑文章。",
          decision: "user_delegated",
          styleReference: null,
        },
      },
    ],
    [
      "excerpt without the full user context",
      "朋友说：“这是我的亲身经历。”但那不是我的经历。",
      {
        firsthand: [{
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "这是我的亲身经历。",
        }],
      },
    ],
    [
      "negated style preference",
      "我不喜欢朴素真诚风格，请给几个别的选择。",
      {
        style: {
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "我不喜欢朴素真诚风格，请给几个别的选择。",
          decision: "user_confirmed",
          styleReference: "朴素真诚",
        },
      },
    ],
    [
      "negated autonomous mode",
      "我不想自主推进，请先聊清楚再说。",
      {
        interaction: {
          sourceMaterialId: "intake-user-intake-id-2",
          sourceQuote: "我不想自主推进，请先聊清楚再说。",
          mode: "autonomous",
        },
      },
    ],
  ] as const) it(`does not promote ${name} into user authority`, async () => {
    const proposal = proposalResponse("不能越权的夜跑文章");
    const authorizationRecord = authorization as unknown as {
      readonly style?: { readonly styleReference?: string | null };
    };
    const f = fixture(new IntakeProvider([[
      {
        ...proposal,
        proposal: {
          ...proposal.proposal,
          brief: {
            ...proposal.proposal.brief,
            styleReference: authorizationRecord.style?.styleReference ??
              proposal.proposal.brief.styleReference,
          },
          authorization,
        },
      },
    ]]));
    try {
      const result = await f.service.startConversationTurn(
        runInput(userMessage, `reject-${name}`),
      ).result;
      assert.equal(result.ok, false);
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      assert.equal(
        f.storage.listMaterials("project-1").some((material) => material.role === "user_firsthand"),
        false,
      );
    } finally {
      f.close();
    }
  });

  it("does not execute later response tools from the same model response", async () => {
    const f = fixture(new IntakeProvider([[
      ideaResponse,
      { ...proposalResponse("不应落库的第二次响应"), reply: "第二次响应" },
    ]]));
    try {
      const result = await f.service.startConversationTurn(runInput("我有一个想法", "turn-1")).result;
      assert.equal(result.ok, true);
      assert.equal(f.service.getConversationIntake("project-1").reply, ideaResponse.reply);
      assert.equal(f.storage.inspectProject("project-1")?.currentBriefVersionId, null);
      assert.equal(f.storage.listArtifactVersions("project-1", "report", "conversation-intake").length, 1);
    } finally {
      f.close();
    }
  });

  it("does not commit a response after cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class SlowProvider extends IntakeProvider {
      protected override async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        await gate;
        yield* super.providerStream(request);
      }
    }
    const f = fixture(new SlowProvider([[ideaResponse]]));
    try {
      const handle = f.service.startConversationTurn(runInput("先聊聊", "turn-1"));
      f.service.cancelConversationTurn({
        projectId: "project-1",
        runId: handle.runId,
        operationId: "cancel-turn",
      });
      release();
      const result = await handle.result;
      assert.equal(result.ok, false);
      assert.equal(f.storage.listArtifactVersions("project-1", "report", "conversation-intake").length, 0);
    } finally {
      f.close();
    }
  });
});
