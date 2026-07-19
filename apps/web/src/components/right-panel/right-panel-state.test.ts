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
  test('persists each function at most once in fixed order', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'browser')

    expect(Object.keys(workspace.tabs)).toEqual(['files', 'browser'])
    expect(RIGHT_PANEL_FUNCTION_ORDER.filter((type) => workspace.tabs[type])).toEqual(['browser', 'files'])
    expect(getAvailableRightPanelFunctions(workspace)).toEqual([])
  })

  test('closing a function only changes persisted function presence', () => {
    let workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'browser')
    workspace = openRightPanelTab(workspace, 'files')

    expect(closeRightPanelTab(workspace, 'files')).toEqual({
      tabs: { browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false } },
    })
  })

  test('files storage state contains no runtime navigation or file tabs', () => {
    expect(createDefaultRightPanelTab('files')).toEqual({ type: 'files' })
    expect(sanitizeRightPanelWorkspace({
      activeTab: 'files',
      tabs: {
        files: {
          type: 'files',
          source: 'thread',
          selectedPath: 'secret.txt',
          searchQuery: 'secret',
          treeVisible: false,
          treeWidth: 500,
          openTabs: [{ path: 'secret.txt' }],
        },
      },
    })).toEqual({ tabs: { files: { type: 'files' } } })
  })

  test('sanitize repairs malformed tabs without restoring persisted active state', () => {
    expect(sanitizeRightPanelWorkspace({
      activeTab: 'browser',
      tabs: {
        files: { type: 'browser' },
        browser: { type: 'browser', zoom: 'nope' },
        review: { type: 'review' },
      },
    })).toEqual({
      tabs: {
        browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false },
      },
    })
  })

  test('legacy Files hint opens only the persisted Files function entry', () => {
    expect(migrateLegacyRightPanelHints({ sidePanelView: 'files', fileTreeOpen: false })).toEqual({
      tabs: { files: { type: 'files' } },
    })
  })

  test('first open function follows fixed function order', () => {
    expect(firstOpenRightPanelTab({
      files: createDefaultRightPanelTab('files'),
      browser: createDefaultRightPanelTab('browser'),
    })).toBe('browser')
  })
})
