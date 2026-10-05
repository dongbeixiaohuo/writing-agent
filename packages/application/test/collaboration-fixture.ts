import type { ModelRequest, ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { isPublicStageOutput } from '../../writing-core/src/public-stage-output.js';

/** Workflow mocks don't perform semantic extraction. The extraction contract
 * itself is covered by fact-context and the claim-first integration test. */
export function factPreparationFixtureEvents(request: ModelRequest): ProviderStreamEvent[] | null {
  if (request.tools?.length !== 1 || request.tools[0]?.name !== 'prepare_fact_check') return null;
  return [{ type: 'tool_call_delta', index: 0, id: `prepare-${request.requestId}`, name: 'prepare_fact_check',
    argumentsDelta: JSON.stringify({ claims: [], noFactualClaimsReason: '此工作流测试使用已授权的个人感受，不模拟事实语义判断。' }) },
    { type: 'completed', finishReason: 'tool_calls' }];
}

/** Public specialists now return prose; structured research/fact fixtures stay tools. */
export function publicStageFixtureEvents(request: ModelRequest, name: string, args: any): ProviderStreamEvent[] | null {
  const state = collaborationState(request);
  return name === 'submit_writing_stage' && isPublicStageOutput(state?.stage) && state.stage === args.stage
    && !request.tools?.some(t => t.name === name)
    ? [{ type: 'text_delta', delta: args.content }, { type: 'completed', finishReason: 'stop' }] : null;
}

export interface CollaborationFixtureState {
  actor: string; stage: string | null; nextStage: string | null; ready: boolean; finished: boolean;
  inputVersionIds: string[]; completedStages: string[];
  unreadArtifactVersionIds: string[];
  materials: { materialId: string }[];
}
export function collaborationState(request: ModelRequest): CollaborationFixtureState | null {
  const message = request.messages.find((item) => item.role === "user")?.content ?? "";
  const raw = message.split("\nCOLLABORATION_STATE=")[1];
  return raw === undefined ? null : JSON.parse(raw) as CollaborationFixtureState;
}
/** Scripted director for deterministic tests only; production always calls its provider. */
export function directorFixtureTurn(request: ModelRequest): ProviderStreamEvent[] | null {
  const state = collaborationState(request);
  if (state === null || state.actor !== "director") return null;
  if (state.finished) return [{ type: "text_delta", delta: "全部阶段和事实门禁已通过。" }, { type: "completed", finishReason: "stop" }];
  const ready = state.ready || request.messages.some((message) => message.role === "tool" && message.name === "assess_writing_readiness" && JSON.parse(message.content).result?.status === "ready");
  if (!ready) return null;
  return [{ type: "tool_call_delta", index: 0, id: `director-${request.requestId}`, name: "director_decide", argumentsDelta: JSON.stringify({ action: state.nextStage === null ? "finish" : "dispatch", stage: state.nextStage, reason: "基于绑定输入与已完成阶段安排下一专家；修订时综合独立意见。", questions: [], inputVersionIds: state.inputVersionIds }) }, { type: "completed", finishReason: "tool_calls" }];
}
