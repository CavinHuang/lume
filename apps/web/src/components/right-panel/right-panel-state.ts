export type RightPanelFunction = 'review' | 'terminal' | 'browser' | 'files'

export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['review', 'terminal', 'browser', 'files']

export interface ThreadRightPanelWorkspace {
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
}

export function createEmptyRightPanelWorkspace(): ThreadRightPanelWorkspace {
  return { tabs: {} }
}

export function createDefaultRightPanelTab(type: RightPanelFunction): RightPanelTabState {
  if (type === 'browser') {
    return { type, url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }
  }

  if (type === 'files') {
    return { type }
  }

  return { type }
}

export function openRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  return {
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

export function getOpenRightPanelFunctions(
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>,
): RightPanelFunction[] {
  return RIGHT_PANEL_FUNCTION_ORDER.filter((type) => Boolean(tabs[type]))
}

export function closeRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  const tabs = { ...workspace.tabs }
  delete tabs[type]

  return { tabs }
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

  return { tabs }
}

export function migrateLegacyRightPanelHints(input: {
  sidePanelView?: unknown
  fileTreeOpen?: unknown
}): ThreadRightPanelWorkspace {
  if (input.sidePanelView !== 'files') {
    return createEmptyRightPanelWorkspace()
  }

  return openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
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
    return { type }
  }

  return { type }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
