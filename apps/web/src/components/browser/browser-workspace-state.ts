/**
 * 浏览器面板的工作区维度状态仓库 —— ZCode Ed/Dd 语义的 Lume 落法。
 *
 * 语义来源:docs/analysis/P1-shell-architecture.md §1.1(Ed 默认存储 + Dd 模块级
 * Map)+ zcode-sidepane-consolidated.md §2/§5:SidePane 状态按 workspaceKey 维度
 * 存模块级 Map(容量 50,写入刷新 LRU 插入序、超出淘汰最早插入的 key),切换
 * 工作区时旧 key 落库、新 key 恢复;**纯 renderer 内存,不进 localStorage、不发
 * main,reload 即失**。
 *
 * 快照形状对齐 ZCode Ed:tabs + activeTabId + collapsed + browserUrls
 * (tabId → 最近页面 URL,恢复 tab 用;url 随每次导航经 patchStoredBrowserTab /
 * saveBrowserWorkspaceSnapshot 刷新)。
 *
 * 事件路由:main→renderer 事件只带 tabId,面板的 React 态只装当前工作区的 tab;
 * 后台工作区 bucket 内的 tab 由 patchStoredBrowserTab / hasStoredBrowserTab /
 * findStoredBrowserTab 路由更新,保证挂起/恢复/标题/favicons 元数据在切换后不丢真。
 */
import type { BrowserPanelTab } from './useBrowserPanel'

/** 每工作区快照(ZCode Ed 形状:sidePaneState + isSidePaneCollapsed + browserUrls)。 */
export interface BrowserWorkspaceSnapshot {
  tabs: BrowserPanelTab[]
  activeTabId: string | null
  collapsed: boolean
  /** tabId → 最近页面 URL(恢复 tab 时回填 tab.url)。 */
  browserUrls: Record<string, string>
}

/** 容量上限(ZCode Dd:超出淘汰最早插入的 workspaceKey)。 */
export const BROWSER_WORKSPACE_STORE_LIMIT = 50

/** 空快照工厂(ZCode Ed 默认值;collapsed=false 对应面板默认可见)。 */
export function emptyBrowserWorkspaceSnapshot(): BrowserWorkspaceSnapshot {
  return { tabs: [], activeTabId: null, collapsed: false, browserUrls: {} }
}

const snapshots = new Map<string, BrowserWorkspaceSnapshot>()

/** 是否为参与 browserUrls 的真实页面 URL(about:blank/空串不入表)。 */
function isRealPageUrl(url: string | null | undefined): url is string {
  return Boolean(url && url !== 'about:blank')
}

/** 写入即刷新 LRU 插入序(ZCode Od:delete+set),超限淘汰最早插入的 key。 */
function writeSnapshot(workspaceKey: string, snapshot: BrowserWorkspaceSnapshot): void {
  snapshots.delete(workspaceKey)
  snapshots.set(workspaceKey, snapshot)
  for (; snapshots.size > BROWSER_WORKSPACE_STORE_LIMIT;) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) break
    snapshots.delete(oldest)
  }
}

/** 原位替换快照(Map.set 对既有 key 不改插入序——事件路由不算工作区访问)。 */
function replaceSnapshot(workspaceKey: string, snapshot: BrowserWorkspaceSnapshot): void {
  snapshots.set(workspaceKey, snapshot)
}

/**
 * 读取工作区快照(未落库返回空快照;只读不刷 LRU 序,对齐 ZCode Ad)。
 * 返回深拷贝:调用方(面板 React 态)可自由修改,不污染库内快照。
 * 恢复语义:tab.url 空白时以 browserUrls 回填(ZCode Ujt 跨任务恢复 URL)。
 */
export function readBrowserWorkspaceSnapshot(workspaceKey: string): BrowserWorkspaceSnapshot {
  const stored = snapshots.get(workspaceKey)
  if (!stored) return emptyBrowserWorkspaceSnapshot()
  return {
    tabs: stored.tabs.map((tab) => ({
      ...tab,
      url: isRealPageUrl(tab.url) ? tab.url : stored.browserUrls[tab.tabId] ?? tab.url,
    })),
    activeTabId: stored.activeTabId,
    collapsed: stored.collapsed,
    browserUrls: { ...stored.browserUrls },
  }
}

