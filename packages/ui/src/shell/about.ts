import type { BridgeHandshake } from '../../../client-bridge/src/protocol.ts'

export const ABOUT_PRODUCT_DESCRIPTION = 'Writing Agent 是一款面向公众号、今日头条等平台创作者的开源桌面写作助手。把想法和素材放进来，先和 AI 聊聊从哪个角度写。你选定方向，它帮你整理素材、写出初稿。哪一段没写到点上，就挑出来接着改。'
export const ABOUT_DATA_DESCRIPTION = '项目、稿件和模型密钥保存在这台电脑上。使用 AI 写作时，参与本次生成的内容会发送到你配置的模型服务。'

export interface AboutVersionView {
  readonly version: string
  readonly releaseLabel: string
  readonly releaseExplanation?: string
  readonly buildLabel: string
  readonly runtimeLabel: string
  readonly protocolLabel: string
}

type AboutHandshake = Pick<BridgeHandshake, 'clientBuild' | 'runtimeBuild' | 'protocolVersion' | 'mock'>

export function aboutVersionView(handshake: AboutHandshake): AboutVersionView {
  if (handshake.mock) {
    return {
      version: '界面演示',
      releaseLabel: '界面演示版',
      releaseExplanation: '仅用于查看界面，不读取或保存真实用户项目。',
      buildLabel: handshake.clientBuild,
      runtimeLabel: handshake.runtimeBuild,
      protocolLabel: `v${String(handshake.protocolVersion)}`,
    }
  }

  const desktopVersion = /^writing-agent-desktop@(.+)$/u.exec(handshake.clientBuild)?.[1]
  if (desktopVersion === undefined) {
    return {
      version: '开发构建',
      releaseLabel: '本地开发版',
      releaseExplanation: '未识别到正式桌面版本号。',
      buildLabel: handshake.clientBuild,
      runtimeLabel: handshake.runtimeBuild,
      protocolLabel: `v${String(handshake.protocolVersion)}`,
    }
  }

  const releaseCandidate = /-rc(?:\.|$)/u.test(desktopVersion)
  const preRelease = desktopVersion.includes('-')
  return {
    version: desktopVersion,
    releaseLabel: releaseCandidate ? '候选版' : preRelease ? '内部测试版' : '正式版',
    buildLabel: `桌面版 ${desktopVersion}`,
    runtimeLabel: handshake.runtimeBuild,
    protocolLabel: `v${String(handshake.protocolVersion)}`,
  }
}
