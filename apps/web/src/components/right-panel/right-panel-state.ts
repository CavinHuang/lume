import type { LumeRuntimeEvent, RuntimeCodingFileChange, RuntimeCodingReport } from '@lume/shared'

export type RightPanelFunction = 'browser' | 'files'

export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['browser', 'files']

export interface ThreadRightPanelWorkspace {
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>
}

export type RightPanelTabState =
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

export interface RightPanelReviewLaunchTarget {
  report: RuntimeCodingReport
  changes: RuntimeCodingFileChange[]
  recency: 'current' | 'previous'
}

export function getRightPanelReviewLaunchTarget(
  events: LumeRuntimeEvent[],
): RightPanelReviewLaunchTarget | null {
  let latestRunId: string | undefined
  const reports = new Map<string, RuntimeCodingReport>()

  for (const event of events) {
    if (event.type === 'run.started' && !event.parentToolUseId && !event.subagentRunId) {
      latestRunId = event.runId
    }
    const report = event.type === 'coding.report.updated'
      ? event.codingReport
      : event.type === 'run.completed'
        ? event.codingReport
        : undefined
    if (!report || event.parentToolUseId || event.subagentRunId) continue
    const runId = report.runId ?? event.runId
    const merged = { ...reports.get(runId), ...report, runId }
    reports.delete(runId)
    reports.set(runId, merged)
  }

  for (const [runId, report] of [...reports.entries()].reverse()) {
    const changes = report.changeSet?.files ?? report.fileChanges ?? []
    if (changes.length === 0) continue
    return {
      report,
      changes,
      recency: latestRunId && latestRunId !== runId ? 'previous' : 'current',
    }
  }
  return null
}

export function createEmptyRightPanelWorkspace(): ThreadRightPanelWorkspace {
  return { tabs: {} }
}

export function createDefaultRightPanelTab(type: RightPanelFunction): RightPanelTabState {
  if (type === 'browser') {
    return { type, url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }
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

  return { type }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
