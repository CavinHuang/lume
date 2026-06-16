import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  closeRightPanelTab,
  createDefaultRightPanelTab,
  createEmptyRightPanelWorkspace,
  firstOpenRightPanelTab,
  getAvailableRightPanelFunctions,
  migrateLegacyRightPanelHints,
  openRightPanelTab,
  sanitizeRightPanelWorkspace,
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

  test('closing the active tab selects the next tab in fixed order', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'review')
    workspace = openRightPanelTab(workspace, 'browser')
    workspace = openRightPanelTab(workspace, 'files')

    const next = closeRightPanelTab(workspace, 'browser')

    expect(next.activeTab).toBe('files')
    expect(next.tabs.browser).toBeUndefined()
  })

  test('closing an inactive tab preserves the active tab', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'review')
    workspace = openRightPanelTab(workspace, 'files')

    const next = closeRightPanelTab(workspace, 'review')

    expect(next.activeTab).toBe('files')
    expect(next.tabs.review).toBeUndefined()
    expect(firstOpenRightPanelTab(next.tabs)).toBe('files')
  })

  test('sanitize repairs malformed fields and repairs activeTab', () => {
    const workspace = sanitizeRightPanelWorkspace({
      activeTab: 'unknown',
      tabs: {
        files: { type: 'browser', url: 'bad' },
        browser: { type: 'browser', zoom: 'nope' },
        review: { type: 'review' },
      },
    })

    expect(workspace.activeTab).toBe('review')
    expect(workspace.tabs.files).toBeUndefined()
    expect(workspace.tabs.browser).toMatchObject({ type: 'browser', url: '', zoom: 1 })
    expect(workspace.tabs.review).toEqual({ type: 'review' })
  })

  test('closing a tab makes it available and closing the last tab returns to launcher state', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'files')

    const closed = closeRightPanelTab(workspace, 'files')

    expect(closed.activeTab).toBeNull()
    expect(getAvailableRightPanelFunctions(closed)).toContain('files')
  })

  test('firstOpenRightPanelTab follows fixed function order', () => {
    expect(firstOpenRightPanelTab({
      files: createDefaultRightPanelTab('files'),
      browser: createDefaultRightPanelTab('browser'),
    })).toBe('browser')
  })

  test('legacy file side-panel hints can create an initial files tab', () => {
    const workspace = migrateLegacyRightPanelHints({
      sidePanelView: 'files',
      fileTreeOpen: false,
    })

    expect(workspace.activeTab).toBe('files')
    expect(workspace.tabs.files).toMatchObject({ type: 'files', treeVisible: false })
  })
})
