import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BrowserTabDescriptor, BrowserWorkspaceDescriptor } from "../../../packages/shared/src/types/browser-runtime"

type PersistedBrowserTab = Pick<BrowserTabDescriptor,
  "tabId" | "ownerThreadId" | "profileKind" | "url" | "title" | "faviconUrl" | "navigationEntries" |
  "navigationIndex" | "scrollPosition" | "zoomFactor" | "viewport" | "lastOpenedAt" | "handoffStatus"> & {
    partition?: string
    handoffBrowserSessionId?: string
    storageKind?: "shared" | "isolated"
  }

type BrowserWorkspaceFile = {
  version: 9
  workspaces: Record<string, BrowserWorkspaceDescriptor>
  tabs: Record<string, PersistedBrowserTab>
}

const EMPTY_STATE: BrowserWorkspaceFile = { version: 9, workspaces: {}, tabs: {} }

export class BrowserWorkspaceStore {
  private readonly path: string
  private state: BrowserWorkspaceFile

  constructor(configDir: () => string) {
    this.path = join(configDir(), "browser", "workspaces.json")
    const restored = readState(this.path)
    this.state = restored.state
    if (restored.migrated) this.write()
  }

  list(): BrowserWorkspaceDescriptor[] {
    return Object.values(this.state.workspaces).map(cloneWorkspace)
  }

  get(ownerThreadId: string): BrowserWorkspaceDescriptor {
    return cloneWorkspace(this.ensureWorkspace(ownerThreadId))
  }

  persistedTabs(ownerThreadId: string): PersistedBrowserTab[] {
    const workspace = this.ensureWorkspace(ownerThreadId)
    return workspace.orderedTabIds.flatMap((tabId) => this.state.tabs[tabId] ? [{ ...this.state.tabs[tabId]! }] : [])
  }

  rememberTab(tab: BrowserTabDescriptor, runtime?: { partition?: string; handoffBrowserSessionId?: string }): void {
    const ownerThreadId = tab.ownerThreadId
    if (!ownerThreadId || !isRecoverable(tab)) return
    const workspace = this.ensureWorkspace(ownerThreadId)
    this.state.tabs[tab.tabId] = sanitizeTab(tab, runtime)
    if (!workspace.orderedTabIds.includes(tab.tabId)) workspace.orderedTabIds.push(tab.tabId)
    workspace.revision += 1
    this.write()
  }

  activate(ownerThreadId: string, tabId: string): BrowserWorkspaceDescriptor {
    const workspace = this.ensureWorkspace(ownerThreadId)
    if (!workspace.orderedTabIds.includes(tabId)) throw new Error("tab_not_found")
    workspace.activeTabId = tabId
    workspace.revision += 1
    this.write()
    return cloneWorkspace(workspace)
  }

  reorder(ownerThreadId: string, orderedTabIds: string[]): BrowserWorkspaceDescriptor {
    const workspace = this.ensureWorkspace(ownerThreadId)
    const current = new Set(workspace.orderedTabIds)
    if (orderedTabIds.length !== current.size || orderedTabIds.some((tabId) => !current.has(tabId)) || new Set(orderedTabIds).size !== current.size) throw new Error("invalid_browser_request")
    workspace.orderedTabIds = [...orderedTabIds]
    workspace.revision += 1
    this.write()
    return cloneWorkspace(workspace)
  }

  move(tab: BrowserTabDescriptor, nextOwnerThreadId: string, runtime?: { partition?: string; handoffBrowserSessionId?: string }): void {
    if (tab.ownerThreadId) this.removeOpenTab(tab.ownerThreadId, tab.tabId)
    const next = { ...tab, ownerThreadId: nextOwnerThreadId }
    this.rememberTab(next, runtime)
  }

  close(tab: BrowserTabDescriptor, runtime?: { partition?: string; handoffBrowserSessionId?: string }): void {
    const ownerThreadId = tab.ownerThreadId
    if (!ownerThreadId || !isRecoverable(tab)) return
    const workspace = this.ensureWorkspace(ownerThreadId)
    workspace.orderedTabIds = workspace.orderedTabIds.filter((tabId) => tabId !== tab.tabId)
    if (workspace.activeTabId === tab.tabId) workspace.activeTabId = workspace.orderedTabIds.at(-1)
    workspace.recentlyClosed = [{
      tabId: tab.tabId,
      closedAt: new Date().toISOString(),
      title: tab.title || "新标签页",
      url: safeUrl(tab.url),
      profileKind: tab.profileKind ?? "user",
      ...(tab.handoffStatus ? { handoffStatus: tab.handoffStatus } : {}),
    }, ...workspace.recentlyClosed.filter((item) => item.tabId !== tab.tabId)].slice(0, 10)
    this.state.tabs[tab.tabId] = sanitizeTab(tab, runtime)
    workspace.revision += 1
    this.write()
  }

