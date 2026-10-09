import { collaborationState, directorFixtureTurn, publicStageFixtureEvents } from '../../../application/test/collaboration-fixture.js';
import type { ModelRequest, ProviderStreamEvent } from '../../../runtime/llm/src/index.js';
import { factPreparationFixtureEvents } from '../../../application/test/collaboration-fixture.js';

/** Provider-boundary fixture; all orchestration, permissions and persistence remain real. */
export function collaborationTurn(request: ModelRequest, content: Readonly<Record<string, string>>): ProviderStreamEvent[] | null {
  const extraction = factPreparationFixtureEvents(request);
  if (extraction) return extraction;
  const state = collaborationState(request);
  if (state === null || state.finished) return null;
  const call = (name: string, args: unknown): ProviderStreamEvent[] => publicStageFixtureEvents(request, name, args) ?? [
    { type: 'tool_call_delta', index: 0, id: `${name}-${request.requestId}`, name, argumentsDelta: JSON.stringify(args) },
    { type: 'completed', finishReason: 'tool_calls' },
  ];
  const director = directorFixtureTurn(request);
  if (director !== null) return director;
  if (state.actor === 'director') {
    const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).result);
    const unread = state.unreadArtifactVersionIds.find(id => !results.some(result => result?.versionId === id));
    if (unread !== undefined) return call('read_artifact_version', { versionId: unread });
    const userMessage = request.messages.find(message => message.role === 'user')?.content ?? '';
    const materials = JSON.parse(userMessage.match(/授权材料目录：(\[[^\n]+\])/u)?.[1] ?? '[]') as Array<{ id: string; contentVersionId: string }>;
    const material = materials.find(item => !state.materials.some(m => m.materialId === item.id) && !results.some(result => result?.materialId === item.id));
    if (material !== undefined) return call('read_material', { materialId: material.id, contentVersionId: material.contentVersionId, offset: 0, maxChars: 20_000 });
    return call('assess_writing_readiness', { status: 'ready', reason: '合成测试材料及绑定上下文充分。', questions: [] });
  }
  if (state.stage === 'fact_check') return call('submit_fact_check', { claims: [], noFactualClaimsReason: '合成测试正文没有外部事实主张。' });
  if (state.stage === null || content[state.stage] === undefined) throw new Error(`Missing fixture for ${state.stage}`);
  return call('submit_writing_stage', { stage: state.stage, content: content[state.stage] });
}
