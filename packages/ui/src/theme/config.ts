import type { CSSProperties } from 'react'

import type { ThemeMode } from '../../../client-bridge/src/protocol.ts'

export type ThemeStyle = CSSProperties & Record<`--${string}`, string | number>

export interface WritingAgentThemeConfig {
  readonly id: string
  readonly aliases: Readonly<Record<`--${string}`, string>>
}

export interface WritingAgentLayoutConfig {
  readonly sidebarWidth: number
  readonly rightPanelWidth: number
  readonly sidebarAutoCollapseWidth: number
}

export const THEME_MODE_OPTIONS: readonly { value: ThemeMode; label: string }[] = Object.freeze([
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
])

export const WRITING_AGENT_THEME: WritingAgentThemeConfig = Object.freeze({
  id: 'writing-agent-default',
  aliases: Object.freeze({
    '--dsh-composer-card-max-width': '760px',
    '--dsh-composer-side-clearance': 'clamp(16px, 4vw, 40px)',
    '--dsh-composer-text-max-height': '336px',
    '--dsh-scrollbar-width': '8px',
  }),
})

export const WRITING_AGENT_LAYOUT: WritingAgentLayoutConfig = Object.freeze({
  sidebarWidth: 280,
  rightPanelWidth: 420,
  sidebarAutoCollapseWidth: 1024,
})

export function createThemeStyle(
  theme: WritingAgentThemeConfig,
  contentFontSize: number,
): ThemeStyle {
  return {
    ...theme.aliases,
    '--dsh-content-font-size': `${contentFontSize}px`,
    '--dsh-content-font-delta': `${contentFontSize - 14}px`,
  }
}

export function applyThemeMode(theme: ThemeMode): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = (): void => {
    const dark = theme === 'dark' || (theme === 'system' && media.matches)
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }
  sync()
  if (theme === 'system') media.addEventListener('change', sync)
  return () => {
    if (theme === 'system') media.removeEventListener('change', sync)
  }
}
