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
  source: 'thread' | 'workspace' | 'memory'
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
    return { type, source: 'thread', selectedPath: null, treeVisible: true, searchQuery: '', enhancedView: true }
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

export function firstOpenRightPanelTab(
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>,
): RightPanelFunction | null {
  return RIGHT_PANEL_FUNCTION_ORDER.find((type) => tabs[type]) ?? null
}

export function closeRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  const tabs = { ...workspace.tabs }
  delete tabs[type]

  if (workspace.activeTab !== type) {
    return {
      activeTab: workspace.activeTab && tabs[workspace.activeTab] ? workspace.activeTab : firstOpenRightPanelTab(tabs),
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
    const tab = sanitizeRightPanelTab(type, rawTabs[type])
    if (tab) {
      tabs[type] = tab
    }
  }

  const activeTab = isRightPanelFunction(value.activeTab) && tabs[value.activeTab]
    ? value.activeTab
    : firstOpenRightPanelTab(tabs)

  return { activeTab, tabs }
}

export function openFileInRightPanel(
  workspace: ThreadRightPanelWorkspace,
  path: string,
  source: 'thread' | 'memory' = 'thread',
): ThreadRightPanelWorkspace {
  const nextWorkspace = openRightPanelTab(workspace, 'files')
  const files = nextWorkspace.tabs.files
  if (!files || files.type !== 'files') {
    return nextWorkspace
  }

  return {
    activeTab: 'files',
    tabs: {
      ...nextWorkspace.tabs,
      files: {
        ...files,
        source,
        selectedPath: path,
      },
    },
  }
}

export function migrateLegacyRightPanelHints(input: {
  sidePanelView?: unknown
  fileTreeOpen?: unknown
}): ThreadRightPanelWorkspace {
  if (input.sidePanelView !== 'files') {
    return createEmptyRightPanelWorkspace()
  }

  const workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
  const files = workspace.tabs.files
  if (!files || files.type !== 'files') {
    return workspace
  }

  return {
    activeTab: 'files',
    tabs: {
      files: {
        ...files,
        treeVisible: typeof input.fileTreeOpen === 'boolean' ? input.fileTreeOpen : files.treeVisible,
      },
    },
  }
}

function isRightPanelFunction(value: unknown): value is RightPanelFunction {
  return typeof value === 'string' && RIGHT_PANEL_FUNCTION_ORDER.includes(value as RightPanelFunction)
}

function sanitizeRightPanelTab(type: RightPanelFunction, value: unknown): RightPanelTabState | null {
  if (!isRecord(value) || value.type !== type) {
    return null
  }

  if (type === 'browser') {
    return {
      type,
      url: typeof value.url === 'string' ? value.url : '',
      addressInput: typeof value.addressInput === 'string' ? value.addressInput : '',
      zoom: typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0.25 && value.zoom <= 3
        ? value.zoom
        : 1,
      deviceToolbarVisible: typeof value.deviceToolbarVisible === 'boolean'
        ? value.deviceToolbarVisible
        : false,
    }
  }

  if (type === 'files') {
    return {
      type,
      source: value.source === 'workspace' || value.source === 'memory' ? value.source : 'thread',
      selectedPath: value.selectedPath === null || typeof value.selectedPath === 'string'
        ? value.selectedPath
        : null,
      treeVisible: typeof value.treeVisible === 'boolean' ? value.treeVisible : true,
      searchQuery: typeof value.searchQuery === 'string' ? value.searchQuery : '',
      enhancedView: typeof value.enhancedView === 'boolean' ? value.enhancedView : true,
    }
  }

  return { type }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
