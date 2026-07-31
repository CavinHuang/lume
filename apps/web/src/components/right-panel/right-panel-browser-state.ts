import type { BrowserTabDescriptor, BrowserViewportState } from '@lume/shared'

export interface RightPanelBrowserTab {
  id: string
  url: string
  title: string
  faviconUrl?: string
  createdAt: string
  lastOpenedAt: string
  zoomFactor: number
  viewport?: BrowserViewportState
  navigationEntries?: string[]
  navigationIndex?: number
  scrollPosition?: { x: number; y: number }
}

export interface ThreadBrowserWorkspace {
  tabs: RightPanelBrowserTab[]
  activeTabId?: string
  recentlyClosed: RightPanelBrowserTab[]
}

export function createThreadBrowserWorkspace(): ThreadBrowserWorkspace {
  return { tabs: [], recentlyClosed: [] }
}

export function createBrowserTab(input: Partial<Pick<RightPanelBrowserTab, 'url' | 'title' | 'zoomFactor' | 'viewport' | 'navigationEntries' | 'navigationIndex' | 'scrollPosition'>> = {}): RightPanelBrowserTab {
  const now = new Date().toISOString()
  return {
    id: `browser:${crypto.randomUUID()}`,
    url: input.url ?? '',
    title: input.title || '新标签页',
    createdAt: now,
    lastOpenedAt: now,
    zoomFactor: input.zoomFactor ?? 1,
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.navigationEntries ? { navigationEntries: input.navigationEntries } : {}),
    ...(input.navigationIndex !== undefined ? { navigationIndex: input.navigationIndex } : {}),
    ...(input.scrollPosition ? { scrollPosition: input.scrollPosition } : {}),
  }
}

export function openBrowserTab(
  workspace: ThreadBrowserWorkspace,
  input: Partial<Pick<RightPanelBrowserTab, 'url' | 'title' | 'zoomFactor' | 'viewport' | 'navigationEntries' | 'navigationIndex' | 'scrollPosition'>> = {},
): ThreadBrowserWorkspace {
  const tab = createBrowserTab(input)
  return { ...workspace, tabs: [...workspace.tabs, tab], activeTabId: tab.id }
}

export function activateBrowserTab(workspace: ThreadBrowserWorkspace, tabId: string): ThreadBrowserWorkspace {
  if (!workspace.tabs.some((tab) => tab.id === tabId)) return workspace
  const now = new Date().toISOString()
  return {
    ...workspace,
    activeTabId: tabId,
    tabs: workspace.tabs.map((tab) => tab.id === tabId ? { ...tab, lastOpenedAt: now } : tab),
  }
}

export function updateBrowserTab(
  workspace: ThreadBrowserWorkspace,
  tabId: string,
  patch: Partial<Omit<RightPanelBrowserTab, 'id' | 'createdAt'>>,
): ThreadBrowserWorkspace {
  let changed = false
  const tabs = workspace.tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    changed = true
    return { ...tab, ...patch }
  })
  return changed ? { ...workspace, tabs } : workspace
}

export function applyBrowserDescriptor(
  workspace: ThreadBrowserWorkspace,
  descriptor: BrowserTabDescriptor,
): ThreadBrowserWorkspace {
  return updateBrowserTab(workspace, descriptor.tabId, {
    url: descriptor.url,
    title: descriptor.title || '新标签页',
    faviconUrl: descriptor.faviconUrl,
    lastOpenedAt: descriptor.lastOpenedAt ?? new Date().toISOString(),
    zoomFactor: descriptor.zoomFactor ?? 1,
    viewport: descriptor.viewport,
    navigationEntries: descriptor.navigationEntries,
    navigationIndex: descriptor.navigationIndex,
    scrollPosition: descriptor.scrollPosition,
  })
}

export function browserTabFromDescriptor(descriptor: BrowserTabDescriptor): RightPanelBrowserTab {
  const now = new Date().toISOString()
  return {
    id: descriptor.tabId,
    url: descriptor.url,
    title: descriptor.title || '新标签页',
    ...(descriptor.faviconUrl ? { faviconUrl: descriptor.faviconUrl } : {}),
    createdAt: now,
    lastOpenedAt: descriptor.lastOpenedAt ?? now,
    zoomFactor: descriptor.zoomFactor ?? 1,
    ...(descriptor.viewport ? { viewport: descriptor.viewport } : {}),
    ...(descriptor.navigationEntries ? { navigationEntries: descriptor.navigationEntries } : {}),
    ...(descriptor.navigationIndex !== undefined ? { navigationIndex: descriptor.navigationIndex } : {}),
    ...(descriptor.scrollPosition ? { scrollPosition: descriptor.scrollPosition } : {}),
  }
}

