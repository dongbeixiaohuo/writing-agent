import assert from 'node:assert/strict'
import test from 'node:test'

import { panelInstanceKey } from '../../ui/src/extensions/contracts.ts'
import {
  DEFAULT_WRITING_UI_EXTENSIONS,
  createDefaultWritingUiRegistry,
  createWritingUiRegistry,
} from '../src/registry.ts'

test('default registry exposes the writing workbench but excludes examples', () => {
  const registry = createDefaultWritingUiRegistry()

  assert.deepEqual(registry.extensionIds, ['writing.workbench'])
  assert.deepEqual(
    registry.listLaunchers('conversation.actions').map(item => item.panelId),
    ['writing.workbench.panel'],
  )
  assert.equal(registry.getPanel('writing.workbench.panel')?.label, '稿件与版本')
  assert.equal(registry.extensionIds.some(id => id.startsWith('example.')), false)
})

test('mounting and removing an extension creates isolated registry snapshots', () => {
  const example = {
    id: 'example.sidebar',
    contributions: [
      {
        id: 'example.sidebar.panel',
        slot: 'right-panel' as const,
        label: '演示面板',
        render: () => null,
      },
      {
        id: 'example.sidebar.launcher',
        slot: 'sidebar.primary' as const,
        label: '演示入口',
        panelId: 'example.sidebar.panel',
      },
    ],
  }
  const baseline = createDefaultWritingUiRegistry()
  const mounted = createWritingUiRegistry([...DEFAULT_WRITING_UI_EXTENSIONS, example])
  const unmounted = mounted.withoutExtension('example.sidebar')

  assert.equal(baseline.getPanel('example.sidebar.panel'), undefined)
  assert.equal(mounted.getPanel('example.sidebar.panel')?.label, '演示面板')
  assert.deepEqual(mounted.listLaunchers('sidebar.primary').map(item => item.id), ['example.sidebar.launcher'])
  assert.deepEqual(unmounted.extensionIds, baseline.extensionIds)
  assert.equal(unmounted.getPanel('example.sidebar.panel'), undefined)
  assert.equal(mounted.getPanel('example.sidebar.panel')?.label, '演示面板')
})

test('registry rejects duplicate IDs and launchers without a panel', () => {
  assert.throws(
    () => createWritingUiRegistry([...DEFAULT_WRITING_UI_EXTENSIONS, ...DEFAULT_WRITING_UI_EXTENSIONS]),
    /UI_EXTENSION_ID_DUPLICATE/u,
  )
  assert.throws(
    () => createWritingUiRegistry([{
      id: 'broken.extension',
      contributions: [{
        id: 'broken.launcher',
        slot: 'sidebar.primary',
        label: '无面板入口',
        panelId: 'missing.panel',
      }],
    }]),
    /UI_PANEL_REFERENCE_MISSING/u,
  )
})

test('panel instance keys are project scoped to discard cross-project local state', () => {
  assert.equal(panelInstanceKey('writing.workbench.panel', 'project-a'), 'writing.workbench.panel:project-a')
  assert.notEqual(
    panelInstanceKey('writing.workbench.panel', 'project-a'),
    panelInstanceKey('writing.workbench.panel', 'project-b'),
  )
})
