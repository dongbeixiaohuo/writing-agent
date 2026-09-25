export { WritingAgentShell, type WritingAgentShellProps } from './shell/WritingAgentShell.tsx'
export { WRITING_AGENT_BRAND, createBrandConfig, type WritingAgentBrand } from './brand/config.ts'
export {
  WRITING_AGENT_LAYOUT,
  WRITING_AGENT_THEME,
  createThemeStyle,
  type WritingAgentLayoutConfig,
  type WritingAgentThemeConfig,
} from './theme/config.ts'
export type {
  UiContribution,
  UiLauncherSlot,
  UiPanelLauncherContribution,
  UiPanelRenderContext,
  UiRightPanelContribution,
  WritingUiExtension,
  WritingUiRegistry,
} from './extensions/contracts.ts'
