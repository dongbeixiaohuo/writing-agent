import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { WritingApplicationService } from "../../application/src/index.js";
import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import type { WritingBrief } from "../../writing-core/src/index.js";
import { collaborationState } from '../../application/test/collaboration-fixture.js';
import { collaborationTurn } from './helpers/collaboration-turn.js';
import {
  createApplicationBridge,
  mergeWorkflowStageStatus,
  toolFailureDetail,
} from "../src/application-bridge.js";

const actor = { kind: "user", id: "bridge-test" } as const;

describe("persisted run presentation", () => {
  it("does not regress a saved stage when a model repeats it after completion", () => {
    assert.equal(mergeWorkflowStageStatus("completed", "running"), "completed");
    assert.equal(mergeWorkflowStageStatus("completed", "failed"), "completed");
    assert.equal(mergeWorkflowStageStatus("running", "failed"), "failed");
  });

  it("turns fact-check contract failures into actionable user copy", () => {
    assert.match(
      toolFailureDetail("FACT_CHECK_EVIDENCE_REFERENCE_INVALID"),
      /证据编号.*证据账本/u,
    );
    assert.match(
      toolFailureDetail("WORKFLOW_STAGE_OUT_OF_ORDER"),
      /重复提交.*已保存/u,
    );
  });

  it('explains writing readiness refusals without exposing internal tool codes', () => {
    assert.match(toolFailureDetail('WRITING_READINESS_REQUIRED'), /必要信息.*阻止/u);
    assert.match(toolFailureDetail('READINESS_MATERIAL_READ_REQUIRED'), /完整读取.*材料/u);
    assert.match(toolFailureDetail('READINESS_CONTEXT_READ_REQUIRED'), /重新读取.*稿件/u);
  });
});

class BridgeWritingProvider extends ModelProviderBase {
  holdFinal = false;
  #releaseFinal: (() => void) | null = null;
  #finalStarted: (() => void) | null = null;
  readonly finalStarted = new Promise<void>((resolve) => {
    this.#finalStarted = resolve;
  });

