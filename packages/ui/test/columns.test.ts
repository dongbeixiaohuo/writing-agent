import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampWidth,
  computeColumns,
  RIGHTBAR_MIN,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
} from '../src/upstream/layout/columns.ts'
import { deliveryActionState } from '../src/shell/delivery.ts'

test('column solver preserves sidebar and center before allocating the right panel', () => {
  assert.deepEqual(computeColumns(1440, SIDEBAR_DEFAULT, 420), {
    sidebar: 280,
    center: 740,
    rightbar: 420,
  })
})

test('column solver drops the right track when its minimum cannot fit', () => {
  assert.deepEqual(computeColumns(700, 0, 420), {
    sidebar: SIDEBAR_COLLAPSED,
    center: 644,
    rightbar: 0,
  })
})

test('column solver clamps panel preferences to the source contract', () => {
  assert.equal(clampWidth(12, 264, 420), 264)
  assert.equal(clampWidth(999, 264, 420), 420)
  assert.ok(computeColumns(900, 0, 999).rightbar >= RIGHTBAR_MIN)
})

test('delivery actions keep working backup separate from the formal publication gate', () => {
  const base = {
    bodyVersionId: 'body-v1',
    projectRevision: 4,
    gateStatus: 'not_checked' as const,
    formalExportEnabled: false,
    exports: [],
    notice: 'fixture',
  }
  assert.deepEqual(deliveryActionState(base, true), {
    workingCopyEnabled: true,
    publicationEnabled: false,
  })
  assert.deepEqual(
    deliveryActionState({ ...base, gateStatus: 'passed', formalExportEnabled: true }, true),
    { workingCopyEnabled: true, publicationEnabled: true },
  )
  assert.deepEqual(deliveryActionState(base, false), {
    workingCopyEnabled: false,
    publicationEnabled: false,
  })
})
