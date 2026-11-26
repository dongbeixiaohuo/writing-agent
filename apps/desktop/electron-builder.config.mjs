const signed = Boolean(process.env.WRITING_AGENT_UPDATE_SIGNER_SHA256?.trim())

export default {
  appId: 'com.dongbeixiaohuo.writingagent',
  productName: 'Writing Agent',
  copyright: 'Copyright © 2026 Writing Agent contributors',
  publish: {
    provider: 'generic',
    url: 'https://github.com/dongbeixiaohuo/writing-agent/releases/download/',
    channel: 'latest',
  },
  detectUpdateChannel: false,
  forceCodeSigning: signed,
  asar: true,
  npmRebuild: false,
  directories: {
    output: '../../../../output/desktop',
  },
  files: ['**/*'],
  win: {
    target: ['nsis'],
    icon: '../../assets/icon.ico',
    signExecutable: signed,
    artifactName: 'Writing-Agent-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    // Keep this stable forever: rc.1 shipped with this deterministic identity.
    // Pinning it prevents a future appId refactor from breaking in-place upgrades.
    guid: 'c03d2689-78a4-57b7-813e-a5d1cf38cbb8',
    include: '../../build/installer.nsh',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Writing Agent',
    uninstallDisplayName: 'Writing Agent',
    deleteAppDataOnUninstall: false,
  },
};
