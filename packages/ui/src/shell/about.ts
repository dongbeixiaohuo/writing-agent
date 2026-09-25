import type { BridgeHandshake } from '../../../client-bridge/src/protocol.ts'

export interface AboutVersionView {
  readonly version: string
  readonly releaseLabel: string
  readonly releaseExplanation: string
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
    releaseLabel: releaseCandidate ? '测试候选版' : preRelease ? '内部测试版' : '正式版',
    releaseExplanation: releaseCandidate
      ? '用于桌面体验测试，尚未完成最终用户签收，不是正式发布版。'
      : preRelease
        ? '用于开发与测试，不是正式发布版。'
        : '当前安装的是正式发布版本。',
    buildLabel: `桌面版 ${desktopVersion}`,
    runtimeLabel: handshake.runtimeBuild,
    protocolLabel: `v${String(handshake.protocolVersion)}`,
  }
}
