import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { FileRef, GuardedFileRef } from '@lume/shared'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import {
  closeFileTab,
  createThreadFileWorkspace,
  openFileTab,
  type ThreadFileWorkspace,
} from '@/components/right-panel/right-panel-files-state'
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
  | { type: 'open-file'; threadId: string; ref: FileRef | GuardedFileRef; binding?: ThreadFileWorkspace['binding']; lineSelection?: ThreadFileLineSelection; navigationRevision?: number }
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
