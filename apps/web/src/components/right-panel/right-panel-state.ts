/**
 * 右侧面板统一 tab 模型 —— ZCode SidePane 壳层语义的 Lume 落法。
 *
 * 语义来源:docs/analysis/P1-shell-architecture.md §1/§2、docs/analysis/zcode-sidepane-consolidated.md §2:
 *   - sidePaneState = { tabs: SidePaneTab[], activeTabId } + isSidePaneCollapsed;
 *   - 纯 reducer:wd 关 tab(邻居回落)/Td 激活/Ede 关其他/Dde 关全部/
 *     Ade 重排(不动 activeTabId)/ode scope 重算(无可见 tab → 自动折叠)/
 *     sde upsert+激活(打开类操作一律先展开);
 *   - 最近关闭环 Xde=8(排除 selection-side-chat/browser-use,Lume 对应 chat)。
 *
 * 与浏览器面板的关系:统一 tab 数组里的 `browser` 是承载 BrowserSidePane 的宿主
 * tab;浏览器内部的多 tab(url/residency/generation)仍由 useBrowserPanel +
 * browser-workspace-state 承载,挂载/重挂时按 workspaceKey 自恢复。git 为单例
 * (GitPanel 只读);files/vault/chat 沿用原语义(chat 仅由划线引用触发,见 #18)。
 */
import type { LumeRuntimeEvent, RuntimeCodingFileChange, RuntimeCodingReport } from '@lume/shared'

export type RightPanelFunction = 'files' | 'chat' | 'vault' | 'browser' | 'git'

/** 可主动打开/参与回退优先级的功能集合(chat 不在菜单提供,由划线引用触发,见 #18)。 */
export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['files', 'vault', 'browser', 'git']

/** ZCode SidePaneTab 对齐:tab 全面板唯一 id;单例类型 id === type。 */
export interface RightPanelTab {
  id: string
  type: RightPanelFunction
}

/** ZCode sidePaneState + isSidePaneCollapsed:按 workspaceKey 分桶持久(见 right-panel-workspace-store.ts)。 */
export interface RightPanelWorkspaceState {
  tabs: RightPanelTab[]
  activeTabId: string | null
  collapsed: boolean
}

/** 最近关闭环容量(ZCode Xde=8)。 */
export const RIGHT_PANEL_CLOSED_RING_LIMIT = 8

/** 不入最近关闭环的类型(ZCode 排除 selection-side-chat/browser-use)。 */
const RIGHT_PANEL_RING_EXCLUDED_TYPES: ReadonlySet<RightPanelFunction> = new Set(['chat'])

/** 最近关闭环条目(重开时按 type upsert)。 */
export interface RightPanelClosedEntry {
  tab: RightPanelTab
  closedAt: number
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

/* ── 工厂 / 消毒 ─────────────────────────────────────────────────────── */

export function createEmptyRightPanelWorkspace(): RightPanelWorkspaceState {
  return { tabs: [], activeTabId: null, collapsed: false }
}

/** 单例类型 id === type;未来多开类型在此扩展 id 生成。 */
export function createRightPanelTab(type: RightPanelFunction): RightPanelTab {
  return { id: type, type }
}

export function findRightPanelTab(state: RightPanelWorkspaceState, tabId: string): RightPanelTab | null {
  return state.tabs.find((tab) => tab.id === tabId) ?? null
}

/** ZCode sd 消毒:剔除未知类型、按 id 去重、activeTabId 失效回落最后一个 tab。 */
export function sanitizeRightPanelWorkspaceState(value: unknown): RightPanelWorkspaceState {
  if (!isRecord(value)) return createEmptyRightPanelWorkspace()
  const seen = new Set<string>()
  const tabs = (Array.isArray(value.tabs) ? value.tabs : []).flatMap((item): RightPanelTab[] => {
    if (!isRecord(item) || !isRightPanelFunction(item.type)) return []
    const id = typeof item.id === 'string' && item.id ? item.id : item.type
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, type: item.type }]
  })
  const activeTabId = typeof value.activeTabId === 'string' && seen.has(value.activeTabId)
    ? value.activeTabId
    : tabs.at(-1)?.id ?? null
  return { tabs, activeTabId, collapsed: value.collapsed === true }
}

/* ── 纯 reducer(ZCode wd/Td/Ede/Dde/Ade/ode/sde 对齐) ────────────────── */

/** 激活(ZCode Td);打开类操作一律先展开(ZCode 打开路径 b(!1))。 */
export function activateRightPanelTab(state: RightPanelWorkspaceState, tabId: string): RightPanelWorkspaceState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state
  if (state.activeTabId === tabId && !state.collapsed) return state
  return { ...state, activeTabId: tabId, collapsed: false }
}

/** upsert(单例幂等,不改变既有位置)+ 激活 + 展开(ZCode sde/fd)。 */
export function openRightPanelTab(state: RightPanelWorkspaceState, type: RightPanelFunction): RightPanelWorkspaceState {
  const existing = state.tabs.find((tab) => tab.type === type)
  if (existing) return activateRightPanelTab(state, existing.id)
  const tab = createRightPanelTab(type)
  return activateRightPanelTab({ ...state, tabs: [...state.tabs, tab] }, tab.id)
}

