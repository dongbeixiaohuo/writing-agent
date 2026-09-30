import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createBrandConfig,
  WRITING_AGENT_BRAND,
} from '../src/brand/config.ts'
import {
  createThemeStyle,
  THEME_MODE_OPTIONS,
  WRITING_AGENT_LAYOUT,
  WRITING_AGENT_THEME,
} from '../src/theme/config.ts'

test('brand replacement is centralized without changing the default brand object', () => {
  const replacement = createBrandConfig({
    productName: 'Example Editorial Desk',
    assistantName: 'Example Editor',
  })

  assert.equal(replacement.productName, 'Example Editorial Desk')
  assert.equal(replacement.assistantName, 'Example Editor')
  assert.equal(replacement.shortName, WRITING_AGENT_BRAND.shortName)
  assert.equal(WRITING_AGENT_BRAND.productName, 'Writing Agent')
  assert.throws(() => createBrandConfig({ productName: '   ' }), /BRAND_PRODUCT_NAME_REQUIRED/u)
})

test('theme aliases and layout defaults come from one configuration entry', () => {
  const style = createThemeStyle(WRITING_AGENT_THEME, 16)

  assert.equal(style['--dsh-content-font-size'], '16px')
  assert.equal(style['--dsh-content-font-delta'], '2px')
  assert.equal(style['--dsh-composer-card-max-width'], '760px')
  assert.equal(WRITING_AGENT_LAYOUT.sidebarWidth, 280)
  assert.equal(WRITING_AGENT_LAYOUT.rightPanelWidth, 420)
  assert.deepEqual(THEME_MODE_OPTIONS.map(option => option.value), ['system', 'light', 'dark'])
})
