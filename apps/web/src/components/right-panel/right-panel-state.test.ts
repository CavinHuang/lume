import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  closeRightPanelTab,
  createDefaultRightPanelTab,
  createEmptyRightPanelWorkspace,
  firstOpenRightPanelTab,
  getAvailableRightPanelFunctions,
  migrateLegacyRightPanelHints,
  openFileInRightPanel,
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

  test('available function list is empty when all functions are open', () => {
    let workspace = createEmptyRightPanelWorkspace()
    for (const type of RIGHT_PANEL_FUNCTION_ORDER) {
      workspace = openRightPanelTab(workspace, type)
    }

    expect(getAvailableRightPanelFunctions(workspace)).toEqual([])
  })

  test('opening a file creates or reuses the files tab and selects the path', () => {
    const workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'README.md')

    expect(workspace.activeTab).toBe('files')
    expect(workspace.tabs.files).toMatchObject({
      type: 'files',
      source: 'thread',
      selectedPath: 'README.md',
    })

    const next = openFileInRightPanel(workspace, 'package.json')
    expect(Object.keys(next.tabs)).toEqual(['files'])
    expect(next.tabs.files).toMatchObject({ selectedPath: 'package.json' })
  })

  test('opening a file preserves files-tab view settings', () => {
    let workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'README.md')
    workspace = {
      ...workspace,
      tabs: {
        files: {
          type: 'files',
          source: 'thread',
          selectedPath: 'README.md',
          treeVisible: false,
          searchQuery: 'src',
          enhancedView: false,
        },
      },
    }

    const next = openFileInRightPanel(workspace, 'package.json')

    expect(next.tabs.files).toMatchObject({
      source: 'thread',
      selectedPath: 'package.json',
      treeVisible: false,
      searchQuery: 'src',
      enhancedView: false,
    })
  })

  test('opening a memory file uses the files tab memory source', () => {
    const workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'memories/profile.md', 'memory')

    expect(workspace.activeTab).toBe('files')
    expect(workspace.tabs.files).toMatchObject({
      type: 'files',
      source: 'memory',
      selectedPath: 'memories/profile.md',
    })
  })

  test('sanitize defaults missing files source to thread', () => {
    const workspace = sanitizeRightPanelWorkspace({
      activeTab: 'files',
      tabs: {
        files: {
          type: 'files',
          selectedPath: 'README.md',
          treeVisible: true,
          searchQuery: '',
          enhancedView: true,
        },
      },
    })

    expect(workspace.tabs.files).toMatchObject({ source: 'thread' })
  })
})