  constructor() {
    super("bridge-writing-test", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  release(): void {
    this.#releaseFinal?.();
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    if (collaborationState(request) !== null) {
      const turn = collaborationTurn(request, {
        research: JSON.stringify({ claims: [], notes: '仅使用授权材料，没有外部事实。' }),
        outline: '# 提纲\n\n1. 现状\n2. 方法\n3. 行动',
        draft: '# Bridge 持久草稿\n\n正文只来自自有 Application Service。',
        review_editor: '结构完整；没有发现越权补写。',
        review_reader: '读者可以理解，建议保留当前表达。',
        review_publish: '发布边界明确。',
        central_revision: '# Bridge 持久草稿\n\n正文只来自自有 Application Service，并已经集中修订。',
        language_review: '# Bridge 持久草稿\n\n正文只来自本地 Application Service，并已完成语言终审。',
      });
      if (turn !== null) {
        const finishing = turn.some(e => e.type === 'tool_call_delta' && e.name === 'director_decide' && JSON.parse(e.argumentsDelta ?? '{}').action === 'finish');
        if (finishing) {
          this.#finalStarted?.(); this.#finalStarted = null;
          if (this.holdFinal) await new Promise<void>(resolve => { this.#releaseFinal = resolve; });
        }
        yield* turn; return;
      }
      this.#finalStarted?.(); this.#finalStarted = null;
      if (this.holdFinal) await new Promise<void>(resolve => { this.#releaseFinal = resolve; });
      yield { type: 'text_delta', delta: '当前版本已保存并通过事实门禁。' };
      yield { type: 'completed', finishReason: 'stop' };
      return;
    }
    const factCheckOnly = request.messages.some(
      (message) => message.role === "system" && message.content.includes("专项事实核查员"),
    );
    if (factCheckOnly) {
      const userMessage = request.messages.find((message) => message.role === "user");
      assert.equal(userMessage?.role, "user");
      const targets = JSON.parse(userMessage?.role === "user" ? userMessage.content : "{}") as {
        bodyVersionId?: string;
        evidenceVersionId?: string;
        artifacts: { id: string; kind: string; content: unknown }[];
      };
      assert.equal(targets.artifacts.find(a => a.id === targets.bodyVersionId)?.content,
        '# Bridge 持久草稿\n\n这是用户修订后的本地感受。');
      assert.ok(targets.artifacts.find(a => a.id === targets.evidenceVersionId)?.content);
      assert.equal(request.tools?.some(tool => tool.name === 'read_artifact_version'), false);
      if (!toolMessages.some((message) => message.role === "tool" && message.name === "submit_fact_check")) {
        yield {
          type: "tool_call_delta",
          index: 0,
          id: `fact-submit-${request.requestId}`,
          name: "submit_fact_check",
          argumentsDelta: JSON.stringify({
            claims: [],
            noFactualClaimsReason: "回归正文没有需要外部核实的事实主张。",
          }),
        };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", delta: "当前正文核查结果已保存。" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const userMessage = request.messages.find((message) => message.role === "user");
    assert.equal(userMessage?.role, "user");
    const currentDraftVersionId = userMessage?.role === "user"
      ? userMessage.content.match(/当前正文版本：([^。；\s]+)/u)?.[1]
      : undefined;
    if (
      currentDraftVersionId !== undefined &&
      !toolMessages.some((message) =>
        message.role === "tool" && message.name === "read_artifact_version"
      )
    ) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `read-current-draft-${request.requestId}`,
        name: "read_artifact_version",
        argumentsDelta: JSON.stringify({ versionId: currentDraftVersionId }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    if (!toolMessages.some((message) => message.role === "tool" && message.name === "read_material")) {
      const catalogMatch = userMessage?.content.match(/授权材料目录：(\[[^\n]+\])/u);
      assert.notEqual(catalogMatch, null);
      const catalog = JSON.parse(catalogMatch?.[1] ?? "[]") as Array<{
        id: string;
        contentVersionId: string;
      }>;
      const material = catalog[0];
      assert.notEqual(material, undefined);
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `read-${request.requestId}`,
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: material?.id,
          contentVersionId: material?.contentVersionId,
          offset: 0,
          maxChars: 20_000,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    if (!toolMessages.some(message => message.role === 'tool' && message.name === 'assess_writing_readiness')) {
      yield { type: 'tool_call_delta', index: 0, id: `ready-${request.requestId}`,
        name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'ready', reason: '当前合成材料足以支撑测试说明稿。', questions: [] }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
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
    const stages = [
      ["research", JSON.stringify({ claims: [], notes: "仅使用授权材料，没有外部事实。" })],
      ["outline", "# 提纲\n\n1. 现状\n2. 方法\n3. 行动"],
      ["draft", "# Bridge 持久草稿\n\n正文只来自自有 Application Service。"],
      ["review_editor", "结构完整；没有发现越权补写。"],
      ["review_reader", "读者可以理解，建议保留当前表达。"],
      ["central_revision", "# Bridge 持久草稿\n\n正文只来自自有 Application Service，并已经集中修订。"],
      ["language_review", "# Bridge 持久草稿\n\n正文只来自本地 Application Service，并已完成语言终审。"],
    ] as const;
    const next = stages[submittedStages.length];
    if (next !== undefined) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `stage-${next[0]}-${request.requestId}`,
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
        id: `fact-${request.requestId}`,
        name: "submit_fact_check",
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: "正文只陈述系统内的测试边界，没有外部事实主张。",
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    this.#finalStarted?.();
    this.#finalStarted = null;
    if (this.holdFinal) {
      await new Promise<void>((resolve) => {
        this.#releaseFinal = resolve;
      });
    }
    yield {
      type: "text_delta",
      delta: "完整写作工作流已经保存。",
    };
    yield { type: "completed", finishReason: "stop" };
  }
}

class MissingInputProvider extends BridgeWritingProvider {
  readonly prompts: string[] = [];
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const prompt = request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    this.prompts.push(prompt);
    if (!prompt.includes('写给新入职同事，介绍我们三步报修流程')) {
      yield { type: 'tool_call_delta', index: 0, id: `ask-${request.requestId}`,
        name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'needs_input', reason: '目前只有占位材料，无法判断文章内容。', questions: ['具体想写什么主题？', '有哪些可以使用的事实材料？'] }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    yield* super.providerStream(request);
  }
}

class UnsupportedModelProvider extends ModelProviderBase {
  constructor() {
    super("unsupported-model-test", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    yield {
      type: "error",
      error: {
        code: "MODEL_UNSUPPORTED",
        message: "模型标识不存在或当前账户不可用",
        retryable: false,
      },
    };
  }
}

function brief(materialId: string, topic: string): WritingBrief {
  return {
    schemaVersion: 1,
    topic,
    genre: "explanatory_analysis",
    audience: "企业 IT 负责人",
    lengthTarget: { targetCharacters: 800 },
    materialIds: [materialId],
    constraints: ["不得虚构数据"],
    interactionMode: "autonomous",
    authorAuthorization: {
      voice: "克制、具体",
      styleReference: null,
      styleDecision: "user_confirmed",
      directionDecision: "user_confirmed",
      firsthandMaterialIds: [],
    },
    platform: null,
    publicationGoal: "not_applicable",
    confirmationStatus: "confirmed",
  };
}

function seedProject(
  service: WritingApplicationService,
  projectId: string,
  name: string,
): void {
  const materialId = `${projectId}-material`;
  const created = service.createProject({
    operationId: `${projectId}-create`,
    projectId,
    name,
    mode: "quick",
    actor,
  });
  assert.equal(created.ok, true);
  const imported = service.importMaterial({
    operationId: `${projectId}-material-import`,
    projectId,
    expectedProjectRevision: 0,
    materialId,
    displayName: "内部材料.md",
    sourceKind: "utf8_file",
    sourceReference: `C:\\private\\${projectId}\\source.md`,
    role: "source_verified",
    trustLabel: "user_provided_untrusted",
    permissionScope: "project_only",
    content: `PRIVATE-${projectId}-BODY`,
    actor,
  });
  assert.equal(imported.ok, true);
  const saved = service.saveWritingBrief({
    operationId: `${projectId}-brief-save`,
    projectId,
    expectedProjectRevision: 1,
    baseVersionId: null,
    brief: brief(materialId, `${name}主题`),
    actor,
  });
  assert.equal(saved.ok, true);
}

function bridgeFor(
  service: WritingApplicationService,
  operationIdFactory = (): string => globalThis.crypto.randomUUID(),
  uiSettingsPersistence?: {
    load(): { theme: "light" | "dark" | "system"; contentFontSize: number } | null;
    save(value: { theme: "light" | "dark" | "system"; contentFontSize: number }): void;
  },
) {
  const options = {
    service,
    workspaceId: "workspace-test",
    model: {
      model: "bridge-model",
      providerLabel: "测试 Provider（无真实网络）",
      credentialReference: "TEST_CREDENTIAL_REF",
      parameters: { temperature: 0, toolChoice: "auto" },
      budget: {
        maxModelRequests: 48,
        maxToolCalls: 64,
        maxRetriesPerRequest: 0,
        maxMajorRevisions: 1,
      },
    },
    pollIntervalMs: 5,
    operationIdFactory,
    ...(uiSettingsPersistence === undefined ? {} : { uiSettingsPersistence }),
  };
  return createApplicationBridge(options as Parameters<typeof createApplicationBridge>[0]);
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= expires) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Application Service client bridge", () => {
  it('routes a material answer to its input wait without recursively resuming a newer checkpoint', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'wa-multiple-waits-'));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({ storage, provider: new MissingInputProvider() });
    seedProject(service, 'project-input', 'test');
    const bridge = bridgeFor(service);
    try {
      const first = await bridge.sendMessage('开始');
      await waitUntil(() => bridge.getSnapshot().recoverableRuns.length === 1);
      const sessionId = bridge.getSnapshot().selectedSessionId;
      storage.startRun({ projectId: 'project-input', sessionId, runId: 'newer-checkpoint',
        operationId: 'newer-checkpoint-start', purpose: 'writing-pack:draft', planVersion: 'test' });
      storage.pauseRun({ projectId: 'project-input', runId: 'newer-checkpoint', operationId: 'checkpoint-pause',
        reason: 'CO_CREATION_CHECKPOINT', payload: { stage: 'outline', nextStage: 'draft' } });
      await bridge.refresh();
      const resume = bridge.resumeRun.bind(bridge);
      let resumeCalls = 0;
      bridge.resumeRun = async (...args) => {
        assert.ok(++resumeCalls <= 1, 'a composer answer must not recurse through another waiting run');
        return resume(...args);
      };
      const reply = await bridge.sendMessage('写给新入职同事，介绍我们三步报修流程：提交工单、等待分配、确认恢复。');
      assert.equal(reply.runId, first.runId);
      await waitUntil(() => storage.getRun(first.runId)?.status === 'completed');
      assert.equal(storage.getRun('newer-checkpoint')?.status, 'waiting_user');
      assert.equal(storage.listRunEvents('newer-checkpoint').some(e => e.type === 'run.resumed'), false);
    } finally { bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
  });
  it('shows persisted input questions and resumes the same run from the main composer', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'wa-bridge-missing-input-'));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new MissingInputProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, 'project-input', 'test');
    let bridge = bridgeFor(service);
    try {
      const started = await bridge.sendMessage('开始');
      await waitUntil(() => bridge.getSnapshot().recoverableRuns.length === 1);
      const sessionId = bridge.getSnapshot().selectedSessionId;
      assert.equal(storage.getRun(started.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
      assert.equal(storage.inspectProject('project-input')?.latestBodyVersionId, null);
      bridge.dispose();
      bridge = bridgeFor(service);
      await bridge.selectSession('project-input', sessionId);
      const pending = bridge.getSnapshot().recoverableRuns[0];
      assert.deepEqual(pending?.inputRequest?.questions, ['具体想写什么主题？', '有哪些可以使用的事实材料？']);
      assert.ok(JSON.stringify(bridge.getSnapshot().timelineBySession[sessionId]).includes('具体想写什么主题'));
      await assert.rejects(bridge.resumeRun(started.runId, 'resume'), /WRITING_INPUT_ANSWER_REQUIRED|补充/u);
      assert.equal(storage.getRun(started.runId)?.status, 'waiting_user');
      const answer = '写给新入职同事，介绍我们三步报修流程：提交工单、等待分配、确认恢复。';
      const resumed = await bridge.sendMessage(answer, { operationId: 'answer-missing-input' });
      assert.equal(resumed.runId, started.runId);
      assert.deepEqual(await bridge.sendMessage(answer, { operationId: 'answer-missing-input' }), resumed);
      await waitUntil(() => storage.getRun(started.runId)?.status === 'completed');
      await bridge.refresh();
      const timeline = bridge.getSnapshot().timelineBySession[sessionId] ?? [];
      const answerIndex = timeline.findIndex(item => item.kind === 'message' && item.body === answer);
      assert.ok(answerIndex >= 0);
      assert.ok(timeline.slice(answerIndex + 1).some(item => item.kind === 'tool' && item.label === '写作模型'), 'resumed execution must show new activity after the answer, not update a hidden earlier row');
      assert.equal(service.getProjectProjection('project-input').runs.length, 1);
      assert.equal(storage.getRun(started.runId)?.sessionId, sessionId);
      assert.ok(storage.listRunEvents(started.runId).some(event => event.type === 'run.resumed' && event.payload.displayInstruction === answer));
      assert.ok(provider.prompts.some(prompt => prompt.includes('具体想写什么主题') && prompt.includes(answer)));
    } finally {
      bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true });
    }
  });
  it('skips the periodic snapshot rebuild while no project has new events, and rebuilds after one', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'wa-bridge-poll-gate-'));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, 'project-gate', 'test');
    const bridge = bridgeFor(service);
    try {
      const unsubscribe = bridge.subscribe(() => {});
      await bridge.selectProject('project-gate');
      const first = bridge.getSnapshot().revision;
      // With no new events, idle poll ticks must not rebuild projections at all.
      const original = service.getProjectProjection.bind(service);
      let rebuilds = 0;
      (service as { getProjectProjection: typeof original }).getProjectProjection = (projectId: string) => {
        rebuilds += 1;
        return original(projectId);
      };
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(rebuilds, 0, 'idle ticks must probe event sequences, not rebuild');
      assert.equal(bridge.getSnapshot().revision, first);
      // A new event anywhere makes the next tick rebuild and publish.
      const imported = service.importMaterial({
        operationId: 'gate-material',
        projectId: 'project-gate',
        expectedProjectRevision: storage.inspectProject('project-gate')!.revision,
        materialId: 'gate-material',
        displayName: '门控材料',
        sourceKind: 'pasted_text',
        sourceReference: 'test',
        role: 'illustrative',
        trustLabel: 'user_provided_untrusted',
        permissionScope: 'project_only',
        content: '门控测试内容',
        actor,
      });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      await waitUntil(() => rebuilds > 0 && bridge.getSnapshot().revision > first);
      unsubscribe();
    } finally {
      bridge.dispose(); storage.close(); rmSync(workspacePath, { recursive: true, force: true });
    }
  });
  it("selects an existing project without sessions and starts its first conversation", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-empty-project-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-empty", "test");
    seedProject(service, "project-current", "当前项目");
    const bridge = bridgeFor(service);
    try {
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-current");

      await bridge.selectProject("project-empty");

      assert.equal(bridge.getSnapshot().selectedProjectId, "project-empty");
      assert.equal(bridge.getSnapshot().selectedSessionId, "");
      const started = await bridge.sendMessage("从这个老项目开始新对话", {
        operationId: "start-empty-project",
      });
      assert.notEqual(started.runId, "");
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-empty");
      assert.notEqual(bridge.getSnapshot().selectedSessionId, "");
      assert.equal(
        storage.getSession(bridge.getSnapshot().selectedSessionId)?.projectId,
        "project-empty",
      );
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists UI appearance and can restore the default across bridge instances", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-settings-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "设置项目");
    let saved: { theme: "light" | "dark" | "system"; contentFontSize: number } | null = null;
    const persistence = {
      load: () => saved,
      save: (value: { theme: "light" | "dark" | "system"; contentFontSize: number }) => {
        saved = { ...value };
      },
    };
    try {
      const first = bridgeFor(service, undefined, persistence);
      await first.updateSettings({ theme: "dark", contentFontSize: 16 });
      first.dispose();

      const reopened = bridgeFor(service, undefined, persistence);
      assert.equal(reopened.getSnapshot().settings.theme, "dark");
      assert.equal(reopened.getSnapshot().settings.contentFontSize, 16);
      await reopened.updateSettings({ theme: "system", contentFontSize: 14 });
      reopened.dispose();

      const reset = bridgeFor(service, undefined, persistence);
      assert.equal(reset.getSnapshot().settings.theme, "system");
      assert.equal(reset.getSnapshot().settings.contentFontSize, 14);
      reset.dispose();
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("projects block locks, persisted diffs, accepted versions, and project-scoped editor state", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-revisions-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "修订项目");
    seedProject(service, "project-2", "隔离项目");
    const project = storage.inspectProject("project-1");
    assert.notEqual(project, null);
    const body = storage.commitArtifactVersion({
      operationId: "revision-body",
      projectId: "project-1",
      expectedProjectRevision: project?.revision ?? -1,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 标题\n\n保持这段。\n\n修改这一段。",
      reason: "revision fixture",
      actor,
    });
    assert.equal(body.ok, true);
    storage.createSession({
      sessionId: "project-1-session",
      projectId: "project-1",
      purpose: "writing-pack:draft",
    });
    storage.createSession({
      sessionId: "project-2-session",
      projectId: "project-2",
      purpose: "writing-pack:draft",
    });
    const bridge = bridgeFor(service);
    try {
      await bridge.selectSession("project-1", "project-1-session");
      const initial = bridge.getSnapshot().revisionWorkspace;
      assert.equal(initial.blocks.length, 3);
      const locked = initial.blocks[1];
      const editable = initial.blocks[2];
      assert.notEqual(locked, undefined);
      assert.notEqual(editable, undefined);
      if (locked === undefined || editable === undefined || initial.bodyVersionId === null) return;

      await bridge.setBlockLock(
        initial.bodyVersionId,
        locked.id,
        locked.contentHash,
        "lock",
        { operationId: "bridge-lock" },
      );
      assert.equal(bridge.getSnapshot().revisionWorkspace.blocks[1]?.locked, true);
      await assert.rejects(
        bridge.proposeRevision({
          baseBodyVersionId: initial.bodyVersionId,
          instruction: "不得改锁定段",
          edits: [{
            type: "replace",
            targetBlockId: locked.id,
            baseBlockHash: locked.contentHash,
            content: "错误修改。",
          }],
        }, { operationId: "bridge-locked-proposal" }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "LOCK_CONFLICT",
      );

      const proposal = await bridge.proposeRevision({
        baseBodyVersionId: initial.bodyVersionId,
        instruction: "让末段更具体",
        edits: [{
          type: "replace",
          targetBlockId: editable.id,
          baseBlockHash: editable.contentHash,
          content: "修改后的具体段落。",
        }],
      }, { operationId: "bridge-proposal" });
      const preview = bridge.getSnapshot().revisionWorkspace.proposals.find(
        (candidate) => candidate.id === proposal.proposalId,
      );
      assert.equal(preview?.diff[0]?.before, "修改这一段。");
      assert.equal(preview?.diff[0]?.after, "修改后的具体段落。");
      const accepted = await bridge.acceptRevision(proposal.proposalId, {
        operationId: "bridge-accept",
      });
      assert.equal(accepted.status, "created");
      assert.match(bridge.getSnapshot().previewDocument.body, /修改后的具体段落/u);
      assert.equal(bridge.getSnapshot().revisionWorkspace.versions.length, 2);

      await bridge.selectSession("project-2", "project-2-session");
      assert.equal(bridge.getSnapshot().revisionWorkspace.bodyVersionId, null);
      assert.deepEqual(bridge.getSnapshot().revisionWorkspace.blocks, []);
      assert.deepEqual(bridge.getSnapshot().revisionWorkspace.proposals, []);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("projects the computed fact gate and provenance without cross-project leakage", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-fact-check-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "核查项目");
    seedProject(service, "project-2", "隔离项目");
    const body = storage.commitArtifactVersion({
      operationId: "fact-body",
      projectId: "project-1",
      expectedProjectRevision: 2,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 核查标题\n\n只有作者感受。",
      reason: "fact fixture",
      actor,
    });
    assert.equal(body.ok, true);
    if (!body.ok) return;
    const title = storage.commitArtifactVersion({
      operationId: "fact-title",
      projectId: "project-1",
      expectedProjectRevision: body.projectRevision,
      kind: "title",
      logicalKey: "main",
      baseVersionId: null,
      content: "- 选择状态：已锁定\n- 最终标题：「核查标题」\n",
      reason: "fact fixture",
      actor,
    });
    assert.equal(title.ok, true);
    if (!title.ok) return;
    const evidence = storage.commitArtifactVersion({
      operationId: "fact-evidence",
      projectId: "project-1",
      expectedProjectRevision: title.projectRevision,
      kind: "evidence",
      logicalKey: "main",
      baseVersionId: null,
      content: JSON.stringify({ claims: [], notes: "没有外部事实" }),
      reason: "fact fixture",
      actor,
    });
    assert.equal(evidence.ok, true);
    if (!evidence.ok) return;
    const frozen = service.createFactCheckSnapshot({
      operationId: "fact-freeze",
      projectId: "project-1",
      expectedProjectRevision: evidence.projectRevision,
      bodyVersionId: body.result.versionId,
      titleVersionId: title.result.versionId,
      evidenceVersionId: evidence.result.versionId,
      actor,
    });
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    const assessed = service.evaluateFactCheckSnapshot({
      operationId: "fact-evaluate",
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
        noFactualClaimsReason: "只有作者感受。",
      },
      actor,
    });
    assert.equal(assessed.ok, true);
    storage.createSession({
      sessionId: "project-1-session",
      projectId: "project-1",
      purpose: "writing-pack:draft",
    });
    storage.createSession({
      sessionId: "project-2-session",
      projectId: "project-2",
      purpose: "writing-pack:draft",
    });
    const bridge = bridgeFor(service);
    try {
      await bridge.selectSession("project-1", "project-1-session");
      const fact = bridge.getSnapshot().factCheckWorkspace;
      assert.equal(fact.status, "passed");
      assert.equal(fact.snapshot?.id, frozen.result.snapshotId);
      assert.equal(fact.assessment?.status, "passed");
      assert.equal(fact.provenance.length, 3);
      assert.match(fact.notice, /不承诺事实绝对正确/u);

      const workingCopy = await bridge.saveWorkingCopy({
        operationId: "bridge-working-copy",
      });
      assert.equal(workingCopy.mode, "working_copy");
      const duplicateWorkingCopy = await bridge.saveWorkingCopy({
        operationId: "bridge-working-copy",
      });
      assert.equal(duplicateWorkingCopy.id, workingCopy.id);
      const publication = await bridge.exportPublication("html", {
        operationId: "bridge-publication-html",
        layoutPreset: "editorial",
      });
      assert.equal(publication.mode, "publication");
      assert.equal(publication.format, "html");
      assert.match(publication.relativePath, /-editorial\.html$/u);
      const delivery = bridge.getSnapshot().deliveryWorkspace;
      assert.equal(delivery.bodyVersionId, body.result.versionId);
      assert.equal(delivery.gateStatus, "passed");
      assert.equal(delivery.exports.length, 2);

      await bridge.selectSession("project-2", "project-2-session");
      assert.equal(bridge.getSnapshot().factCheckWorkspace.status, "not_checked");
      assert.deepEqual(bridge.getSnapshot().factCheckWorkspace.provenance, []);
      assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, null);
      assert.deepEqual(bridge.getSnapshot().deliveryWorkspace.exports, []);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("projects saved brief/run/artifact state without material content or source paths", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-application-bridge-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "真实项目");
    const bridge = bridgeFor(service);
    try {
      const handshake = await bridge.handshake();
      assert.equal(handshake.mock, false);
      assert.equal(handshake.persistsUserProjects, true);
      assert.equal(bridge.getSnapshot().brief?.confirmationStatus, "confirmed");
      const before = JSON.stringify(bridge.getSnapshot());
      assert.equal(before.includes("C:\\private"), false);
      assert.equal(before.includes("PRIVATE-project-1-BODY"), false);

      const first = await bridge.sendMessage("按已确认简报生成草稿", {
        operationId: "start-once",
      });
      const duplicate = await bridge.sendMessage("按已确认简报生成草稿", {
        operationId: "start-once",
      });
      assert.equal(duplicate.runId, first.runId);
      await assert.rejects(
        bridge.sendMessage("换一个输入", { operationId: "start-once" }),
        /IDEMPOTENCY_KEY_REUSED/u,
      );
      await waitUntil(() => storage.getRun(first.runId)?.status === "completed");
      await bridge.refresh();
      const snapshot = bridge.getSnapshot();
      assert.equal(snapshot.previewDocument.version, 3);
      assert.match(snapshot.previewDocument.body, /Bridge 持久草稿/u);
      assert.equal(snapshot.activeRunId, null);
      const timeline = snapshot.timelineBySession[snapshot.selectedSessionId] ?? [];
      assert.equal(timeline.some((item) => item.kind === "message" && item.role === "user"), true);
      assert.equal(timeline.some((item) => item.kind === "message" && item.role === "assistant"), true);
      const factSummary = timeline.find((item) =>
        item.kind === "message" &&
        item.role === "assistant" &&
        item.body.includes("核查范围：文章正文、标题和发布配文")
      );
      assert.equal(
        factSummary?.kind === "message" &&
        factSummary.body.includes("合成测试正文没有外部事实主张") &&
        factSummary.body.includes("未列出的信息做外部验证") &&
        !/快照|门禁|证据账本/u.test(factSummary.body),
        true,
      );
      await bridge.refresh();
      const refreshedTimeline = bridge.getSnapshot().timelineBySession[snapshot.selectedSessionId] ?? [];
      const refreshedFactSummary = refreshedTimeline.find((item) => item.id === factSummary?.id);
      assert.equal(
        refreshedFactSummary?.kind === "message" ? refreshedFactSummary.body : undefined,
        factSummary?.kind === "message" ? factSummary.body : undefined,
      );
      assert.equal(
        timeline.some((item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          item.body.includes("Bridge 持久草稿")
        ),
        true,
      );
      assert.equal(
        timeline.some((item) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          /稿件已持久保存为版本|[0-9a-f]{8}-[0-9a-f-]{27}/u.test(item.body)
        ),
        false,
      );
      assert.equal(
        timeline.some((item) =>
          item.kind === "tool" &&
          item.label === "读取参考材料" &&
          item.detail === "已完成"
        ),
        false, // Short material was supplied inline; do not invent a tool read.
      );
      assert.equal(
        timeline.some((item) =>
          item.kind === "tool" &&
          (item.label.includes("调用工具") || item.detail.includes("持久"))
        ),
        false,
      );
      assert.equal(
        timeline.some((item) =>
          item.kind === "tool" &&
          item.label === "运行完成" &&
          item.detail === "稿件已保存，当前版本可正式导出"
        ),
        true,
      );
      assert.deepEqual(
        snapshot.runRecords.at(-1)?.stages.map((stage) => [stage.id, stage.status]),
        [
          ["research", "completed"],
          ["outline", "completed"],
          ["draft", "completed"],
          ["review_editor", "completed"],
          ["review_reader", "completed"],
          ["central_revision", "completed"],
          ["language_review", "completed"],
          ["fact_check", "completed"],
        ],
      );
      assert.equal(snapshot.runRecords.at(-1)?.publicationReady, true);
      const process = snapshot.materialProcessWorkspace;
      assert.equal(process.materials.length, 1);
      assert.equal(process.materials[0]?.displayName, "内部材料.md");
      assert.equal(process.materials[0]?.sourceKind, "utf8_file");
      assert.match(process.evidence?.content ?? "", /仅使用授权材料/u);
      assert.doesNotMatch(process.evidence?.content ?? "", /^\s*\{/u);
      assert.match(process.outline?.content ?? "", /提纲/u);
      assert.deepEqual(
        process.reviews.map((review) => review.stage),
        ["review_editor", "review_reader"],
      );
      const draftVersionId = snapshot.revisionWorkspace.versions[0]?.id;
      assert.notEqual(draftVersionId, undefined);
      assert.equal(
        process.reviews.every((review) => review.bodyVersionId === draftVersionId),
        true,
      );

      const second = await bridge.sendMessage("基于同一简报重新生成一版", {
        operationId: "start-second-run",
      });
      await waitUntil(() => storage.getRun(second.runId)?.status === "completed");
      await bridge.refresh();
      const latestProcess = bridge.getSnapshot().materialProcessWorkspace;
      assert.deepEqual(
        latestProcess.reviews.map((review) => review.stage),
        ["review_editor", "review_reader"],
      );
      assert.equal(
        latestProcess.reviews.every((review) => review.runId === second.runId),
        true,
      );
      const projected = JSON.stringify(snapshot);
      assert.equal(projected.includes("C:\\private"), false);
      assert.equal(projected.includes("PRIVATE-project-1-BODY"), false);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("projects an actionable model failure instead of generic persisted-event text", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-model-error-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({
      storage,
      provider: new UnsupportedModelProvider(),
    });
    seedProject(service, "project-1", "错误提示项目");
    const bridge = bridgeFor(service);
    try {
      const { runId } = await bridge.sendMessage("开始写作", {
        operationId: "unsupported-model-run",
      });
      await waitUntil(() => storage.getRun(runId)?.status === "failed");
      await bridge.refresh();

      const timeline = bridge.getSnapshot().timelineBySession[
        bridge.getSnapshot().selectedSessionId
      ] ?? [];
      assert.equal(
        timeline.some((item) =>
          item.kind === "tool" &&
          item.detail === "模型名称不可用，请检查服务商提供的模型 ID，并在“设置 → 模型”中验证连接。"
        ),
        true,
      );
      assert.equal(
        timeline.some((item) => item.kind === "tool" && item.detail === "状态来自持久事件"),
        false,
      );
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reruns only fact checking after a user edit and projects one actionable stage", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-fact-rerun-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "重新核查项目");
    const bridge = bridgeFor(service);
    try {
      const drafted = await bridge.sendMessage("先生成完整稿件", {
        operationId: "fact-rerun-draft",
      });
      await waitUntil(() => storage.getRun(drafted.runId)?.status === "completed");
      await bridge.refresh();
      const beforeEdit = bridge.getSnapshot();
      assert.notEqual(beforeEdit.revisionWorkspace.bodyVersionId, null);
      const processReviewIds = beforeEdit.materialProcessWorkspace.reviews.map((review) => review.id);
      assert.equal(processReviewIds.length, 2);
      await bridge.saveBody(
        beforeEdit.revisionWorkspace.bodyVersionId!,
        "# Bridge 持久草稿\n\n这是用户修订后的本地感受。",
        "用户手工修订",
        { operationId: "fact-rerun-edit" },
      );
      assert.equal(bridge.getSnapshot().factCheckWorkspace.status, "stale");
      const bodyCount = bridge.getSnapshot().previewDocument.version;

      const checked = await bridge.runFactCheck({ operationId: "fact-rerun-only" });
      await waitUntil(() => storage.getRun(checked.runId)?.status === "completed");
      await bridge.refresh();
      const after = bridge.getSnapshot();
      assert.equal(after.previewDocument.version, bodyCount);
      assert.equal(after.factCheckWorkspace.status, "passed");
      assert.deepEqual(
        after.runRecords.at(-1)?.stages.map((stage) => [stage.id, stage.status]),
        [["fact_check", "completed"]],
      );
      assert.equal(after.runRecords.at(-1)?.publicationReady, true);
      const completion = JSON.stringify(after.timelineBySession[after.selectedSessionId]);
      assert.match(completion, /下一步.*查看当前稿件.*导出文章/u);
      assert.equal(storage.listRunEvents(checked.runId).filter(event => event.type === 'request.dispatch_attempted').length, 1);
      assert.deepEqual(
        after.materialProcessWorkspace.reviews.map((review) => review.id),
        processReviewIds,
      );
      storage.startRun({ projectId: 'project-1', sessionId: after.selectedSessionId, runId: 'protected-fact-check',
        operationId: 'protected-fact-start', purpose: 'writing-pack:fact-check', planVersion: 'test' });
      storage.finishRun({ projectId: 'project-1', runId: 'protected-fact-check', operationId: 'protected-fact-stop',
        status: 'budget_exhausted', stopReason: 'BUDGET_EXHAUSTED' });
      await bridge.refresh();
      assert.ok(bridge.getSnapshot().recoverableRuns.some(run => run.runId === 'protected-fact-check'));
      await bridge.resumeRun('protected-fact-check', 'resume', { operationId: 'retry-protected-fact' });
      const restarted = storage.listRuns('project-1').at(-1)!;
      assert.equal(storage.listRunEvents(restarted.id).find(event => event.type === 'run.started')?.payload.purpose, 'writing-pack:fact-check');
      await waitUntil(() => storage.getRun(restarted.id)?.status === 'completed');
      await bridge.refresh();
      assert.equal(bridge.getSnapshot().previewDocument.version, bodyCount);
      assert.equal(storage.getRun('protected-fact-check')?.status, 'cancelled');
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists cancellation before abort and ignores the provider's late final text", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-cancel-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    provider.holdFinal = true;
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "取消项目");
    const bridge = bridgeFor(service);
    try {
      const { runId } = await bridge.sendMessage("开始写作");
      await provider.finalStarted;
      await bridge.cancelRun(runId, { operationId: "cancel-once" });
      provider.release();
      await waitUntil(() => storage.getRun(runId)?.status === "cancelled");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await bridge.refresh();
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 3);
      assert.notEqual(bridge.getSnapshot().previewDocument.id, null);
      assert.equal(bridge.getSnapshot().activeRunId, null);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("keeps a late project-one completion out of the selected project-two view", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-generation-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    provider.holdFinal = true;
    const service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "项目一");
    seedProject(service, "project-2", "项目二");
    storage.createSession({
      sessionId: "project-1-session",
      projectId: "project-1",
      purpose: "writing-pack:draft",
    });
    storage.createSession({
      sessionId: "project-2-session",
      projectId: "project-2",
      purpose: "writing-pack:draft",
    });
    const bridge = bridgeFor(service);
    try {
      await bridge.selectSession("project-1", "project-1-session");
      const { runId } = await bridge.sendMessage("开始写作");
      await provider.finalStarted;
      await bridge.selectSession("project-2", "project-2-session");
      const selectedGeneration = bridge.getSnapshot().generation;
      provider.release();
      await waitUntil(() => storage.getRun(runId)?.status === "completed");
      await bridge.refresh();
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-2");
      assert.equal(bridge.getSnapshot().selectedSessionId, "project-2-session");
      assert.equal(bridge.getSnapshot().generation, selectedGeneration);
      assert.equal(bridge.getSnapshot().previewDocument.id, null);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("recovers an unfinished run after reopen while preserving the latest committed body", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-bridge-recovery-"));
    let storage = openWorkspaceStorage({ workspacePath });
    const provider = new BridgeWritingProvider();
    let service = new WritingApplicationService({ storage, provider });
    seedProject(service, "project-1", "恢复项目");
    const project = storage.inspectProject("project-1");
    assert.notEqual(project, null);
    const committed = storage.commitArtifactVersion({
      operationId: "saved-before-crash",
      projectId: "project-1",
      expectedProjectRevision: project?.revision ?? -1,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "# 已保存版本\n\n这个版本必须在重启后恢复。",
      reason: "recovery fixture",
      requestSnapshotId: null,
      actor,
    });
    assert.equal(committed.ok, true);
    storage.createSession({
      sessionId: "interrupted-session",
      projectId: "project-1",
      purpose: "writing-pack:draft",
    });
    storage.startRun({
      runId: "interrupted-run",
      sessionId: "interrupted-session",
      projectId: "project-1",
      planVersion: "writing-pack-v1",
      displayInstruction: "中断前的任务",
      expectedBodyVersionId: committed.ok ? committed.result.versionId : null,
      budget: { maxModelRequests: 48, maxToolCalls: 64, maxRetriesPerRequest: 0, maxMajorRevisions: 1 },
    });
    storage.close();

    storage = openWorkspaceStorage({ workspacePath });
    service = new WritingApplicationService({ storage, provider });
    const recovered = service.recoverWorkspace();
    assert.deepEqual(recovered.map((run) => run.runId), ["interrupted-run"]);
    const bridge = bridgeFor(service);
    try {
      await bridge.selectSession("project-1", "interrupted-session");
      const snapshot = bridge.getSnapshot();
      assert.match(snapshot.previewDocument.body, /这个版本必须在重启后恢复/u);
      assert.deepEqual(
        snapshot.recoverableRuns.map((run) => [run.runId, run.status]),
        [["interrupted-run", "interrupted"]],
      );
      await bridge.resumeRun("interrupted-run", "resume", {
        operationId: "resume-interrupted-run",
      });
      await waitUntil(
        () => storage.getRun("interrupted-run")?.status === "completed",
      );
      await bridge.refresh();
      assert.deepEqual(bridge.getSnapshot().recoverableRuns, []);
      assert.equal(bridge.getSnapshot().previewDocument.version, 4);
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
