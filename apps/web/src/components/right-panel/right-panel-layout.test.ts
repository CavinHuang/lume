import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_MIN_WIDTH,
  clampRightPanelWidth,
  getRightPanelDragWidth,
  getRightPanelMaxWidth,
} from './right-panel-layout'

describe('right-panel-layout', () => {
  test('limits draggable width to min width and 70vw capped at 900px', () => {
    expect(getRightPanelMaxWidth(1600)).toBe(900)
    expect(getRightPanelMaxWidth(1000)).toBe(700)
    expect(clampRightPanelWidth(240, 1200)).toBe(RIGHT_PANEL_MIN_WIDTH)
    expect(clampRightPanelWidth(920, 1200)).toBe(840)
  })

  test('calculates right anchored drag width from pointer x', () => {
    expect(getRightPanelDragWidth({ clientX: 820, viewportWidth: 1280 })).toBe(460)
    expect(getRightPanelDragWidth({ clientX: 80, viewportWidth: 1280 })).toBe(896)
    expect(getRightPanelDragWidth({ clientX: 1240, viewportWidth: 1280 })).toBe(RIGHT_PANEL_MIN_WIDTH)
  })
})