  restoreClosed(ownerThreadId: string): PersistedBrowserTab | undefined {
    const workspace = this.ensureWorkspace(ownerThreadId)
    const closed = workspace.recentlyClosed.shift()
    if (!closed) return undefined
    const tab = this.state.tabs[closed.tabId]
    if (!tab) return undefined
    if (!workspace.orderedTabIds.includes(tab.tabId)) workspace.orderedTabIds.push(tab.tabId)
    workspace.activeTabId = tab.tabId
    workspace.revision += 1
    this.write()
    return { ...tab }
  }

  importLegacy(ownerThreadId: string, tabs: unknown, activeTabId: unknown): BrowserWorkspaceDescriptor {
    const workspace = this.ensureWorkspace(ownerThreadId)
    for (const value of Array.isArray(tabs) ? tabs.slice(0, 50) : []) {
      if (!value || typeof value !== "object") continue
      const item = value as Record<string, unknown>
      if (typeof item.id !== "string" || !item.id.startsWith("browser:") || workspace.orderedTabIds.includes(item.id)) continue
      const url = typeof item.url === "string" ? safeUrl(item.url) : ""
      if (item.url && !url) continue
      this.state.tabs[item.id] = {
        tabId: item.id,
        ownerThreadId,
        profileKind: "user",
        url,
        title: typeof item.title === "string" ? item.title.slice(0, 256) : "新标签页",
        zoomFactor: boundedNumber(item.zoomFactor, .25, 5, 1),
        lastOpenedAt: typeof item.lastOpenedAt === "string" ? item.lastOpenedAt : new Date().toISOString(),
      }
      workspace.orderedTabIds.push(item.id)
    }
    if (typeof activeTabId === "string" && workspace.orderedTabIds.includes(activeTabId)) workspace.activeTabId = activeTabId
    else workspace.activeTabId ??= workspace.orderedTabIds.at(-1)
    workspace.revision += 1
    this.write()
    return cloneWorkspace(workspace)
  }

  flush(): void { this.write() }

  private ensureWorkspace(ownerThreadId: string): BrowserWorkspaceDescriptor {
    const id = ownerThreadId.trim().slice(0, 200)
    if (!id) throw new Error("invalid_browser_request")
    return this.state.workspaces[id] ??= { ownerThreadId: id, orderedTabIds: [], recentlyClosed: [], revision: 0 }
  }

  private removeOpenTab(ownerThreadId: string, tabId: string): void {
    const workspace = this.state.workspaces[ownerThreadId]
    if (!workspace) return
    workspace.orderedTabIds = workspace.orderedTabIds.filter((value) => value !== tabId)
    if (workspace.activeTabId === tabId) workspace.activeTabId = workspace.orderedTabIds.at(-1)
    workspace.revision += 1
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }
}

