import type { DeliveryWorkspace } from '../../../client-bridge/src/protocol.ts'

export interface DeliveryActionState {
  workingCopyEnabled: boolean
  publicationEnabled: boolean
}

export function deliveryActionState(
  workspace: DeliveryWorkspace,
  persistsUserProjects: boolean,
): DeliveryActionState {
  const workingCopyEnabled =
    persistsUserProjects && workspace.bodyVersionId !== null
  return {
    workingCopyEnabled,
    publicationEnabled:
      workingCopyEnabled &&
      workspace.formalExportEnabled &&
      workspace.gateStatus === 'passed',
  }
}
