import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  createEmptyRightPanelWorkspace,
  getAvailableRightPanelFunctions,
  openRightPanelTab,
} from './right-panel-state'

describe('right-panel-state', () => {
  test('opens each function at most once and filters opened functions from plus menu', () => {
    let workspace = createEmptyRightPanelWorkspace()

    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'files')

    expect(Object.keys(workspace.tabs)).toEqual(['files'])
    expect(workspace.activeTab).toBe('files')
    expect(getAvailableRightPanelFunctions(workspace)).toEqual(['review', 'terminal', 'browser'])
  })

  test('uses the fixed display order instead of creation order', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'review')
    workspace = openRightPanelTab(workspace, 'browser')

    const openedInDisplayOrder = RIGHT_PANEL_FUNCTION_ORDER.filter((type) => workspace.tabs[type])
    expect(openedInDisplayOrder).toEqual(['review', 'browser', 'files'])
  })
})