/**
 * 落库工作区快照(save-on-switch / 面板卸载时调用)。
 * browserUrls 由 tabs 的真实 url 派生(tab.url 随每次导航更新),url 空白的 tab
 * 保留既有表项(如 webview 已被摘除的挂起壳),且只保留存活 tab 的表项。
 */
export function saveBrowserWorkspaceSnapshot(
  workspaceKey: string,
  input: { tabs: BrowserPanelTab[]; activeTabId: string | null; collapsed: boolean },
): void {
  const previous = snapshots.get(workspaceKey)
  const browserUrls: Record<string, string> = {}
  for (const tab of input.tabs) {
    const url = isRealPageUrl(tab.url) ? tab.url : previous?.browserUrls[tab.tabId]
    if (isRealPageUrl(url)) browserUrls[tab.tabId] = url
  }
  writeSnapshot(workspaceKey, {
    tabs: input.tabs.map((tab) => ({ ...tab })),
    activeTabId: input.activeTabId,
    collapsed: input.collapsed,
    browserUrls,
  })
}

/**
 * 按 tabId 路由 patch 到所有持有它的 bucket(当前工作区的 tab 在面板 React 态里,
 * 由调用方另行更新)。patch.url 为真实 url 时同步刷新该 bucket 的 browserUrls。
 */
export function patchStoredBrowserTab(tabId: string, patch: Partial<BrowserPanelTab>): void {
  for (const [key, snapshot] of snapshots) {
    const index = snapshot.tabs.findIndex((tab) => tab.tabId === tabId)
    if (index < 0) continue
    const browserUrls = { ...snapshot.browserUrls }
    if (isRealPageUrl(patch.url)) browserUrls[tabId] = patch.url
    const tabs = [...snapshot.tabs]
    tabs[index] = { ...snapshot.tabs[index]!, ...patch }
    replaceSnapshot(key, { tabs, activeTabId: snapshot.activeTabId, collapsed: snapshot.collapsed, browserUrls })
  }
}

/** tabId 是否落在某个已落库 bucket(与面板当前列表互补的存在性判断)。 */
export function hasStoredBrowserTab(tabId: string): boolean {
  for (const snapshot of snapshots.values()) {
    if (snapshot.tabs.some((tab) => tab.tabId === tabId)) return true
  }
  return false
}

/** 读取已落库 bucket 内的 tab(事件装配需要 workspaceKey/sessionId 等作用域字段)。 */
export function findStoredBrowserTab(tabId: string): BrowserPanelTab | null {
  for (const snapshot of snapshots.values()) {
    const tab = snapshot.tabs.find((item) => item.tabId === tabId)
    if (tab) return { ...tab }
  }
  return null
}

/** 后台工作区新建 tab 落 bucket(ZCode ready→后台挂载;不进当前面板列表)。 */
export function addStoredBrowserTab(workspaceKey: string, tab: BrowserPanelTab): void {
  const restored = readBrowserWorkspaceSnapshot(workspaceKey)
  if (restored.tabs.some((item) => item.tabId === tab.tabId)) return
  saveBrowserWorkspaceSnapshot(workspaceKey, {
    tabs: [...restored.tabs, { ...tab }],
    activeTabId: restored.activeTabId,
    collapsed: restored.collapsed,
  })
}

/**
 * 从所有 bucket 移除 tab(main 权威关闭的后台路由;activeTabId 指向它时回落邻位,
 * 对齐面板 closeTab 的邻居回落)。
 */
export function removeStoredBrowserTab(tabId: string): void {
  for (const [key, snapshot] of snapshots) {
    const index = snapshot.tabs.findIndex((tab) => tab.tabId === tabId)
    if (index < 0) continue
    const tabs = snapshot.tabs.filter((tab) => tab.tabId !== tabId)
    const browserUrls = { ...snapshot.browserUrls }
    delete browserUrls[tabId]
    const activeTabId = snapshot.activeTabId === tabId
      ? tabs[index]?.tabId ?? tabs[index - 1]?.tabId ?? null
      : snapshot.activeTabId
    replaceSnapshot(key, { tabs, activeTabId, collapsed: snapshot.collapsed, browserUrls })
  }
}

/** 清空仓库(测试隔离用)。 */
export function resetBrowserWorkspaceStore(): void {
  snapshots.clear()
}
