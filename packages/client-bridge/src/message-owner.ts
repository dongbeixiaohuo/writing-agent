import type { BridgeSnapshot, MessageOwner } from './protocol.js'
export function messageOwner(snapshot: BridgeSnapshot): MessageOwner {
  return { workspaceId: snapshot.workspaceId, projectId: snapshot.selectedProjectId, sessionId: snapshot.selectedSessionId }
}
export function assertMessageOwner(snapshot: BridgeSnapshot, owner: MessageOwner): void {
  if (!owner || owner.workspaceId !== snapshot.workspaceId || owner.projectId !== snapshot.selectedProjectId || owner.sessionId !== snapshot.selectedSessionId)
    throw Object.assign(new Error('草稿所属项目或会话已变化，请返回原项目后发送。'), { code: 'DRAFT_OWNER_CHANGED' })
}
