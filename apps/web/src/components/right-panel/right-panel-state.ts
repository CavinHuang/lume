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

export function firstOpenRightPanelTab(workspace: ThreadRightPanelWorkspace): RightPanelFunction | null {
  return RIGHT_PANEL_FUNCTION_ORDER.find((type) => workspace.tabs[type]) ?? null
}

export function closeRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  const tabs = { ...workspace.tabs }
  delete tabs[type]

  if (workspace.activeTab !== type) {
    return {
      activeTab: workspace.activeTab && tabs[workspace.activeTab] ? workspace.activeTab : firstOpenRightPanelTab({ activeTab: null, tabs }),
      tabs,
    }
  }

  const closedIndex = RIGHT_PANEL_FUNCTION_ORDER.indexOf(type)
  const nextTabs = RIGHT_PANEL_FUNCTION_ORDER.slice(closedIndex + 1).concat(RIGHT_PANEL_FUNCTION_ORDER.slice(0, closedIndex))
  const activeTab = nextTabs.find((candidate) => tabs[candidate]) ?? null

  return { activeTab, tabs }
}

export function sanitizeRightPanelWorkspace(value: unknown): ThreadRightPanelWorkspace {
  if (!isRecord(value)) {
    return createEmptyRightPanelWorkspace()
  }

  const rawTabs = isRecord(value.tabs) ? value.tabs : {}
  const tabs: ThreadRightPanelWorkspace['tabs'] = {}

  for (const type of RIGHT_PANEL_FUNCTION_ORDER) {
    const tab = rawTabs[type]
    if (isRightPanelTabState(type, tab)) {
      tabs[type] = tab
    }
  }

  const activeTab = isRightPanelFunction(value.activeTab) && tabs[value.activeTab]
    ? value.activeTab
    : firstOpenRightPanelTab({ activeTab: null, tabs })

  return { activeTab, tabs }
}

function isRightPanelFunction(value: unknown): value is RightPanelFunction {
  return typeof value === 'string' && RIGHT_PANEL_FUNCTION_ORDER.includes(value as RightPanelFunction)
}

function isRightPanelTabState(type: RightPanelFunction, value: unknown): value is RightPanelTabState {
  if (!isRecord(value) || value.type !== type) {
    return false
  }

  if (type === 'browser') {
    return (
      typeof value.url === 'string' &&
      typeof value.addressInput === 'string' &&
      typeof value.zoom === 'number' &&
      typeof value.deviceToolbarVisible === 'boolean'
    )
  }

  if (type === 'files') {
    return (
      (value.selectedPath === null || typeof value.selectedPath === 'string') &&
      typeof value.treeVisible === 'boolean' &&
      typeof value.searchQuery === 'string' &&
      typeof value.enhancedView === 'boolean'
    )
  }

  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
