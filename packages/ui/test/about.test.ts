import assert from 'node:assert/strict'
import test from 'node:test'

import { aboutVersionView } from '../src/shell/about.ts'

test('desktop release candidate is explained in language a user can understand', () => {
  assert.deepEqual(aboutVersionView({
    clientBuild: 'writing-agent-desktop@1.0.0-rc.3',
    runtimeBuild: 'writing-agent-runtime-v1',
    protocolVersion: 16,
    mock: false,
  }), {
    version: '1.0.0-rc.3',
    releaseLabel: '测试候选版',
    releaseExplanation: '用于桌面体验测试，尚未完成最终用户签收，不是正式发布版。',
    buildLabel: '桌面版 1.0.0-rc.3',
    runtimeLabel: 'writing-agent-runtime-v1',
    protocolLabel: 'v16',
  })
})

test('mock and unknown builds never pretend to be a production release', () => {
  assert.equal(aboutVersionView({
    clientBuild: 'wa-ui-baseline-0.1',
    runtimeBuild: 'deterministic-mock',
    protocolVersion: 16,
    mock: true,
  }).releaseLabel, '界面演示版')

  assert.deepEqual(aboutVersionView({
    clientBuild: 'wa-web-v4',
    runtimeBuild: 'writing-runtime-v1',
    protocolVersion: 16,
    mock: false,
  }), {
    version: '开发构建',
    releaseLabel: '本地开发版',
    releaseExplanation: '未识别到正式桌面版本号。',
    buildLabel: 'wa-web-v4',
    runtimeLabel: 'writing-runtime-v1',
    protocolLabel: 'v16',
  })
})
