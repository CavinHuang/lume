import type { LumeRuntimeEvent, RuntimeCodingFileChange, RuntimeCodingReport } from '@lume/shared'

export type RightPanelFunction = 'files' | 'chat' | 'vault' | 'browser'

export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['files', 'vault', 'browser']

export interface ThreadRightPanelWorkspace {
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>
}

export type RightPanelTabState =
  | FilesTabState
  | ChatTabState
  | VaultTabState
  | BrowserTabState

export interface FilesTabState {
  type: 'files'
}

/** Obsidian Vault 面板：全局状态（vault/文件选择不在会话间区分），无持久化 tab 状态 */
export interface VaultTabState {
  type: 'vault'
}

/** 内嵌浏览器面板（BrowserSidePane）：tab 模型由 browser-workspace-state 承载，这里只记 tab 开合 */
export interface BrowserTabState {
  type: 'browser'
}

/** 右侧面板 side-chat：为当前会话临时配一个问答副窗口（见 #18） */
export interface ChatTabState {
  type: 'chat'
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

  return { type }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
