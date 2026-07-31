import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentBrowserAnchor, CodingGitAction, CodingReviewSummary, CodingTurnPhase, CodingVerificationRecord, FileRef, RuntimeCodingFileChange } from '@lume/shared'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import {
  closeFileTab,
  createThreadFileWorkspace,
  openFileTab,
  type ThreadFileWorkspace,
  type RightPanelFileTab,
} from '@/components/right-panel/right-panel-files-state'
import type { ThreadBrowserWorkspace } from '@/components/right-panel/right-panel-browser-state'
import {
  closeRightPanelTab,
  getOpenRightPanelFunctions,
  openRightPanelTab,
  type RightPanelFunction,
  type ThreadRightPanelWorkspace,
} from '@/components/right-panel/right-panel-state'

export type RightPanelDisplayMode = 'normal' | 'expanded' | 'compact'

export interface RightPanelLayoutState {
  open: boolean
  mode: RightPanelDisplayMode
  width?: number
}

export const rightPanelWorkspacesAtom = atomWithStorage<Record<string, ThreadRightPanelWorkspace>>(
  'right-panel-workspaces',
  {},
)

export const rightPanelLayoutAtom = atomWithStorage<RightPanelLayoutState>(
  'right-panel-layout',
  { open: true, mode: 'normal' },
)

export const rightPanelBlameEnabledAtom = atomWithStorage<boolean>(
  'right-panel-blame-enabled',
  false,
)

export interface RightPanelFileEditorState {
  sourceMode?: boolean
  updatedAt: number
}

export interface RightPanelPersistedFileWorkspace {
  tabs: RightPanelFileTab[]
  activeTabId?: string
}

export const rightPanelFileEditorStatesAtom = atomWithStorage<Record<string, RightPanelFileEditorState>>(
  'right-panel-file-editor-states',
  {},
)

export const rightPanelFileTabsAtom = atomWithStorage<Record<string, RightPanelPersistedFileWorkspace>>(
  'right-panel-file-tabs',
  {},
)

export const rightPanelBrowserWorkspacesAtom = atomWithStorage<Record<string, ThreadBrowserWorkspace>>(
  'right-panel-browser-workspaces',
  {},
)

export interface BrowserPageDraft {
  purpose: 'annotation' | 'tweaks'
  anchor: AgentBrowserAnchor
  originalStyles: Record<string, string>
  body?: string
  proposedStyles?: Record<string, string>
}

export const browserPageDraftsAtom = atomWithStorage<Record<string, BrowserPageDraft>>(
  'browser-page-drafts',
  {},
)

export interface CodingReviewPreferences {
  viewMode: 'unified' | 'split'
  wrapLines: boolean
  omitFullFile: boolean
  richPreview: boolean
  wordDiffs: boolean
  hideWhitespace: boolean
}

export const codingReviewPreferencesAtom = atomWithStorage<CodingReviewPreferences>(
  'coding-review-preferences',
  {
    viewMode: 'unified',
    wrapLines: false,
    omitFullFile: false,
    richPreview: false,
    wordDiffs: true,
    hideWhitespace: false,
  },
)

export const codingReviewScrollPositionsAtom = atomWithStorage<Record<string, number>>(
  'coding-review-scroll-positions',
  {},
)

export interface CodingReviewPanelState {
  active: boolean
  changes: RuntimeCodingFileChange[]
  selectedPath: string
  selectedRootId?: string
  runId?: string
  turnId?: string
  assistantMessageId?: string
  phase?: CodingTurnPhase
  verificationRecords?: CodingVerificationRecord[]
  recommendedVerificationCommands?: string[]
  gitActions?: CodingGitAction[]
  review?: CodingReviewSummary
}

export const codingReviewPanelsAtom = atom<Record<string, CodingReviewPanelState>>({})
export const codingReviewStatusAtom = atom<Record<string, { reviewedPaths: string[]; unseenPaths: string[]; completed: boolean }>>({})

