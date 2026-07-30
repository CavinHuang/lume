import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  closeRightPanelTab,
  createDefaultRightPanelTab,
  createEmptyRightPanelWorkspace,
  firstOpenRightPanelTab,
  getAvailableRightPanelFunctions,
  getRightPanelReviewLaunchTarget,
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

  test('review launcher opens the current changed turn or falls back to the previous turn', () => {
    const previousReport = {
      runId: 'run-1',
      status: 'unverified' as const,
      workspaceChanged: true,
      changedFiles: ['src/previous.ts'],
      fileChanges: [{ path: 'src/previous.ts' }],
      externalChangedFiles: [],
      pendingBackground: false,
    }
    const currentReport = {
      ...previousReport,
      runId: 'run-2',
      changedFiles: ['src/current.ts'],
      fileChanges: [{ path: 'src/current.ts' }],
    }
    const baseEvents = [
      {
        id: 'started-1',
        type: 'run.started' as const,
        threadId: 'thread-1',
        runId: 'run-1',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
      {
        id: 'report-1',
        type: 'coding.report.updated' as const,
        threadId: 'thread-1',
        runId: 'run-1',
        createdAt: '2026-07-30T00:01:00.000Z',
        codingReport: previousReport,
      },
      {
        id: 'started-2',
        type: 'run.started' as const,
        threadId: 'thread-1',
        runId: 'run-2',
        createdAt: '2026-07-30T00:02:00.000Z',
      },
    ]

    expect(getRightPanelReviewLaunchTarget(baseEvents)).toMatchObject({
      recency: 'previous',
      report: { runId: 'run-1' },
      changes: [{ path: 'src/previous.ts' }],
    })
    expect(getRightPanelReviewLaunchTarget([
      ...baseEvents,
      {
        id: 'report-2',
        type: 'coding.report.updated' as const,
        threadId: 'thread-1',
        runId: 'run-2',
        createdAt: '2026-07-30T00:03:00.000Z',
        codingReport: currentReport,
      },
    ])).toMatchObject({
      recency: 'current',
      report: { runId: 'run-2' },
      changes: [{ path: 'src/current.ts' }],
    })
  })
})
