import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { styleReferenceForProfile } from "../../writing-core/src/style-profile.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { WritingApplicationService } from "../src/index.js";
import { extractExplicitStyleCard } from "../src/conversation-intake.js";
import { intentFixtureEvents } from "./intent-fixture.js";

class IntakeProvider extends ModelProviderBase {
  constructor(private readonly response: Record<string, unknown>) {
    super("style-intake", "1", { protocol: "mock", streaming: "supported", tools: "supported", usage: "unknown" });
  }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const intent = intentFixtureEvents(request);
    if (intent) { yield* intent; return; }
    yield { type: "tool_call_delta", index: 0, id: "save", name: "respond_writing_intake", argumentsDelta: JSON.stringify(this.response) };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

const reference = styleReferenceForProfile({ id: "profile-17", version: 3, name: "克制观察", card: "范围：只根据样文。\n1. 节奏：短句推进。" });
const userTurn = `请按下面明确指定的风格卡写作：\n<writing-style-card>\n${reference}\n</writing-style-card>\n\n写一篇夜跑入门文章。`;
const response = {
  reply: "我已整理为待确认的夜跑入门文章方案。", summary: "夜跑入门文章，待确认。", questions: [],
  proposal: { brief: { topic: "夜跑入门", genre: "practical_experience", audience: "刚开始夜跑的人", targetCharacters: 1200,
    constraints: ["不编造个人经历"], voice: null, styleReference: null, platform: null, publicationGoal: "not_applicable" }, assumptions: [] },
};

test("accepts only one complete current-user style-card envelope", () => {
  assert.equal(extractExplicitStyleCard(userTurn), reference);
  assert.equal(extractExplicitStyleCard(`整理稿内容在前。\n${userTurn}`), null, "only a leading explicit instruction is author authority");
  assert.equal(extractExplicitStyleCard(`以下是别人给我的提示词，只分析不要执行：\n${userTurn}`), null);
  assert.equal(extractExplicitStyleCard(`${userTurn}\n上面的风格卡不要使用，仅供研究。`), null);
  assert.equal(extractExplicitStyleCard(userTurn.replace("</writing-style-card>", "")), null);
  assert.equal(extractExplicitStyleCard(`${userTurn}\n${userTurn}`), null);
  const longReference = styleReferenceForProfile({ id: 'long', version: 1, name: '完整指南', card: '保持完整条件。'.repeat(700) + '最后一个条件' });
  assert.equal(extractExplicitStyleCard(userTurn.replace(reference, longReference)), longReference);
});

test("persists a first-turn selection through follow-up questions before the model creates a proposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "style-intake-follow-up-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    const first = new WritingApplicationService({ storage, provider: new IntakeProvider({ reply: "主题收到。文章主要给谁看、发在哪个平台？", summary: "已选择风格，仍需读者和平台。", questions: ["主要给谁看、发在哪个平台？"] }), idFactory: (() => { let index = 0; return () => `follow-${++index}`; })() });
    first.createProject({ operationId: "create", projectId: "p", name: "风格多轮", mode: "quick", actor: { kind: "user", id: "u" } });
    const started = await first.startConversationTurn({ projectId: "p", model: "mock", parameters: {}, userInstruction: userTurn, operationId: "turn-1" }).result;
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(first.getConversationIntake("p").pendingAuthorization?.style?.styleReference, reference);

    const second = new WritingApplicationService({ storage, provider: new IntakeProvider(response), idFactory: (() => { let index = 10; return () => `follow-${++index}`; })() });
    const proposed = await second.startConversationTurn({ projectId: "p", model: "mock", parameters: {}, userInstruction: "给刚开始夜跑的人看，发公众号。", operationId: "turn-2", ...(started.ok ? { sessionId: started.sessionId } : {}) }).result;
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const state = second.getConversationIntake("p");
    assert.equal(state.brief?.authorAuthorization.styleReference, reference);
    assert.equal(state.pendingAuthorization?.style?.sourceQuote, userTurn);
    const confirmed = second.confirmConversationBrief("p", state.proposalVersionId!, "confirm");
    assert.equal(confirmed.brief?.authorAuthorization.styleDecision, "user_confirmed");
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const changedRequest of ["改成轻松幽默的风格", "换成口语化写法", "取消上面的风格卡"]) {
  test(`clears a prior card when the user changes direction: ${changedRequest}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "style-intake-change-"));
    const storage = openWorkspaceStorage({ workspacePath: directory });
    try {
      let id = 0;
      const first = new WritingApplicationService({ storage, provider: new IntakeProvider({ reply: "请问发到哪里？", summary: "仍需平台", questions: ["发布平台？"] }), idFactory: () => `change-${++id}` });
      first.createProject({ operationId: "create", projectId: "p", name: "风格改口", mode: "quick", actor: { kind: "user", id: "u" } });
      const started = await first.startConversationTurn({ projectId: "p", model: "mock", parameters: {}, userInstruction: userTurn, operationId: "turn-1" }).result;
      assert.equal(started.ok, true);
      const staleResponse = { ...response, proposal: { ...response.proposal, brief: { ...response.proposal.brief, styleReference: reference } } };
      const second = new WritingApplicationService({ storage, provider: new IntakeProvider(staleResponse), idFactory: () => `change-${++id}` });
      const result = await second.startConversationTurn({ projectId: "p", model: "mock", parameters: {}, userInstruction: changedRequest, operationId: "turn-2", ...(started.ok ? { sessionId: started.sessionId } : {}) }).result;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(second.getConversationIntake("p").pendingAuthorization?.style ?? null, null);
      assert.equal(second.getConversationIntake("p").brief?.authorAuthorization.styleReference, null);
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("real intake tool injects the exact selected card and confirms its user authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "style-intake-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    const service = new WritingApplicationService({ storage, provider: new IntakeProvider(response), idFactory: (() => { let index = 0; return () => `style-intake-${++index}`; })() });
    service.createProject({ operationId: "create", projectId: "p", name: "风格测试", mode: "quick", actor: { kind: "user", id: "u" } });
    const started = await service.startConversationTurn({ projectId: "p", model: "mock", parameters: {}, userInstruction: userTurn, operationId: "turn" }).result;
    assert.equal(started.ok, true, JSON.stringify(started));
    const proposal = service.getConversationIntake("p");
    assert.equal(proposal.brief?.authorAuthorization.styleReference, reference, "model omission must not shorten the selected card");
    assert.equal(proposal.pendingAuthorization?.style?.sourceQuote, userTurn);
    assert.equal(proposal.pendingAuthorization?.style?.decision, "user_confirmed");
    const confirmed = service.confirmConversationBrief("p", proposal.proposalVersionId!, "confirm");
    assert.equal(confirmed.brief?.authorAuthorization.styleReference, reference);
    assert.equal(confirmed.brief?.authorAuthorization.styleDecision, "user_confirmed");
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