export function codingReviewFileKey(file: Pick<RuntimeCodingFileChange, 'path' | 'rootId'>): string {
  return `${file.rootId ?? ''}:${file.path.replace(/\\/g, '/')}`
}

export const codingReviewStatusActionAtom = atom(null, (get, set, action:
  | { type: 'mark-reviewed'; threadId: string; path: string }
  | { type: 'mark-unreviewed'; threadId: string; path: string }
  | { type: 'reset'; threadId: string; paths: string[] }
) => {
  const current = get(codingReviewStatusAtom)
  const state = current[action.threadId] ?? { reviewedPaths: [], unseenPaths: [], completed: false }
  if (action.type === 'mark-reviewed') {
    const unseenPaths = state.unseenPaths.filter((path) => path !== action.path)
    set(codingReviewStatusAtom, {
      ...current,
      [action.threadId]: {
        ...state,
        reviewedPaths: [...new Set([...state.reviewedPaths, action.path])],
        unseenPaths,
        completed: unseenPaths.length === 0,
      },
    })
    return
  }
  if (action.type === 'mark-unreviewed') {
    set(codingReviewStatusAtom, {
      ...current,
      [action.threadId]: {
        ...state,
        reviewedPaths: state.reviewedPaths.filter((path) => path !== action.path),
        unseenPaths: [...new Set([...state.unseenPaths, action.path])],
        completed: false,
      },
    })
    return
  }
  set(codingReviewStatusAtom, {
    ...current,
    [action.threadId]: {
      reviewedPaths: state.reviewedPaths,
      unseenPaths: [...new Set(action.paths.filter((path) => !state.reviewedPaths.includes(path)))],
      completed: false,
    },
  })
})

export const codingReviewPanelActionAtom = atom(null, (get, set, action:
  | { type: 'open'; threadId: string; changes: RuntimeCodingFileChange[]; selectedPath: string; selectedRootId?: string; runId?: string; turnId?: string; assistantMessageId?: string; phase?: CodingTurnPhase; verificationRecords?: CodingVerificationRecord[]; recommendedVerificationCommands?: string[]; gitActions?: CodingGitAction[]; review?: CodingReviewSummary }
  | { type: 'update'; threadId: string; patch: Partial<Pick<CodingReviewPanelState, 'phase' | 'verificationRecords' | 'recommendedVerificationCommands' | 'gitActions' | 'review'>> }
  | { type: 'activate'; threadId: string }
  | { type: 'deactivate'; threadId: string }
  | { type: 'close'; threadId: string },
) => {
  const current = get(codingReviewPanelsAtom)
  if (action.type === 'close') {
    if (!current[action.threadId]) return
    const next = { ...current }
    delete next[action.threadId]
    set(codingReviewPanelsAtom, next)
    return
  }
  if (action.type === 'activate' || action.type === 'deactivate') {
    const panel = current[action.threadId]
    if (!panel || panel.active === (action.type === 'activate')) return
    set(codingReviewPanelsAtom, {
      ...current,
      [action.threadId]: { ...panel, active: action.type === 'activate' },
    })
    return
  }
  if (action.type === 'update') {
    const panel = current[action.threadId]
    if (!panel) return
    set(codingReviewPanelsAtom, {
      ...current,
      [action.threadId]: { ...panel, ...action.patch },
    })
    return
  }
  set(codingReviewPanelsAtom, {
    ...current,
    [action.threadId]: {
      active: true,
      changes: action.changes,
      selectedPath: action.selectedPath,
      selectedRootId: action.selectedRootId,
      runId: action.runId,
      turnId: action.turnId,
      assistantMessageId: action.assistantMessageId,
      phase: action.phase,
      verificationRecords: action.verificationRecords,
      recommendedVerificationCommands: action.recommendedVerificationCommands,
      gitActions: action.gitActions,
      review: action.review,
    },
  })
  const paths = action.changes.map(codingReviewFileKey)
  set(codingReviewStatusActionAtom, { type: 'reset', threadId: action.threadId, paths })
  set(rightPanelLayoutAtom, (layout) => ({
    ...layout,
    open: true,
    mode: layout.mode === 'compact' ? 'normal' : layout.mode,
  }))
})

