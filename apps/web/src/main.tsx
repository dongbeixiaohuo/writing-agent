import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { UI_BRIDGE_PROTOCOL_VERSION } from '../../../packages/client-bridge/src/protocol.ts'
import { WritingAgentShell } from '../../../packages/ui/src/index.ts'
import { createDefaultWritingUiRegistry } from '../../../packages/writing-ui/src/index.ts'
import '../../../packages/ui/src/theme/global.css'

const mount = document.getElementById('root')
if (mount === null) throw new Error('ROOT_MOUNT_MISSING')

const root = createRoot(mount)

function renderUnavailable(detail: string): void {
  root.render(
    <main style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', padding: 32 }}>
      <section style={{ maxWidth: 560, padding: 28, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 18, background: 'var(--dsw-specific-popover)' }}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>客户端桥接尚未接入</h1>
        <p style={{ lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }}>{detail}</p>
        <p style={{ marginBottom: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>生产构建不会自动启用 Mock，也不会连接 DeepSeek Harness 服务。</p>
      </section>
    </main>,
  )
}

async function boot(): Promise<void> {
  const mock = import.meta.env.MODE === 'mock'
  const desktop = window.writingAgentDesktop
  const bridge = mock
    ? (await import('../../../packages/client-bridge/src/mock-bridge.ts')).createDeterministicMockBridge()
    : desktop !== undefined
      ? (await import('../../../packages/client-bridge/src/desktop-bridge.ts')).createDesktopClientBridge(desktop)
    : await (async () => {
        const capabilityMeta = document.querySelector<HTMLMetaElement>(
          'meta[name="writing-agent-bootstrap-capability"]',
        )
        const bootstrapCapability = capabilityMeta?.content ?? ''
        if (bootstrapCapability.length === 0) {
          throw new Error('LOCAL_HOST_BOOTSTRAP_MISSING')
        }
        capabilityMeta?.remove()
        const { createWebClientBridge } = await import('../../../packages/client-bridge/src/web-bridge.ts')
        return createWebClientBridge({
          baseUrl: window.location.origin,
          bootstrapCapability,
        })
      })()
  const handshake = await bridge.handshake()
  const unsafeMock = mock && (!handshake.mock || handshake.persistsUserProjects)
  const unsafeApplication = !mock && (handshake.mock || !handshake.persistsUserProjects)
  if (unsafeMock || unsafeApplication || handshake.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION) {
    bridge.dispose()
    throw new Error('UNSAFE_OR_INCOMPATIBLE_BRIDGE')
  }
  window.addEventListener('pagehide', () => bridge.dispose(), { once: true })
  root.render(
    <StrictMode>
      <WritingAgentShell
        bridge={bridge}
        extensions={createDefaultWritingUiRegistry()}
        {...(desktop === undefined ? {} : { hostConfiguration: desktop })}
      />
    </StrictMode>,
  )
}

void boot().catch(error => {
  console.error(error instanceof Error ? error.name : 'BOOT_FAILED')
  renderUnavailable(
    import.meta.env.MODE === 'mock'
      ? '界面预览初始化失败。请检查本地构建日志。'
      : '无法连接受保护的本地 Writing Agent 服务。请从桌面应用或本地启动器打开此页面；普通静态服务器不会获得项目或模型权限。',
  )
})
