import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { WritingApplicationService } from "../src/index.js";
import { pendingStageCheckpoint } from "../src/workflow-tools.js";
import { collaborationState, publicStageFixtureEvents } from "./collaboration-fixture.js";
import { withCheckpointIntent, withIntentFixture } from "./intent-fixture.js";

class RecoveryProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];
  constructor() {
    super("checkpoint-recovery", "1.0.0", {
      protocol: "mock",
      tools: "supported",
      streaming: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    const state = collaborationState(request);
    if (state === null) {
      yield { type: "text_delta", delta: "继续当前流程。" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const alreadyReady = request.messages.some((message) =>
      message.role === "tool" && message.name === "assess_writing_readiness" &&
      JSON.parse(message.content).ok === true,
    );
    let name: string;
    let args: unknown;
    if (state.actor === "director") {
      const readIds = request.messages.flatMap((message) =>
        message.role === "tool" && message.name === "read_artifact_version"
          ? [JSON.parse(message.content).result?.versionId]
          : [],
      );
      const unread = !state.ready
        ? state.unreadArtifactVersionIds.find((id) => !readIds.includes(id))
        : undefined;
      if (unread !== undefined) {
        yield {
          type: "tool_call_delta",
          index: 0,
          id: `read-${request.requestId}`,
          name: "read_artifact_version",
          argumentsDelta: JSON.stringify({ versionId: unread }),
        };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
      if (!state.ready && !alreadyReady) {
        name = "assess_writing_readiness";
        args = { status: "ready", reason: "输入完整", questions: [] };
      } else {
        name = "director_decide";
        args = {
          action: state.nextStage === null ? "finish" : "dispatch",
          stage: state.nextStage,
          reason: "按当前已确认版本继续。",
          questions: [],
        };
      }
    } else if (state.stage === "fact_check") {
      name = "submit_fact_check";
      args = { claims: [], noFactualClaimsReason: "没有外部事实主张。" };
    } else {
      name = "submit_writing_stage";
      args = {
        stage: state.stage,
        content: state.stage === "research"
          ? '{"claims":[],"notes":"无外部事实"}'
          : state.stage?.startsWith("review_")
            ? `${state.stage} 审校意见`
            : `# 当前稿件\n\n${state.stage} 正文。`,
      };
    }
    const publicEvents = publicStageFixtureEvents(request, name, args);
    if (publicEvents !== null) {
      yield* publicEvents;
      return;
    }
    yield {
      type: "tool_call_delta",
      index: 0,
      id: `${name}-${request.requestId}`,
      name,
      argumentsDelta: JSON.stringify(args),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

function setup() {
  const workspacePath = mkdtempSync(join(tmpdir(), "checkpoint-body-recovery-"));
  const storage = openWorkspaceStorage({ workspacePath });
  const provider = new RecoveryProvider();
  const app = new WritingApplicationService({ storage, provider: withIntentFixture(provider) });
  const actor = { kind: "user", id: "u" } as const;
  app.createProject({ operationId: "project", projectId: "p", name: "test", mode: "deep", actor });
  const brief = app.saveWritingBrief({
    operationId: "brief",
    projectId: "p",
    expectedProjectRevision: storage.inspectProject("p")!.revision,
    baseVersionId: null,
    actor,
    brief: {
      schemaVersion: 1,
      topic: "当前稿件",
      genre: "narrative_observation",
      audience: "读者",
      lengthTarget: { targetCharacters: 800 },
      materialIds: [],
      constraints: [],
      interactionMode: "co_creation",
      authorAuthorization: {
        voice: "克制",
        styleReference: null,
        styleDecision: "user_confirmed",
        directionDecision: "user_confirmed",
        firsthandMaterialIds: [],
      },
      platform: null,
      publicationGoal: "not_applicable",
      confirmationStatus: "confirmed",
    },
  });
  assert.equal(brief.ok, true);
  const input = {
    projectId: "p",
    expectedProjectRevision: storage.inspectProject("p")!.revision,
    expectedBriefVersionId: storage.inspectProject("p")!.currentBriefVersionId!,
    model: "mock",
    parameters: {},
    budget: { maxModelRequests: 80, maxToolCalls: 100, maxRetriesPerRequest: 0, maxMajorRevisions: 1 },
  };
  return {
    storage,
    app,
    provider,
    input,
    close() {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

async function approveCurrentCheckpoint(f: ReturnType<typeof setup>, runId: string, operationId: string) {
  return f.app.resumeDraft(withCheckpointIntent(f.storage, {
    ...f.input,
    runId,
    operationId,
    decision: "resume",
    userInstruction: "确认以当前保存版本继续",
    expectedProjectRevision: f.storage.inspectProject("p")!.revision,
  })).result;
}

it("rebinds a manually saved draft after explicit confirmation and reviews that exact version", async () => {
  const f = setup();
  try {
    const first = await f.app.runDraft(f.input);
    const outlineResult = await approveCurrentCheckpoint(f, first.runId, "approve-outline");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "draft", JSON.stringify({ outlineResult, run: f.storage.getRun(first.runId), tail: f.storage.listRunEvents(first.runId).slice(-5) }));

    const beforeEdit = f.storage.inspectProject("p")!;
    const edited = f.app.saveBody({
      operationId: "manual-draft-edit",
      projectId: "p",
      expectedProjectRevision: beforeEdit.revision,
      baseBodyVersionId: beforeEdit.latestBodyVersionId!,
      content: "# 用户当前稿\n\n保留这段手动修改。",
      reason: "author edit at checkpoint",
      actor: { kind: "user", id: "u" },
    });
    assert.equal(edited.ok, true);
    if (!edited.ok) return;

    const resumed = await approveCurrentCheckpoint(f, first.runId, "approve-current-draft");
    assert.equal(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(f.storage.getRun(first.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_editor");
    assert.equal(f.storage.inspectProject("p")!.latestBodyVersionId, edited.result.versionId);
    const reviewMarker = f.storage.listArtifactVersions("p", "report", `workflow:${first.runId}:review_editor`).at(-1)!;
    const review = f.storage.getArtifactVersion(JSON.parse(reviewMarker.content).artifactVersionId)!;
    assert.equal(JSON.parse(review.content).bodyVersionId, edited.result.versionId);
    assert.equal(f.storage.listRunEvents(first.runId).some((event) =>
      ["WRITING_INPUT_REQUIRED", "REVIEW_DRAFT_CHANGED"].includes((event.payload.result as any)?.error?.code)), false);
  } finally {
    f.close();
  }
});

it("accepts carried reviews only through their persisted source-run envelope", async () => {
  const f = setup();
  try {
    const first = await f.app.runDraft(f.input);
    let lastResult: unknown;
    for (let index = 0; index < 4; index += 1) {
      lastResult = await approveCurrentCheckpoint(f, first.runId, `source-approve-${index}`);
    }
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_reader", JSON.stringify({ lastResult, run: f.storage.getRun(first.runId), tail: f.storage.listRunEvents(first.runId).slice(-5) }));
    f.app.cancelDraft({ projectId: "p", runId: first.runId, operationId: "cancel-source", reason: "restart application" });

    const second = await f.app.runDraft({
      ...f.input,
      sessionId: f.storage.getRun(first.runId)!.sessionId,
      expectedProjectRevision: f.storage.inspectProject("p")!.revision,
      userInstruction: "继续保存的流程",
    });
    assert.equal(f.storage.getRun(second.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
    assert.equal(f.storage.listRunEvents(second.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_reader");

    const resumed = await approveCurrentCheckpoint(f, second.runId, "approve-carried-review");
    assert.equal(resumed.ok, false, JSON.stringify(resumed));
    assert.equal(f.storage.listRunEvents(second.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "central_revision");
    assert.equal(f.storage.listRunEvents(second.runId).some((event) =>
      (event.payload.result as any)?.error?.code === "REVIEW_BINDING_INVALID"), false);
  } finally {
    f.close();
  }
});

it("invalidates stale reviews after a confirmed manual edit and then advances after the replacement review", async () => {
  const f = setup();
  try {
    const first = await f.app.runDraft(f.input);
    await approveCurrentCheckpoint(f, first.runId, "review-edit-outline");
    await approveCurrentCheckpoint(f, first.runId, "review-edit-draft");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_editor");
    const staleMarker = f.storage.listArtifactVersions("p", "report", `workflow:${first.runId}:review_editor`).at(-1)!;

    const beforeEdit = f.storage.inspectProject("p")!;
    const edited = f.app.saveBody({
      operationId: "manual-edit-after-review",
      projectId: "p",
      expectedProjectRevision: beforeEdit.revision,
      baseBodyVersionId: beforeEdit.latestBodyVersionId!,
      content: "# 用户审阅稿\n\n这是确认时的当前正文。",
      reason: "author edit after review",
      actor: { kind: "user", id: "u" },
    });
    assert.equal(edited.ok, true);
    if (!edited.ok) return;

    await approveCurrentCheckpoint(f, first.runId, "approve-edited-review");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_editor");
    const invalidations = f.storage.listArtifactVersions("p", "report", `workflow-invalidated:${first.runId}`)
      .flatMap((version) => JSON.parse(version.content).markerIds ?? []);
    assert.ok(invalidations.includes(staleMarker.id));
    const replacementMarker = f.storage.listArtifactVersions("p", "report", `workflow:${first.runId}:review_editor`).at(-1)!;
    assert.notEqual(replacementMarker.id, staleMarker.id);
    const replacement = f.storage.getArtifactVersion(JSON.parse(replacementMarker.content).artifactVersionId)!;
    assert.equal(JSON.parse(replacement.content).bodyVersionId, edited.result.versionId);

    await approveCurrentCheckpoint(f, first.runId, "approve-replacement-review");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_publish");
  } finally {
    f.close();
  }
});

it("carries a revision request as pending work, preserves its exact text, and never advances the stale draft", async () => {
  const f = setup();
  try {
    const first = await f.app.runDraft(f.input);
    await approveCurrentCheckpoint(f, first.runId, "revise-carry-outline");
    assert.equal(f.storage.listRunEvents(first.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "draft");
    const originalBodyId = f.storage.inspectProject("p")!.latestBodyVersionId!;
    const revisionText = "提纲改成对比结构";
    await f.app.resumeDraft(withCheckpointIntent(f.storage, {
      ...f.input,
      runId: first.runId,
      operationId: "request-draft-revision",
      decision: "resume",
      userInstruction: revisionText,
      expectedProjectRevision: f.storage.inspectProject("p")!.revision,
    })).result;
    f.app.cancelDraft({ projectId: "p", runId: first.runId, operationId: "cancel-revision-source", reason: "restart after revision request" });

    const requestCount = f.provider.requests.length;
    const second = await f.app.runDraft({
      ...f.input,
      sessionId: f.storage.getRun(first.runId)!.sessionId,
      expectedProjectRevision: f.storage.inspectProject("p")!.revision,
      userInstruction: "继续未完成的返工",
    });
    assert.equal(f.storage.getRun(second.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
    assert.equal(f.storage.listRunEvents(second.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "draft");
    assert.equal(f.storage.listArtifactVersions("p", "report", `workflow:${second.runId}:review_editor`).length, 0,
      "the stale draft must not be treated as approved and sent to review");
    assert.ok(f.storage.getArtifactVersion(originalBodyId), "the original body version must remain recoverable");
    const rework = f.storage.listArtifactVersions("p", "report", `workflow-carried-rework:${second.runId}`).at(-1);
    assert.ok(rework, "the author revision request must be persisted before carried stages are rebuilt");
    assert.equal(JSON.parse(rework.content).instruction, revisionText);
    const draftRequest = f.provider.requests.slice(requestCount).find(request => collaborationState(request)?.stage === "draft");
    assert.ok(draftRequest);
    assert.match(JSON.stringify(draftRequest.messages), /提纲改成对比结构/u,
      "the replacement draft must receive the persisted author instruction");
  } finally {
    f.close();
  }
});

async function rebuildDraftFromCarriedRevision(f: ReturnType<typeof setup>, prefix: string) {
  const first = await f.app.runDraft(f.input);
  await approveCurrentCheckpoint(f, first.runId, `${prefix}-outline`);
  const revisionText = "提纲改成对比结构";
  await f.app.resumeDraft(withCheckpointIntent(f.storage, {
    ...f.input,
    runId: first.runId,
    operationId: `${prefix}-request-revision`,
    decision: "resume",
    userInstruction: revisionText,
    expectedProjectRevision: f.storage.inspectProject("p")!.revision,
  })).result;
  f.app.cancelDraft({ projectId: "p", runId: first.runId, operationId: `${prefix}-cancel-source`, reason: "restart after revision request" });
  const second = await f.app.runDraft({
    ...f.input,
    sessionId: f.storage.getRun(first.runId)!.sessionId,
    expectedProjectRevision: f.storage.inspectProject("p")!.revision,
    userInstruction: "继续未完成的返工",
  });
  assert.equal(f.storage.listRunEvents(second.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "draft");
  return { second, revisionText };
}

it("reuses a rebuilt draft awaiting confirmation instead of executing the carried revision again", async () => {
  const f = setup();
  try {
    const { second, revisionText } = await rebuildDraftFromCarriedRevision(f, "unapproved-rebuild");
    const rebuiltBodyId = f.storage.inspectProject("p")!.latestBodyVersionId!;
    const rebuiltMarker = f.storage.listArtifactVersions("p", "report", `workflow:${second.runId}:draft`).at(-1)!;
    const rebuiltArtifactId = JSON.parse(rebuiltMarker.content).artifactVersionId;
    f.app.cancelDraft({ projectId: "p", runId: second.runId, operationId: "cancel-unapproved-rebuild", reason: "restart before approval" });

    const requestCount = f.provider.requests.length;
    const third = await f.app.runDraft({
      ...f.input,
      sessionId: f.storage.getRun(second.runId)!.sessionId,
      expectedProjectRevision: f.storage.inspectProject("p")!.revision,
      userInstruction: "恢复刚保存的返工稿",
    });
    assert.equal(f.storage.listRunEvents(third.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "draft");
    assert.equal(f.storage.inspectProject("p")!.latestBodyVersionId, rebuiltBodyId);
    assert.equal(f.provider.requests.slice(requestCount).some(request => collaborationState(request)?.stage === "draft"), false,
      "a saved replacement needs confirmation, not another draft request");
    const carriedMarker = f.storage.listArtifactVersions("p", "report", `workflow:${third.runId}:draft`).at(-1)!;
    assert.equal(JSON.parse(carriedMarker.content).artifactVersionId, rebuiltArtifactId);
    const carriedRework = f.storage.listArtifactVersions("p", "report", `workflow-carried-rework:${third.runId}`).at(-1)!;
    assert.equal(JSON.parse(carriedRework.content).instruction, revisionText);
  } finally {
    f.close();
  }
});

it("reuses an approved rebuilt draft and resumes at its pending review without repeating the revision", async () => {
  const f = setup();
  try {
    const { second } = await rebuildDraftFromCarriedRevision(f, "approved-rebuild");
    await approveCurrentCheckpoint(f, second.runId, "approve-rebuilt-draft");
    assert.equal(f.storage.listRunEvents(second.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_editor");
    const rebuiltBodyId = f.storage.inspectProject("p")!.latestBodyVersionId!;
    const rebuiltMarker = f.storage.listArtifactVersions("p", "report", `workflow:${second.runId}:draft`).at(-1)!;
    const rebuiltArtifactId = JSON.parse(rebuiltMarker.content).artifactVersionId;
    f.app.cancelDraft({ projectId: "p", runId: second.runId, operationId: "cancel-approved-rebuild", reason: "restart after approval" });

    const requestCount = f.provider.requests.length;
    const third = await f.app.runDraft({
      ...f.input,
      sessionId: f.storage.getRun(second.runId)!.sessionId,
      expectedProjectRevision: f.storage.inspectProject("p")!.revision,
      userInstruction: "恢复已认可的返工稿",
    });
    assert.equal(f.storage.listRunEvents(third.runId).findLast((event) => event.type === "run.waiting_user")?.payload.stage, "review_editor");
    assert.equal(f.storage.inspectProject("p")!.latestBodyVersionId, rebuiltBodyId);
    assert.equal(f.provider.requests.slice(requestCount).some(request => collaborationState(request)?.stage === "draft"), false);
    const carriedMarker = f.storage.listArtifactVersions("p", "report", `workflow:${third.runId}:draft`).at(-1)!;
    assert.equal(JSON.parse(carriedMarker.content).artifactVersionId, rebuiltArtifactId);
  } finally {
    f.close();
  }
});

for (const decision of ["resume", "retry_unknown"] as const) {
  it(`legacy resume author-intent recovery is ${decision === "resume" ? "accepted" : "not mistaken for approval"}`, async () => {
    const f = setup();
    try {
      const first = await f.app.runDraft(f.input);
      const prepared = withCheckpointIntent(f.storage, {
        ...f.input,
        runId: first.runId,
        operationId: `legacy-${decision}`,
        decision,
        userInstruction: "确认继续",
        expectedProjectRevision: f.storage.inspectProject("p")!.revision,
      });
      f.storage.resumeRun({
        projectId: "p",
        runId: first.runId,
        operationId: `legacy-resume-${decision}`,
        decision,
        ...(prepared.userInstruction === undefined ? {} : { displayInstruction: prepared.userInstruction }),
      });
      const checkpoint = pendingStageCheckpoint(f.storage, "p", first.runId);
      assert.equal(checkpoint === null, decision === "resume");
    } finally {
      f.close();
    }
  });
}
