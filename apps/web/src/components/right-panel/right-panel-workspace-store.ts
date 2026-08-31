/**
 * 右侧面板统一 tab 的工作区维度状态仓库 —— ZCode Qde 控制器 + Dd 存储语义的 Lume 落法。
 *
 * 语义来源:docs/analysis/P1-shell-architecture.md §1.1(Ed 默认存储 + Dd 模块级
 * Map≤50)+ §2(handle* 操作家族)+ zcode-sidepane-consolidated.md §2:
 *   - 按 workspaceKey 分桶的 renderer 内存 Map,容量 50,写入刷新 LRU 插入序、
 *     超出淘汰最早插入的 key;**纯内存,不进 localStorage、reload 即失**(ZCode §5);
 *   - 操作家族:打开(upsert+激活+展开)/激活(suspended 浏览器唤醒由面板内部
 *     BrowserSidePane 恢复流程承担,此处只切 activeTabId)/关闭(wd,邻居回落,
 *     自动折叠)/关其他(Ede)/关全部(Dde)/重排(Ade,不动 activeTabId)/
 *     重开最近关闭(出环+upsert+激活)/折叠切换(he);
 *   - 最近关闭环 8 条全局共享,chat(对应 ZCode selection-side-chat)不入环。
 *
 * React 绑定:状态对象不可变、写路径整体替换,经 useSyncExternalStore 订阅;
 * getSnapshot 返回 Map 内的稳定引用,不产生额外渲染。动作可直接从 atom/组件
 * 调用(jotai 写入与面板渲染共享同一事实源)。
 */
import { useSyncExternalStore } from 'react'
import {
  activateRightPanelTab,
  closeAllRightPanelTabs,
  closeOtherRightPanelTabs,
  closeRightPanelTab,
  createEmptyRightPanelWorkspace,
  openRightPanelTab,
  openRightPanelTerminalInstance,
  pushRightPanelClosedRing,
  recomputeRightPanelCollapse,
  reorderRightPanelTabs,
  resolveRightPanelWorkspaceKey,
  type RightPanelClosedEntry,
  type RightPanelFunction,
  type RightPanelTab,
  type RightPanelWorkspaceState,
} from './right-panel-state'

export { resolveRightPanelWorkspaceKey }

/** 容量上限(ZCode Dd:超出淘汰最早插入的 workspaceKey)。 */
export const RIGHT_PANEL_WORKSPACE_STORE_LIMIT = 50

const workspaces = new Map<string, RightPanelWorkspaceState>()
let closedRing: RightPanelClosedEntry[] = []
let version = 0
const listeners = new Set<() => void>()

const EMPTY_STATE = createEmptyRightPanelWorkspace()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** 写入即刷新 LRU 插入序(ZCode Od:delete+set),超限淘汰最早插入的 key。 */
function writeState(workspaceKey: string, state: RightPanelWorkspaceState): void {
  if (readRightPanelWorkspaceState(workspaceKey) === state) return
  workspaces.delete(workspaceKey)
  workspaces.set(workspaceKey, state)
  for (; workspaces.size > RIGHT_PANEL_WORKSPACE_STORE_LIMIT;) {
    const oldest = workspaces.keys().next().value
    if (oldest === undefined) break
    workspaces.delete(oldest)
  }
  notify()
}

function pushClosedRing(closed: readonly RightPanelTab[]): void {
  const next = pushRightPanelClosedRing(closedRing, closed)
  if (next !== closedRing) closedRing = next
}

/* ── React 订阅面 ────────────────────────────────────────────────────── */

export function subscribeRightPanelWorkspaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 读取工作区统一 tab 状态(未落库返回空快照;只读不刷 LRU 序,对齐 ZCode Ad)。 */
export function readRightPanelWorkspaceState(workspaceKey: string): RightPanelWorkspaceState {
  return workspaces.get(workspaceKey) ?? EMPTY_STATE
}

export function getRightPanelClosedRing(): RightPanelClosedEntry[] {
  return closedRing
}

/** 面板渲染订阅当前工作区状态(Map 值不可变,引用稳定,无冗余渲染)。 */
export function useRightPanelWorkspaceState(workspaceKey: string): RightPanelWorkspaceState {
  return useSyncExternalStore(
    subscribeRightPanelWorkspaces,
    () => readRightPanelWorkspaceState(workspaceKey),
    () => readRightPanelWorkspaceState(workspaceKey),
  )
}

export function useRightPanelClosedRing(): RightPanelClosedEntry[] {
  return useSyncExternalStore(
    subscribeRightPanelWorkspaces,
    getRightPanelClosedRing,
    getRightPanelClosedRing,
  )
}