function readState(path: string): { state: BrowserWorkspaceFile; migrated: boolean } {
  if (!existsSync(path)) return { state: structuredClone(EMPTY_STATE), migrated: false }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<BrowserWorkspaceFile, "version">> & { version?: number }
    if ((value.version !== 1 && value.version !== 8 && value.version !== 9) || !isRecord(value.workspaces) || !isRecord(value.tabs)) {
      return { state: structuredClone(EMPTY_STATE), migrated: false }
    }
    const tabs = Object.fromEntries(Object.entries(value.tabs).flatMap(([tabId, raw]) => {
      if (!isRecord(raw) || raw.tabId !== tabId || typeof raw.url !== "string" || typeof raw.title !== "string") return []
      const profileKind: NonNullable<BrowserTabDescriptor["profileKind"]> = raw.profileKind === "agent" || raw.profileKind === "advanced-cdp" ? raw.profileKind : "user"
      const handoffStatus = raw.handoffStatus === "handoff" || raw.handoffStatus === "deliverable" ? raw.handoffStatus : undefined
      const storedPartition = isBrowserPartition(raw.partition) ? raw.partition : undefined
      const migrateLegacyAgentProfile = value.version !== 9 && profileKind === "agent" && storedPartition?.startsWith("lume-agent-")
      const partition = migrateLegacyAgentProfile ? "persist:lume-browser" : storedPartition
      const restored = {
        ...(raw as unknown as PersistedBrowserTab),
        tabId,
        profileKind,
        url: safeUrl(raw.url),
        title: raw.title.slice(0, 256),
        ...(handoffStatus ? { handoffStatus } : {}),
        ...(partition ? { partition, storageKind: partition === "persist:lume-browser" ? "shared" : "isolated" } : {}),
      } satisfies PersistedBrowserTab
      if (!handoffStatus) { delete restored.handoffStatus; delete restored.handoffBrowserSessionId }
      if (!partition) { delete restored.partition; delete restored.storageKind }
      return [[tabId, restored]]
    }))
    const workspaces = Object.fromEntries(Object.entries(value.workspaces).flatMap(([ownerThreadId, raw]) => {
      if (!isRecord(raw) || raw.ownerThreadId !== ownerThreadId || !Array.isArray(raw.orderedTabIds) || !Array.isArray(raw.recentlyClosed)) return []
      const orderedTabIds = raw.orderedTabIds.filter((tabId): tabId is string => typeof tabId === "string" && Boolean(tabs[tabId]))
      const recentlyClosed = raw.recentlyClosed.flatMap((closed) => {
        if (!isRecord(closed) || typeof closed.tabId !== "string" || typeof closed.closedAt !== "string" || typeof closed.title !== "string" || typeof closed.url !== "string") return []
        const profileKind: NonNullable<BrowserTabDescriptor["profileKind"]> = closed.profileKind === "agent" || closed.profileKind === "advanced-cdp" ? closed.profileKind : "user"
        return [{ tabId: closed.tabId, closedAt: closed.closedAt, title: closed.title, url: safeUrl(closed.url), profileKind, ...(closed.handoffStatus === "handoff" || closed.handoffStatus === "deliverable" ? { handoffStatus: closed.handoffStatus } : {}) }]
      }).slice(0, 10)
      return [[ownerThreadId, { ownerThreadId, orderedTabIds, ...(typeof raw.activeTabId === "string" && orderedTabIds.includes(raw.activeTabId) ? { activeTabId: raw.activeTabId } : {}), recentlyClosed, revision: Number.isSafeInteger(raw.revision) ? Number(raw.revision) : 0 } satisfies BrowserWorkspaceDescriptor]]
    }))
    return { state: { version: 9, workspaces, tabs }, migrated: value.version !== 9 }
  } catch {
    return { state: structuredClone(EMPTY_STATE), migrated: false }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sanitizeTab(tab: BrowserTabDescriptor, runtime?: { partition?: string; handoffBrowserSessionId?: string }): PersistedBrowserTab {
  return {
    tabId: tab.tabId,
    ...(tab.ownerThreadId ? { ownerThreadId: tab.ownerThreadId } : {}),
    profileKind: tab.profileKind ?? "user",
    url: safeUrl(tab.url),
    title: tab.title.slice(0, 256),
    ...(tab.faviconUrl?.startsWith("http") ? { faviconUrl: tab.faviconUrl.slice(0, 4096) } : {}),
    ...(tab.navigationEntries ? { navigationEntries: tab.navigationEntries.filter((url) => safeUrl(url)).map(safeUrl).slice(-200) } : {}),
    ...(Number.isInteger(tab.navigationIndex) ? { navigationIndex: tab.navigationIndex } : {}),
    ...(tab.scrollPosition ? { scrollPosition: { x: Math.max(0, tab.scrollPosition.x), y: Math.max(0, tab.scrollPosition.y) } } : {}),
    zoomFactor: boundedNumber(tab.zoomFactor, .25, 5, 1),
    ...(tab.viewport ? { viewport: { ...tab.viewport } } : {}),
    lastOpenedAt: tab.lastOpenedAt ?? new Date().toISOString(),
    ...(tab.handoffStatus ? { handoffStatus: tab.handoffStatus } : {}),
    ...(isBrowserPartition(runtime?.partition) ? {
      partition: runtime.partition,
      storageKind: runtime.partition === "persist:lume-browser" ? "shared" : "isolated",
    } : {}),
    ...(tab.handoffStatus && runtime?.handoffBrowserSessionId ? { handoffBrowserSessionId: runtime.handoffBrowserSessionId.slice(0, 200) } : {}),
  }
}

function isRecoverable(tab: BrowserTabDescriptor): boolean {
  return tab.profileKind === "user" || tab.handoffStatus === "handoff" || tab.handoffStatus === "deliverable"
}

function cloneWorkspace(workspace: BrowserWorkspaceDescriptor): BrowserWorkspaceDescriptor {
  return { ...workspace, orderedTabIds: [...workspace.orderedTabIds], recentlyClosed: workspace.recentlyClosed.map((item) => ({ ...item })) }
}

function safeUrl(value: string): string {
  if (!value) return ""
  try {
    const url = new URL(value)
    return ["http:", "https:", "view-source:"].includes(url.protocol) ? url.toString() : ""
  } catch { return "" }
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function isBrowserPartition(value: unknown): value is string {
  return value === "persist:lume-browser" || (typeof value === "string" && /^(?:lume-agent|lume-cdp)-[a-zA-Z0-9_-]{1,170}$/.test(value))
}