/** 关闭(ZCode wd):删空 → 收起;删的是活动 tab → 激活原索引处邻居。 */
export function closeRightPanelTab(state: RightPanelWorkspaceState, tabId: string): RightPanelWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  if (tabs.length === 0) return { tabs, activeTabId: null, collapsed: true }
  const activeTabId = state.activeTabId === tabId
    ? tabs[Math.min(index, tabs.length - 1)]!.id
    : state.activeTabId
  return { tabs, activeTabId, collapsed: state.collapsed }
}

/** 关其他(ZCode Ede):保留目标并激活;返回 [新状态, 被关 tabs(入环用)]。 */
export function closeOtherRightPanelTabs(
  state: RightPanelWorkspaceState,
  tabId: string,
): [RightPanelWorkspaceState, RightPanelTab[]] {
  const target = findRightPanelTab(state, tabId)
  if (!target) return [state, []]
  const closed = state.tabs.filter((tab) => tab.id !== tabId)
  if (closed.length === 0) return [activateRightPanelTab(state, tabId), []]
  return [{ tabs: [target], activeTabId: target.id, collapsed: false }, closed]
}

/** 关全部(ZCode Dde):清空 → 收起;返回 [新状态, 被关 tabs(入环用)]。 */
export function closeAllRightPanelTabs(state: RightPanelWorkspaceState): [RightPanelWorkspaceState, RightPanelTab[]] {
  if (state.tabs.length === 0) return [state, []]
  const empty = recomputeRightPanelCollapse(createEmptyRightPanelWorkspace())
  return [empty, state.tabs]
}

/**
 * 重排(ZCode Ade splice 语义):非全量排列/含未知 id 时保持原序;
 * 不改动 activeTabId。
 */
export function reorderRightPanelTabs(
  state: RightPanelWorkspaceState,
  orderedIds: readonly string[],
): RightPanelWorkspaceState {
  if (orderedIds.length !== state.tabs.length) return state
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
  if (orderedIds.some((id) => !byId.has(id))) return state
  const tabs = orderedIds.map((id) => byId.get(id)!)
  const unchanged = tabs.every((tab, index) => tab === state.tabs[index])
  return unchanged ? state : { ...state, tabs }
}

/** scope 重算(ZCode ode):无可见 tab → 自动折叠。 */
export function recomputeRightPanelCollapse(state: RightPanelWorkspaceState): RightPanelWorkspaceState {
  const collapsed = state.tabs.length === 0
  return state.collapsed === collapsed ? state : { ...state, collapsed }
}

/* ── 最近关闭环(ZCode Xde=8) ─────────────────────────────────────────── */

/** 压入最近关闭环:新条目置顶、按 tab id 去重、排除类型不入环、超容量从尾部丢弃。 */
export function pushRightPanelClosedRing(
  ring: readonly RightPanelClosedEntry[],
  closed: readonly RightPanelTab[],
  closedAt = Date.now(),
): RightPanelClosedEntry[] {
  const entries = closed.filter((tab) => !RIGHT_PANEL_RING_EXCLUDED_TYPES.has(tab.type))
  if (entries.length === 0) return [...ring]
  const ids = new Set(entries.map((tab) => tab.id))
  return [
    ...entries.map((tab) => ({ tab, closedAt })),
    ...ring.filter((entry) => !ids.has(entry.tab.id)),
  ].slice(0, RIGHT_PANEL_CLOSED_RING_LIMIT)
}

/* ── 派生查询 ────────────────────────────────────────────────────────── */

export function getAvailableRightPanelFunctions(tabs: readonly RightPanelTab[]): RightPanelFunction[] {
  const open = new Set(tabs.map((tab) => tab.type))
  return RIGHT_PANEL_FUNCTION_ORDER.filter((type) => !open.has(type))
}

export function getOpenRightPanelFunctions(tabs: readonly RightPanelTab[]): RightPanelFunction[] {
  const open = new Set(tabs.map((tab) => tab.type))
  return RIGHT_PANEL_FUNCTION_ORDER.filter((type) => open.has(type))
}

/** 打开的第一个功能 tab(按用户排列序;仅用于恢复兜底)。 */
export function firstOpenRightPanelTab(tabs: readonly RightPanelTab[]): RightPanelFunction | null {
  return tabs[0]?.type ?? null
}

/** 工作区身份规约(ZCode kd):与 sidecar 浏览器上下文/浏览器面板分桶同构。 */
export function resolveRightPanelWorkspaceKey(input: {
  workspaceSlug?: string
  workspaceId?: string
  threadId: string
}): string {
  return input.workspaceSlug ?? input.workspaceId ?? input.threadId
}

function isRightPanelFunction(value: unknown): value is RightPanelFunction {
  return value === 'files' || value === 'chat' || value === 'vault' || value === 'browser' || value === 'git'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
