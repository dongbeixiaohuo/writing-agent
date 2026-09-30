export interface ConversationScrollMetrics {
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
}

export const CONVERSATION_FOLLOW_THRESHOLD = 72

/** Follow the newest message, not the potentially tall workspace controls below it. */
export function conversationFollowTarget(metrics: ConversationScrollMetrics, latestMessageTop: number | null, liveMessageBottom?: number): number {
  const bottom = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const target = liveMessageBottom === undefined ? latestMessageTop : Math.max(latestMessageTop ?? 0, liveMessageBottom - metrics.clientHeight)
  return target === null ? bottom : Math.max(0, Math.min(bottom, target))
}

export function isNearConversationBottom(
  metrics: ConversationScrollMetrics,
  threshold = CONVERSATION_FOLLOW_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold
}
