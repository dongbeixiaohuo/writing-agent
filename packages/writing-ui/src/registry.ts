import { createElement, lazy } from 'react'

import type {
  UiContribution,
  UiLauncherSlot,
  UiPanelLauncherContribution,
  UiRightPanelContribution,
  WritingUiExtension,
  WritingUiRegistry,
} from '../../ui/src/extensions/contracts.ts'
import { DocumentIcon } from '../../ui/src/shell/Icons.tsx'

const WritingWorkbenchPanel = lazy(async () => {
  const module = await import('./WritingWorkbenchPanel.tsx')
  return { default: module.WritingWorkbenchPanel }
})

const WORKBENCH_EXTENSION: WritingUiExtension = Object.freeze({
  id: 'writing.workbench',
  contributions: Object.freeze([
    {
      id: 'writing.workbench.panel',
      slot: 'right-panel',
      label: '稿件与版本',
      order: 100,
      render: context => createElement(WritingWorkbenchPanel, context),
    },
    {
      id: 'writing.workbench.header-launcher',
      slot: 'conversation.actions',
      label: '稿件与版本',
      panelId: 'writing.workbench.panel',
      order: 100,
      icon: createElement(DocumentIcon),
    },
  ] satisfies readonly UiContribution[]),
})

export const DEFAULT_WRITING_UI_EXTENSIONS: readonly WritingUiExtension[] = Object.freeze([
  WORKBENCH_EXTENSION,
])

function compareContribution(
  left: UiPanelLauncherContribution,
  right: UiPanelLauncherContribution,
): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)
}

export function createWritingUiRegistry(
  extensions: readonly WritingUiExtension[],
): WritingUiRegistry {
  const extensionIds = new Set<string>()
  const contributionIds = new Set<string>()
  const panels = new Map<string, UiRightPanelContribution>()
  const launchers = new Map<UiLauncherSlot, UiPanelLauncherContribution[]>([
    ['sidebar.primary', []],
    ['conversation.actions', []],
  ])

  for (const extension of extensions) {
    if (extensionIds.has(extension.id)) throw new Error(`UI_EXTENSION_ID_DUPLICATE:${extension.id}`)
    extensionIds.add(extension.id)
    for (const contribution of extension.contributions) {
      if (contributionIds.has(contribution.id)) {
        throw new Error(`UI_CONTRIBUTION_ID_DUPLICATE:${contribution.id}`)
      }
      contributionIds.add(contribution.id)
      if (contribution.slot === 'right-panel') panels.set(contribution.id, contribution)
      else launchers.get(contribution.slot)?.push(contribution)
    }
  }

  for (const items of launchers.values()) {
    items.sort(compareContribution)
    for (const launcher of items) {
      if (!panels.has(launcher.panelId)) {
        throw new Error(`UI_PANEL_REFERENCE_MISSING:${launcher.panelId}`)
      }
    }
  }

  const frozenExtensions = Object.freeze([...extensions])
  return Object.freeze({
    extensionIds: Object.freeze([...extensionIds]),
    listLaunchers(slot: UiLauncherSlot) {
      return Object.freeze([...(launchers.get(slot) ?? [])])
    },
    getPanel(id: string) {
      return panels.get(id)
    },
    withoutExtension(extensionId: string) {
      return createWritingUiRegistry(frozenExtensions.filter(extension => extension.id !== extensionId))
    },
  })
}

export function createDefaultWritingUiRegistry(): WritingUiRegistry {
  return createWritingUiRegistry(DEFAULT_WRITING_UI_EXTENSIONS)
}
