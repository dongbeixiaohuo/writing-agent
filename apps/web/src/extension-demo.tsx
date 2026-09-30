import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { createDeterministicMockBridge } from '../../../packages/client-bridge/src/mock-bridge.ts'
import { WritingAgentShell } from '../../../packages/ui/src/index.ts'
import {
  DEFAULT_WRITING_UI_EXTENSIONS,
  createWritingUiRegistry,
} from '../../../packages/writing-ui/src/index.ts'
import {
  DEMO_BRAND,
  DEMO_SIDEBAR_EXTENSION,
  DEMO_THEME,
} from '../../../packages/writing-ui/examples/demo-sidebar-extension.tsx'
import '../../../packages/ui/src/theme/global.css'

const mount = document.getElementById('root')
if (mount === null) throw new Error('ROOT_MOUNT_MISSING')
const root = createRoot(mount)

async function boot(): Promise<void> {
  const bridge = createDeterministicMockBridge()
  const handshake = await bridge.handshake()
  if (!handshake.mock || handshake.persistsUserProjects) {
    bridge.dispose()
    throw new Error('UNSAFE_EXTENSION_DEMO_BRIDGE')
  }

  window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
  root.render(
    <StrictMode>
      <WritingAgentShell
        bridge={bridge}
        extensions={createWritingUiRegistry([
          ...DEFAULT_WRITING_UI_EXTENSIONS,
          DEMO_SIDEBAR_EXTENSION,
        ])}
        brand={DEMO_BRAND}
        themeConfig={DEMO_THEME}
      />
    </StrictMode>,
  )
}

void boot()
