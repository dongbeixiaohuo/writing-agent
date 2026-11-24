import type { ProjectSummary, SessionSummary } from '../../../client-bridge/src/protocol.ts'

const ACTIONABLE_SESSION_STATUSES = new Set<SessionSummary['status']>(['waiting_user', 'interrupted'])

export function conversationDateLabel(updatedAt?: string, now = new Date()): string | null {
  if (!updatedAt) return null
  const updated = new Date(updatedAt)
  if (Number.isNaN(updated.valueOf())) return null
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const daysAgo = (day(now) - day(updated)) / 86_400_000
  if (daysAgo === 0) return '今天'
  if (daysAgo > 0 && daysAgo <= 5) return `${daysAgo}天前`
  return `${updated.getMonth() + 1}月${updated.getDate()}日`
}

export function resumeSessionForProject(
  project: ProjectSummary,
  sessions: readonly SessionSummary[],
  selectedSessionId: string,
): string | null {
  const ownedSessions = project.sessionIds
    .map(sessionId => sessions.find(session => session.id === sessionId && session.projectId === project.id))
    .filter((session): session is SessionSummary => session !== undefined)

  const active = ownedSessions.findLast(session => session.status === 'running')
  if (active) return active.id
  if (ownedSessions.some(session => session.id === selectedSessionId)) return selectedSessionId

  const actionable = ownedSessions.findLast(session => ACTIONABLE_SESSION_STATUSES.has(session.status))
  return actionable?.id ?? ownedSessions.at(-1)?.id ?? null
}

export type ProjectNavigationTarget =
  | { readonly kind: 'session'; readonly projectId: string; readonly sessionId: string }
  | { readonly kind: 'new_conversation'; readonly projectId: string }

export function projectNavigationTarget(
  project: ProjectSummary,
  sessions: readonly SessionSummary[],
  selectedSessionId: string,
): ProjectNavigationTarget {
  const sessionId = resumeSessionForProject(project, sessions, selectedSessionId)
  return sessionId === null
    ? { kind: 'new_conversation', projectId: project.id }
    : { kind: 'session', projectId: project.id, sessionId }
}
