import { atom, type Getter } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { CodingGitAction, CodingReviewSummary, CodingTurnPhase, CodingVerificationRecord, FileRef, RuntimeCodingFileChange } from '@lume/shared'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import {
  closeFileTab,
  createThreadFileWorkspace,
  openFileTab,
  type ThreadFileWorkspace,
  type RightPanelActiveItem,
  type RightPanelFileTab,
} from '@/components/right-panel/right-panel-files-state'
import { activeTabIdAtom, tabsAtom } from './tab-atoms'
import { agentThreadsAtom } from './agent-atoms'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from './workspace-atoms'
import {
  findRightPanelTab,
  getOpenRightPanelFunctions,
  resolveRightPanelWorkspaceKey,
  type RightPanelFunction,
  type RightPanelWorkspaceState,
} from '@/components/right-panel/right-panel-state'
import {
  handleCloseAllTabs,
  handleCloseOtherTabs,
  handleCloseTab,
  handleOpenTab,
  handleReopenClosedTab,
  handleReorderTabs,
  handleToggleCollapse,
  readRightPanelWorkspaceState,
} from '@/components/right-panel/right-panel-workspace-store'

export type RightPanelDisplayMode = 'normal' | 'expanded' | 'compact'

export interface RightPanelLayoutState {
  open: boolean
  mode: RightPanelDisplayMode
  width?: number
}

const DEFAULT_RIGHT_PANEL_LAYOUT: RightPanelLayoutState = { open: false, mode: 'normal' }

type RightPanelLayoutUpdate = RightPanelLayoutState | ((current: RightPanelLayoutState) => RightPanelLayoutState)

export const rightPanelLayoutsAtom = atomWithStorage<Record<string, RightPanelLayoutState>>(
  'right-panel-layouts',
  {},
)

export const rightPanelLayoutAtom = atom(
  (get) => {
    const activeTabId = get(activeTabIdAtom)
    const threadId = get(tabsAtom).find((tab) => tab.id === activeTabId && tab.type === 'agent')?.threadId
    return threadId ? get(rightPanelLayoutsAtom)[threadId] ?? DEFAULT_RIGHT_PANEL_LAYOUT : DEFAULT_RIGHT_PANEL_LAYOUT
  },
  (get, set, update: RightPanelLayoutUpdate) => {
    const activeTabId = get(activeTabIdAtom)
    const threadId = get(tabsAtom).find((tab) => tab.id === activeTabId && tab.type === 'agent')?.threadId
    if (!threadId) return
    const layouts = get(rightPanelLayoutsAtom)
    const current = layouts[threadId] ?? DEFAULT_RIGHT_PANEL_LAYOUT
    const next = typeof update === 'function' ? update(current) : update
    set(rightPanelLayoutsAtom, { ...layouts, [threadId]: next })
  },
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
  /** 窄面板（<680）树/预览二态：true=预览占满，false/缺省=树占满 */
  narrowShowsPreview?: boolean
}

export const rightPanelFileLayoutPreferencesAtom = atomWithStorage<RightPanelFileLayoutPreferences>(
  'right-panel-file-layout-preferences',
  { treeWidth: 260 },
)

/** Runtime-only file navigation state. It intentionally never uses atomWithStorage. */
export const rightPanelFileWorkspacesAtom = atom<Record<string, ThreadFileWorkspace>>({})

/**
 * 每个 thread 对应的右侧 side-chat 会话 id（threadId → sideChatThreadId）。
 * 划线引用「打开右侧问答」复用或新建 side-chat 会话并挂在右栏（见 #18）。
 */
export const agentSideChatMapAtom = atomWithStorage<Record<string, string>>(
  'agent-side-chat-map',
  {},
)

type RightPanelWorkspaceAction =
  | { type: 'activate-function'; threadId: string; function: RightPanelFunction; binding?: ThreadFileWorkspace['binding'] }
  | { type: 'activate-tab'; threadId: string; tabId: string }
  | { type: 'activate-side-chat'; threadId: string }
  | { type: 'open-file'; threadId: string; ref: FileRef; binding?: ThreadFileWorkspace['binding']; lineSelection?: ThreadFileLineSelection; navigationRevision?: number }
  | { type: 'reveal-directory'; threadId: string; request: NonNullable<ThreadFileWorkspace['revealRequest']>; binding?: ThreadFileWorkspace['binding'] }
  | { type: 'close-function'; threadId: string; function: RightPanelFunction }
  | { type: 'close-tab'; threadId: string; tabId: string }
  | { type: 'close-other-tabs'; threadId: string; tabId: string }
  | { type: 'close-all-tabs'; threadId: string }
  | { type: 'reorder-tabs'; threadId: string; orderedIds: string[] }
  | { type: 'reopen-closed-tab'; threadId: string; entryId: string }
  | { type: 'toggle-collapse'; threadId: string }
  | { type: 'close-file'; threadId: string; tabId: string }

