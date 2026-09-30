import type { ProjectSummary, SessionSummary } from '../../../client-bridge/src/protocol.ts'

const ACTIONABLE_SESSION_STATUSES = new Set<SessionSummary['status']>([
  'running',
  'waiting_user',
  'interrupted',
])

export function resumeSessionForProject(
  project: ProjectSummary,
  sessions: readonly SessionSummary[],
  selectedSessionId: string,
): string | null {
  const ownedSessions = project.sessionIds
    .map(sessionId => sessions.find(session => session.id === sessionId && session.projectId === project.id))
    .filter((session): session is SessionSummary => session !== undefined)

  if (ownedSessions.some(session => session.id === selectedSessionId)) return selectedSessionId

  const actionable = [...ownedSessions]
    .reverse()
    .find(session => ACTIONABLE_SESSION_STATUSES.has(session.status))
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