/** 全仓库写入版本(任意工作区变更即递增;供跨工作区对账 effect 作依赖)。 */
export function useRightPanelStoreVersion(): number {
  return useSyncExternalStore(
    subscribeRightPanelWorkspaces,
    getRightPanelStoreVersion,
    getRightPanelStoreVersion,
  )
}

/* ── 操作家族(ZCode handle* 对齐;version 供订阅调试/测试) ───────────── */

export function getRightPanelStoreVersion(): number {
  return version
}

/** 打开/激活功能 tab(ZCode handleOpenGit/handleToggleGit 等打开类:sde upsert+激活+展开)。 */
export function handleOpenTab(workspaceKey: string, type: RightPanelFunction): void {
  writeState(workspaceKey, openRightPanelTab(readRightPanelWorkspaceState(workspaceKey), type))
}

/** 激活(ZCode handleActivateSidePaneTab:只切 activeTabId 并展开)。 */
/** 终端实例(ZCode handleOpenTerminalTab):非单例,追加唯一 id tab 并激活。 */
export function handleOpenTerminalInstance(workspaceKey: string, tabId: string, title: string): void {
  writeState(workspaceKey, openRightPanelTerminalInstance(readRightPanelWorkspaceState(workspaceKey), tabId, title))
}

export function handleActivateTab(workspaceKey: string, tabId: string): void {
  writeState(workspaceKey, activateRightPanelTab(readRightPanelWorkspaceState(workspaceKey), tabId))
}

/** 关闭(ZCode handleCloseSidePaneTab:入环 + wd 邻居回落 + ode 自动折叠)。 */
export function handleCloseTab(workspaceKey: string, tabId: string): void {
  const state = readRightPanelWorkspaceState(workspaceKey)
  const closed = state.tabs.find((tab) => tab.id === tabId)
  if (!closed) return
  const next = closeRightPanelTab(state, tabId)
  pushClosedRing([closed])
  writeState(workspaceKey, recomputeRightPanelCollapse(next))
}

/** 关其他(ZCode handleCloseOtherSidePaneTab:Ede,激活目标)。 */
export function handleCloseOtherTabs(workspaceKey: string, tabId: string): void {
  const state = readRightPanelWorkspaceState(workspaceKey)
  if (!state.tabs.some((tab) => tab.id === tabId)) return
  const [next, closed] = closeOtherRightPanelTabs(state, tabId)
  pushClosedRing(closed)
  writeState(workspaceKey, next)
}

/** 关全部(ZCode handleCloseAllSidePaneTab:Dde,清空并折叠)。 */
export function handleCloseAllTabs(workspaceKey: string): void {
  const [next, closed] = closeAllRightPanelTabs(readRightPanelWorkspaceState(workspaceKey))
  pushClosedRing(closed)
  writeState(workspaceKey, next)
}

/** 重排(ZCode handleReorderSidePaneTab:Ade,不改 activeTabId)。 */
export function handleReorderTabs(workspaceKey: string, orderedIds: readonly string[]): void {
  writeState(workspaceKey, reorderRightPanelTabs(readRightPanelWorkspaceState(workspaceKey), orderedIds))
}

/** 重开最近关闭条目(ZCode handleReopenClosedSidePaneTab:出环 + upsert+激活+展开)。 */
export function handleReopenClosedTab(workspaceKey: string, entryId: string): void {
  const entry = closedRing.find((item) => item.tab.id === entryId)
  if (!entry) return
  closedRing = closedRing.filter((item) => item.tab.id !== entryId)
  writeState(workspaceKey, openRightPanelTab(readRightPanelWorkspaceState(workspaceKey), entry.tab.type))
}

/** 折叠切换(ZCode handleToggleSidePaneCollapse:he,纯翻转)。 */
export function handleToggleCollapse(workspaceKey: string): void {
  const state = readRightPanelWorkspaceState(workspaceKey)
  writeState(workspaceKey, { ...state, collapsed: !state.collapsed })
}

/** 展开面板(布局开关/打开类操作联动的显式展开;ZCode 打开路径 b(!1))。 */
export function handleExpandPanel(workspaceKey: string): void {
  const state = readRightPanelWorkspaceState(workspaceKey)
  if (!state.collapsed) return
  writeState(workspaceKey, { ...state, collapsed: false })
}

/** 清空仓库(测试隔离用)。 */
export function resetRightPanelWorkspaceStore(): void {
  workspaces.clear()
  closedRing = []
  notify()
}
