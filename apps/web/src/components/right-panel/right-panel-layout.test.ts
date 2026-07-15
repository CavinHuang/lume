import { describe, expect, test } from 'bun:test'
import {
  FILE_TREE_MIN_WIDTH,
  FILE_WORKSPACE_WIDE_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampRightPanelWidth,
  clampRightPanelFileTreeWidth,
  getRightPanelFileTreeDragWidth,
  getRightPanelFileTreeMaxWidth,
  getRightPanelDragWidth,
  getRightPanelMaxWidth,
  isWideFileWorkspace,
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

  test('switches layout at the exact 680px container boundary', () => {
    expect(FILE_WORKSPACE_WIDE_MIN_WIDTH).toBe(680)
    expect(isWideFileWorkspace(679)).toBe(false)
    expect(isWideFileWorkspace(680)).toBe(true)
  })

  test('limits file tree width to 220-360px and preserves preview space', () => {
    expect(getRightPanelFileTreeMaxWidth(1200)).toBe(360)
    expect(getRightPanelFileTreeMaxWidth(680)).toBe(360)
    expect(clampRightPanelFileTreeWidth(180, 1000)).toBe(FILE_TREE_MIN_WIDTH)
    expect(clampRightPanelFileTreeWidth(560, 1000)).toBe(360)
  })

  test('calculates file tree width from its left resize handle', () => {
    expect(getRightPanelFileTreeDragWidth({ clientX: 780, containerRight: 1120, containerWidth: 900 })).toBe(340)
    expect(getRightPanelFileTreeDragWidth({ clientX: 240, containerRight: 1120, containerWidth: 900 })).toBe(360)
    expect(getRightPanelFileTreeDragWidth({ clientX: 1040, containerRight: 1120, containerWidth: 900 })).toBe(FILE_TREE_MIN_WIDTH)
  })
})
