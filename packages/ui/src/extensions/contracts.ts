import type { ReactNode } from 'react'

import type { BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.ts'

export type UiLauncherSlot = 'sidebar.primary' | 'conversation.actions'

export interface UiPanelRenderContext {
  readonly bridge: ClientBridge
  readonly snapshot: BridgeSnapshot
  readonly closePanel: () => void
  readonly initialView?: string
  readonly exportControls?: ReactNode
}

export interface UiRightPanelContribution {
  readonly id: string
  readonly slot: 'right-panel'
  readonly label: string
  readonly order?: number
  readonly render: (context: UiPanelRenderContext) => ReactNode
}

export interface UiPanelLauncherContribution {
  readonly id: string
  readonly slot: UiLauncherSlot
  readonly label: string
  readonly panelId: string
  readonly order?: number
  readonly icon?: ReactNode
}

export type UiContribution = UiRightPanelContribution | UiPanelLauncherContribution

export interface WritingUiExtension {
  readonly id: string
  readonly contributions: readonly UiContribution[]
}

export interface WritingUiRegistry {
  readonly extensionIds: readonly string[]
  listLaunchers(slot: UiLauncherSlot): readonly UiPanelLauncherContribution[]
  getPanel(id: string): UiRightPanelContribution | undefined
  withoutExtension(extensionId: string): WritingUiRegistry
}

export function panelInstanceKey(panelId: string, projectId: string): string {
  return `${panelId}:${projectId}`
}
