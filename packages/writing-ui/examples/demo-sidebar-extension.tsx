import type {
  UiContribution,
  WritingUiExtension,
} from '../../ui/src/extensions/contracts.ts'
import { createBrandConfig } from '../../ui/src/brand/config.ts'
import type { WritingAgentThemeConfig } from '../../ui/src/theme/config.ts'
import { CloseIcon, DocumentIcon } from '../../ui/src/shell/Icons.tsx'
import shellCss from '../../ui/src/shell/WritingAgentShell.module.css'

export const DEMO_BRAND = createBrandConfig({
  productName: 'Editorial Desk Demo',
  assistantName: 'Demo Editor',
  aboutTitle: '关于 Editorial Desk Demo',
})

export const DEMO_THEME: WritingAgentThemeConfig = Object.freeze({
  id: 'editorial-paper-demo',
  aliases: Object.freeze({
    '--dsw-alias-state-business-primary': '#8b4b32',
    '--dsh-composer-card-max-width': '720px',
    '--dsh-composer-side-clearance': 'clamp(18px, 5vw, 48px)',
    '--dsh-composer-text-max-height': '336px',
    '--dsh-scrollbar-width': '8px',
  }),
})

export const DEMO_SIDEBAR_EXTENSION: WritingUiExtension = Object.freeze({
  id: 'example.editorial-notes',
  contributions: Object.freeze([
    {
      id: 'example.editorial-notes.panel',
      slot: 'right-panel',
      label: '编辑备注演示',
      order: 900,
      render: ({ snapshot, closePanel }) => (
        <section className={shellCss.rightPanel} data-wa-demo-panel>
          <header className={shellCss.rightHeader} data-wa-demo-header>
            <DocumentIcon />
            <span className={shellCss.rightTitle}>编辑备注演示</span>
            <span className={shellCss.readonlyBadge}>隔离示例</span>
            <button
              className={shellCss.miniButton}
              type="button"
              aria-label="关闭演示面板"
              onClick={closePanel}
            >
              <CloseIcon />
            </button>
          </header>
          <div className={shellCss.rightMeta}>sidebar.primary → right-panel</div>
          <div className={shellCss.documentBody}>
            <h2>静态 Slot 示例</h2>
            <p>当前项目：<code>{snapshot.selectedProjectId || '未选择'}</code></p>
            <p>此面板只读取 Client Bridge 投影，不属于 1.0 正式功能。</p>
          </div>
        </section>
      ),
    },
    {
      id: 'example.editorial-notes.sidebar-launcher',
      slot: 'sidebar.primary',
      label: '编辑备注演示',
      panelId: 'example.editorial-notes.panel',
      order: 900,
    },
  ] satisfies readonly UiContribution[]),
})
