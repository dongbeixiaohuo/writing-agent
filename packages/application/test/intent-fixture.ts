import { ModelProviderBase, type ModelProvider, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { createConversationIntent, type AuthorIntent } from '../src/conversation-intent.js';
import type { ResumeDraftInput, WritingApplicationStorage } from '../src/index.js';
import { randomUUID } from 'node:crypto';
import { factPreparationFixtureEvents } from './collaboration-fixture.js';

/** Scripted model decisions, not a language parser. Semantic accuracy is checked by the real-model replay. */
const replies: Record<string, [AuthorIntent, number | null]> = {
  'ok了': ['clarify_title_selection', null],
  '记住我的写作偏好：开头不要套话': ['remember_preference', null],
  '以后写东西都别用套话开头，这点帮我一直记着': ['remember_preference', null],
  '之前让你记的写作习惯不用了，忘掉吧': ['forget_preferences', null],
  '好的': ['confirm_direction', null],
  '认同': ['approve_checkpoint', null], '认可；': ['approve_checkpoint', null],
  '我觉得你说的这些都挺对的，往下做吧': ['approve_checkpoint', null],
  '这个方向我挺满意的，就这样开始吧': ['confirm_direction', null],
  '标题已确认，请继续核查当前稿件': ['fact_check', null],
  '正文别动，只重新做一次事实核查': ['fact_check', null],
  '1': ['select_title', 1], '就用第一个吧': ['select_title', 1],
  '我选第二个，正文别动': ['select_title', 2],
  '给我两个标题，我来选': ['generate_titles', null], '给三个不同标题，我来选': ['generate_titles', null],
  '给我一个标题候选': ['generate_titles', null],
  '这不像标题，是正文开场。请重新拟一个简洁、能吸引人的标题，并说明区别；只讨论标题，正文不要改，不要替我选择。': ['generate_titles', null],
  '给这篇文章策划配图，先别生成': ['plan_illustrations', null],
  '确认配图方案，仅保存策划': ['confirm_illustrations', null],
  '这个配图安排我觉得挺好，就保留它吧，不需要生成图片': ['confirm_illustrations', null],
  '请根据当前材料生成一份完整稿件': ['full_writing', null],
};
export function intentFixtureEvents(request: ModelRequest, override?: [AuthorIntent, number | null]): ProviderStreamEvent[] | null {
  if (request.tools?.length !== 1 || request.tools[0]?.name !== 'interpret_author_reply') return null;
  const data = JSON.parse(request.messages.find(m => m.role === 'user')!.content);
  const allowed = (request.tools[0].inputSchema as any).properties.intent.enum as string[];
  const selected = override ?? replies[data.currentUserMessage] ?? [allowed.includes('revise_direction') ? 'revise_direction' : 'discuss', null];
  return [{ type: 'tool_call_delta', index: 0, id: request.requestId, name: 'interpret_author_reply',
    argumentsDelta: JSON.stringify({ intent: selected[0], selectionIndex: selected[1], reason: 'Test fixture supplies the contextual model decision' }) },
  { type: 'completed', finishReason: 'tool_calls' }];
}
export function withIntentFixture(provider: ModelProvider, override?: [AuthorIntent, number | null]): ModelProvider {
  return new class extends ModelProviderBase {
    constructor() { super(provider.id, provider.adapterVersion, provider.capabilities); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const intent = intentFixtureEvents(request, override);
      if (intent) { yield* intent; return; }
      const extraction = factPreparationFixtureEvents(request);
      if (extraction) { yield* extraction; return; }
      for await (const event of provider.stream(request)) if (event.type !== 'tool_call_complete') yield event;
    }
  }();
}

/** Existing workflow unit tests issue explicit typed confirmations; they do not test NLP. */
export function withCheckpointIntent(storage: WritingApplicationStorage, input: ResumeDraftInput): ResumeDraftInput {
  const run = storage.getRun(input.runId)!;
  if (run.stopReason !== 'CO_CREATION_CHECKPOINT') return input;
  input = { ...input, userInstruction: input.userInstruction ?? '继续' };
  const id = randomUUID();
  storage.startRun({ projectId: input.projectId, sessionId: run.sessionId, runId: id, planVersion: 'test-semantic-decision', displayInstruction: input.userInstruction! });
  const intent = createConversationIntent({ storage, projectId: input.projectId, sessionId: run.sessionId, userMessage: input.userInstruction!,
    context: {}, allowedIntents: ['approve_checkpoint', 'revise_checkpoint'] });
  intent.definition.execute({ intent: input.userInstruction === '提纲改成对比结构' ? 'revise_checkpoint' : 'approve_checkpoint',
    sourceQuote: input.userInstruction!, selectionIndex: null, reason: 'Explicit decision fixture for workflow unit test' }, {
    projectId: input.projectId, runId: id, operationId: `${id}:intent`, abortSignal: new AbortController().signal,
    expectedBodyVersionId: storage.inspectProject(input.projectId)!.latestBodyVersionId, permissionGrant: { permissions: ['author:intent'] } as any,
  });
  storage.finishRun({ projectId: input.projectId, runId: id, operationId: `${id}:done`, status: 'completed', stopReason: null });
  return { ...input, intentReceiptId: intent.result()!.artifactVersionId, expectedProjectRevision: storage.inspectProject(input.projectId)!.revision };
}