export function closeBrowserTab(workspace: ThreadBrowserWorkspace, tabId: string): ThreadBrowserWorkspace {
  const index = workspace.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return workspace
  const tab = workspace.tabs[index]!
  const tabs = workspace.tabs.filter((item) => item.id !== tabId)
  const activeTabId = workspace.activeTabId === tabId
    ? (tabs[index] ?? tabs[index - 1])?.id
    : workspace.activeTabId
  return {
    tabs,
    ...(activeTabId ? { activeTabId } : {}),
    recentlyClosed: [tab, ...workspace.recentlyClosed.filter((item) => item.id !== tab.id)].slice(0, 10),
  }
}

export function duplicateBrowserTab(workspace: ThreadBrowserWorkspace, tabId: string): ThreadBrowserWorkspace {
  const source = workspace.tabs.find((tab) => tab.id === tabId)
  if (!source) return workspace
  const duplicate = createBrowserTab({
    url: source.url,
    title: source.title,
    zoomFactor: source.zoomFactor,
    viewport: source.viewport,
    navigationEntries: source.navigationEntries,
    navigationIndex: source.navigationIndex,
    scrollPosition: source.scrollPosition,
  })
  const index = workspace.tabs.findIndex((tab) => tab.id === tabId)
  const tabs = [...workspace.tabs]
  tabs.splice(index + 1, 0, duplicate)
  return { ...workspace, tabs, activeTabId: duplicate.id }
}

export function restoreClosedBrowserTab(workspace: ThreadBrowserWorkspace): ThreadBrowserWorkspace {
  const [closed, ...recentlyClosed] = workspace.recentlyClosed
  if (!closed) return workspace
  const restored = { ...closed, id: `browser:${crypto.randomUUID()}`, lastOpenedAt: new Date().toISOString() }
  return { tabs: [...workspace.tabs, restored], activeTabId: restored.id, recentlyClosed }
}

export function sanitizeThreadBrowserWorkspace(value: unknown): ThreadBrowserWorkspace {
  if (!isRecord(value)) return createThreadBrowserWorkspace()
  const tabs = Array.isArray(value.tabs) ? value.tabs.map(sanitizeBrowserTab).filter((tab): tab is RightPanelBrowserTab => Boolean(tab)) : []
  const recentlyClosed = Array.isArray(value.recentlyClosed)
    ? value.recentlyClosed.map(sanitizeBrowserTab).filter((tab): tab is RightPanelBrowserTab => Boolean(tab)).slice(0, 10)
    : []
  const activeTabId = typeof value.activeTabId === 'string' && tabs.some((tab) => tab.id === value.activeTabId)
    ? value.activeTabId
    : tabs.at(-1)?.id
  return { tabs, recentlyClosed, ...(activeTabId ? { activeTabId } : {}) }
}

function sanitizeBrowserTab(value: unknown): RightPanelBrowserTab | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.startsWith('browser:')) return null
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString()
  return {
    id: value.id,
    url: typeof value.url === 'string' ? value.url : '',
    title: typeof value.title === 'string' && value.title ? value.title : '新标签页',
    ...(typeof value.faviconUrl === 'string' ? { faviconUrl: value.faviconUrl } : {}),
    createdAt,
    lastOpenedAt: typeof value.lastOpenedAt === 'string' ? value.lastOpenedAt : createdAt,
    zoomFactor: typeof value.zoomFactor === 'number' && value.zoomFactor >= 0.25 && value.zoomFactor <= 5 ? value.zoomFactor : 1,
    ...(isViewport(value.viewport) ? { viewport: value.viewport } : {}),
    ...(Array.isArray(value.navigationEntries) ? { navigationEntries: value.navigationEntries.filter((entry): entry is string => typeof entry === 'string').slice(-200) } : {}),
    ...(typeof value.navigationIndex === 'number' && Number.isInteger(value.navigationIndex) ? { navigationIndex: value.navigationIndex } : {}),
    ...(isScrollPosition(value.scrollPosition) ? { scrollPosition: value.scrollPosition } : {}),
  }
}

function isViewport(value: unknown): value is BrowserViewportState {
  if (!isRecord(value)) return false
  return typeof value.enabled === 'boolean'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && typeof value.deviceScaleFactor === 'number'
    && typeof value.mobile === 'boolean'
    && typeof value.touch === 'boolean'
}

function isScrollPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
