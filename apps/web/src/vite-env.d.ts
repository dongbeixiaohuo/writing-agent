/// <reference types="vite/client" />

import type { DesktopHostApi } from '../../../packages/client-bridge/src/desktop-bridge.ts'

declare global {
  interface Window {
    writingAgentDesktop?: DesktopHostApi
  }
}

export {}
