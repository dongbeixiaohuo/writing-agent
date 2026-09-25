import type { BridgeSnapshot, TimelineItem } from '../../../client-bridge/src/protocol.js';

import { isPublicStageOutput, publicStageOutputLabels } from '../../../writing-core/src/public-stage-output.js';

/** One keyed message from first public delta through the authoritative saved result. */
export function conversationWithPreview(items: readonly TimelineItem[], reply: BridgeSnapshot['liveReply'], activeRunId: string | null): readonly TimelineItem[] {
  if (!reply || reply.runId !== activeRunId) return items;
  const id = reply.id ?? `live:${reply.requestId}`;
  if (items.some(item => item.id === id)) return items;
  const phase = reply.phase ?? 'generating';
  const label = isPublicStageOutput(reply.stage) ? publicStageOutputLabels[reply.stage] : undefined;
  return [...items, { id, kind: 'message', role: 'assistant', streaming: phase, createdAt: '',
    ...(isPublicStageOutput(reply.stage) ? { stage: reply.stage } : {}),
    body: `${label ? `**${label} · ${phase === 'saving' ? '正在保存' : '生成中'}**\n\n` : ''}${reply.text}` }];
}