/**
 * threadId → 工作区身份(与 RightPanelWorkspace/浏览器面板分桶同构:
 * workspaceSlug ?? workspaceId ?? threadId,见 sidecar create-browser-tools.ts)。
 */
function resolveThreadWorkspaceKey(get: Getter, threadId: string): string {
  const thread = get(agentThreadsAtom).find((item) => item.id === threadId)
  const workspaceId = thread?.workspaceId ?? get(currentWorkspaceIdAtom) ?? undefined
  const workspace = get(agentWorkspacesAtom).find((item) => item.id === workspaceId)
  return resolveRightPanelWorkspaceKey({ workspaceSlug: workspace?.slug, workspaceId, threadId })
}

/**
 * 统一 tab 变更后的 runtime activeItem 同步:文件 tab 激活(明确指向具体文件)
 * 优先保留;否则对齐统一层的活动 tab(功能形态),无活动 tab 时清空。
 */
function syncedFunctionActiveItem(
  runtimeWorkspace: ThreadFileWorkspace,
  state: RightPanelWorkspaceState,
): RightPanelActiveItem | null {
  if (runtimeWorkspace.activeItem?.kind === 'file') return runtimeWorkspace.activeItem
  const type = state.tabs.find((tab) => tab.id === state.activeTabId)?.type
  return type ? { kind: 'function', type } : null
}

export const rightPanelWorkspaceActionAtom = atom(null, (get, set, action: RightPanelWorkspaceAction) => {
  const runtime = get(rightPanelFileWorkspacesAtom)
  const runtimeWorkspace = runtime[action.threadId] ?? createThreadFileWorkspace(
    'binding' in action ? action.binding ?? {} : {},
  )
  const setRuntimeActiveItem = (activeItem: RightPanelActiveItem | null) => {
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: { ...runtimeWorkspace, activeItem },
    })
  }
  const syncRuntimeWithUnifiedTabs = () => {
    const state = readRightPanelWorkspaceState(resolveThreadWorkspaceKey(get, action.threadId))
    setRuntimeActiveItem(syncedFunctionActiveItem(runtimeWorkspace, state))
  }
  const workspaceKey = () => resolveThreadWorkspaceKey(get, action.threadId)

  if (action.type === 'activate-function' || action.type === 'activate-tab' || action.type === 'activate-side-chat') {
    const type = action.type === 'activate-function'
      ? action.function
      : action.type === 'activate-side-chat'
        ? 'chat'
        : findRightPanelTab(readRightPanelWorkspaceState(workspaceKey()), action.tabId)?.type
    // 未知 tabId(如重开竞态)只激活既有 tab,不落新类型
    if (type) handleOpenTab(workspaceKey(), type)
    syncRuntimeWithUnifiedTabs()
    return
  }

  if (action.type === 'open-file') {
    // 开文件不改统一 tab 开合:即使 files 功能 tab 被独立关闭,文件子 tab 仍可呈现
    // (守卫语义:agent 开文件不复活用户主动关闭的功能 tab)
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
    handleOpenTab(workspaceKey(), 'files')
    set(rightPanelFileWorkspacesAtom, {
      ...runtime,
      [action.threadId]: { ...runtimeWorkspace, activeItem: { kind: 'function', type: 'files' }, revealRequest: action.request },
    })
    return
  }

  if (action.type === 'close-function' || action.type === 'close-tab') {
    handleCloseTab(workspaceKey(), action.type === 'close-function' ? action.function : action.tabId)
    syncRuntimeWithUnifiedTabs()
    return
  }

  if (action.type === 'close-other-tabs') {
    handleCloseOtherTabs(workspaceKey(), action.tabId)
    syncRuntimeWithUnifiedTabs()
    return
  }

  if (action.type === 'close-all-tabs') {
    handleCloseAllTabs(workspaceKey())
    syncRuntimeWithUnifiedTabs()
    return
  }

  if (action.type === 'reorder-tabs') {
    handleReorderTabs(workspaceKey(), action.orderedIds)
    return
  }

  if (action.type === 'reopen-closed-tab') {
    handleReopenClosedTab(workspaceKey(), action.entryId)
    syncRuntimeWithUnifiedTabs()
    return
  }

  if (action.type === 'toggle-collapse') {
    handleToggleCollapse(workspaceKey())
    return
  }

  // 关文件:runtime 语义(邻位/功能回退),功能回退候选来自统一层当前打开集合
  const fallbackFunctions = getOpenRightPanelFunctions(readRightPanelWorkspaceState(workspaceKey()).tabs)
  set(rightPanelFileWorkspacesAtom, {
    ...runtime,
    [action.threadId]: closeFileTab(runtimeWorkspace, action.tabId, fallbackFunctions),
  })
})