export interface RightPanelFileLayoutPreferences {
  treeWidth: number
  treeCollapsed?: boolean
}

export const rightPanelFileLayoutPreferencesAtom = atomWithStorage<RightPanelFileLayoutPreferences>(
  'right-panel-file-layout-preferences',
  { treeWidth: 260 },
)

/** Runtime-only file navigation state. It intentionally never uses atomWithStorage. */
export const rightPanelFileWorkspacesAtom = atom<Record<string, ThreadFileWorkspace>>({})

type RightPanelWorkspaceAction =
  | { type: 'activate-function'; threadId: string; function: RightPanelFunction; binding?: ThreadFileWorkspace['binding'] }
  | { type: 'open-file'; threadId: string; ref: FileRef; binding?: ThreadFileWorkspace['binding']; lineSelection?: ThreadFileLineSelection; navigationRevision?: number }
  | { type: 'reveal-directory'; threadId: string; request: NonNullable<ThreadFileWorkspace['revealRequest']>; binding?: ThreadFileWorkspace['binding'] }
  | { type: 'close-function'; threadId: string; function: RightPanelFunction }
  | { type: 'close-file'; threadId: string; tabId: string }

export const rightPanelWorkspaceActionAtom = atom(null, (get, set, action: RightPanelWorkspaceAction) => {
  const persisted = get(rightPanelWorkspacesAtom)
  const runtime = get(rightPanelFileWorkspacesAtom)
  const persistedWorkspace = persisted[action.threadId] ?? { tabs: {} }
  const runtimeWorkspace = runtime[action.threadId] ?? createThreadFileWorkspace(
    'binding' in action ? action.binding ?? {} : {},
  )

  if (action.type === 'activate-function') {
    set(rightPanelWorkspacesAtom, {
      ...persisted,
      [action.threadId]: openRightPanelTab(persistedWorkspace, action.function),
    })
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: { ...runtimeWorkspace, activeItem: { kind: 'function', type: action.function } },
    })
    return
  }

  if (action.type === 'open-file') {
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: openFileTab(runtimeWorkspace, action.ref, {
        caseInsensitive: typeof navigator !== 'undefined' && /Win/i.test(navigator.platform),
        lineSelection: action.lineSelection,
        navigationRevision: action.navigationRevision,
      }),
    })
    return
  }

  if (action.type === 'reveal-directory') {
    set(rightPanelWorkspacesAtom, {
      ...persisted,
      [action.threadId]: openRightPanelTab(persistedWorkspace, 'files'),
    })
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: { ...runtimeWorkspace, activeItem: { kind: 'function', type: 'files' }, revealRequest: action.request },
    })
    return
  }

  if (action.type === 'close-function') {
    const nextPersisted = closeRightPanelTab(persistedWorkspace, action.function)
    const functionFallback = getOpenRightPanelFunctions(nextPersisted.tabs)
    const activeItem = runtimeWorkspace.activeItem?.kind === 'function'
      && runtimeWorkspace.activeItem.type === action.function
      ? runtimeWorkspace.openTabs.at(-1)
        ? { kind: 'file' as const, tabId: runtimeWorkspace.openTabs.at(-1)!.id }
        : functionFallback[0]
          ? { kind: 'function' as const, type: functionFallback[0] }
          : null
      : runtimeWorkspace.activeItem
    set(rightPanelWorkspacesAtom, { ...persisted, [action.threadId]: nextPersisted })
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: { ...runtimeWorkspace, activeItem },
    })
    return
  }

  const fallbackFunctions = getOpenRightPanelFunctions(persistedWorkspace.tabs)
  set(rightPanelFileWorkspacesAtom, {
    ...runtime,
    [action.threadId]: closeFileTab(runtimeWorkspace, action.tabId, fallbackFunctions),
  })
})
