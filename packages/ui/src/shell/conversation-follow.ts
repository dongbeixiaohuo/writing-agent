export interface ConversationScrollMetrics {
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
}

export const CONVERSATION_FOLLOW_THRESHOLD = 72

const NAVIGATION_ROW_HEIGHT = 14
const NAVIGATION_ANCHOR_INSET = 24

/** Keep targets usable rather than squeezing every message into a full-height map. */
export function conversationNavigationCapacity(clientHeight: number): number {
  return Math.max(0, Math.min(16, Math.floor((clientHeight - 32) / NAVIGATION_ROW_HEIGHT)))
}

export function conversationNavigationMarkers(count: number, activeIndex: number, capacity: number): number[] {
  const size = Math.min(count, Math.max(0, Math.floor(capacity)))
  if (size === 0 || activeIndex < 0 || activeIndex >= count) return []
  if (size === 1) return [activeIndex]
  const indices = Array.from({ length: size }, (_, index) => Math.round(index * (count - 1) / (size - 1)))
  if (!indices.includes(activeIndex)) {
    // Preserve both ends when there is room, replacing the nearest sampled tick.
    let nearest = size === 2 ? (activeIndex < count / 2 ? 0 : 1) : 1
    for (let index = 1; index < size - 1; index++) {
      if (Math.abs(indices[index]! - activeIndex) < Math.abs(indices[nearest]! - activeIndex)) nearest = index
    }
    indices[nearest] = activeIndex
  }
  return indices.sort((a, b) => a - b)
}

export function conversationNavigationIndex(metrics: ConversationScrollMetrics, offsets: readonly number[]): number {
  if (offsets.length === 0 || metrics.clientHeight <= 0 || metrics.scrollHeight <= metrics.clientHeight + 1) return -1
  if (metrics.scrollTop >= metrics.scrollHeight - metrics.clientHeight - 1) return offsets.length - 1
  const readingPosition = metrics.scrollTop + NAVIGATION_ANCHOR_INSET + 1
  let activeIndex = 0
  for (let index = 1; index < offsets.length && offsets[index]! <= readingPosition; index++) activeIndex = index
  return activeIndex
}

export function conversationNavigationTarget(metrics: ConversationScrollMetrics, messageTop: number): number {
  return Math.max(0, Math.min(Math.max(0, metrics.scrollHeight - metrics.clientHeight), messageTop - NAVIGATION_ANCHOR_INSET))
}

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
