export type RightPanelFunction = 'review' | 'terminal' | 'browser' | 'files'

export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['review', 'terminal', 'browser', 'files']

export interface ThreadRightPanelWorkspace {
  activeTab: RightPanelFunction | null
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>
}

export type RightPanelTabState =
  | { type: 'review' }
  | { type: 'terminal' }
  | BrowserTabState
  | FilesTabState

export interface BrowserTabState {
  type: 'browser'
  url: string
  addressInput: string
  zoom: number
  deviceToolbarVisible: boolean
}

export interface FilesTabState {
  type: 'files'
  selectedPath: string | null
  treeVisible: boolean
  searchQuery: string
  enhancedView: boolean
}

export function createEmptyRightPanelWorkspace(): ThreadRightPanelWorkspace {
  return { activeTab: null, tabs: {} }
}

export function createDefaultRightPanelTab(type: RightPanelFunction): RightPanelTabState {
  if (type === 'browser') {
    return { type, url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }
  }

  if (type === 'files') {
    return { type, selectedPath: null, treeVisible: true, searchQuery: '', enhancedView: true }
  }

  return { type }
}

export function openRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  return {
    activeTab: type,
    tabs: {
      ...workspace.tabs,
      [type]: workspace.tabs[type] ?? createDefaultRightPanelTab(type),
    },
  }
}

export function getAvailableRightPanelFunctions(workspace: ThreadRightPanelWorkspace): RightPanelFunction[] {
  return RIGHT_PANEL_FUNCTION_ORDER.filter((type) => !workspace.tabs[type])
}
