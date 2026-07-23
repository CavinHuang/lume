import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, resolve, sep } from "node:path"

export const AGENT_DOWNLOAD_LIMITS = { maxFileBytes: 100 * 1024 * 1024, maxSessionBytes: 500 * 1024 * 1024, maxFiles: 20, maxConcurrent: 3, maxDurationMs: 10 * 60_000 } as const

export type BrowserDownloadHistoryEntry = {
  id: string
  filename: string
  actor: "user" | "agent"
  state: "completed" | "cancelled" | "interrupted"
  receivedBytes: number
  createdAt: string
}

export type PreparedDownload = { id: string; filename: string; partialPath: string; finalPath: string }

export function safeDownloadFilename(value: string): string {
  const leaf = basename(value.replace(/\\/g, "/"))
  const cleaned = leaf.replace(/[\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.\.+/g, "_").trim().replace(/[. ]+$/g, "")
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
  return !cleaned || cleaned === "." || cleaned === ".." || reserved ? "download" : cleaned.slice(0, 180)
}

export function prepareDownload(directory: string, requestedName: string): PreparedDownload {
  const root = resolve(directory)
  mkdirSync(root, { recursive: true })
  assertNoLinkPath(root)
  const canonicalRoot = realpathSync(root)
  const filename = safeDownloadFilename(requestedName)
  let finalPath = join(canonicalRoot, filename)
  for (let suffix = 1; existsSync(finalPath) || existsSync(`${finalPath}.partial`); suffix += 1) {
    const dot = filename.lastIndexOf(".")
    const stem = dot > 0 ? filename.slice(0, dot) : filename
    const extension = dot > 0 ? filename.slice(dot) : ""
    finalPath = join(canonicalRoot, `${stem} (${suffix})${extension}`)
  }
  assertWithin(canonicalRoot, finalPath)
  return { id: randomUUID(), filename: basename(finalPath), partialPath: `${finalPath}.partial`, finalPath }
}

export function completeDownload(download: PreparedDownload): void {
  assertNoLinkPath(download.partialPath, true)
  renameSync(download.partialPath, download.finalPath)
}

export function removePartialDownload(download: PreparedDownload): void {
  rmSync(download.partialPath, { force: true })
}

export class AgentDownloadQuota {
  private readonly sessions = new Map<string, { completedBytes: number; completedFiles: number; active: Map<string, number> }>()

  begin(sessionId: string, declaredBytes: number): string | null {
    const state = this.sessions.get(sessionId) ?? { completedBytes: 0, completedFiles: 0, active: new Map() }
    this.sessions.set(sessionId, state)
    if (state.active.size >= AGENT_DOWNLOAD_LIMITS.maxConcurrent || state.completedFiles + state.active.size >= AGENT_DOWNLOAD_LIMITS.maxFiles) return null
    if (declaredBytes > AGENT_DOWNLOAD_LIMITS.maxFileBytes || state.completedBytes + declaredBytes > AGENT_DOWNLOAD_LIMITS.maxSessionBytes) return null
    const id = randomUUID()
    state.active.set(id, 0)
    return id
  }

  update(sessionId: string, id: string, receivedBytes: number): boolean {
    const state = this.sessions.get(sessionId)
    if (!state?.active.has(id)) return false
    const bounded = Math.max(0, receivedBytes)
    state.active.set(id, bounded)
    const activeBytes = [...state.active.values()].reduce((sum, value) => sum + value, 0)
    return bounded <= AGENT_DOWNLOAD_LIMITS.maxFileBytes && state.completedBytes + activeBytes <= AGENT_DOWNLOAD_LIMITS.maxSessionBytes
  }

  finish(sessionId: string, id: string, completed: boolean): void {
    const state = this.sessions.get(sessionId)
    const received = state?.active.get(id)
    if (!state || received === undefined) return
    state.active.delete(id)
    if (completed) {
      state.completedBytes += received
      state.completedFiles += 1
    }
  }
}

export class BrowserDownloadHistory {
  constructor(private readonly configDir: () => string) {}

  list(): BrowserDownloadHistoryEntry[] {
    try {
      const value = JSON.parse(readFileSync(this.path(), "utf8"))
      return Array.isArray(value) ? value.filter(isHistoryEntry).slice(-500).reverse() : []
    } catch { return [] }
  }

  record(entry: BrowserDownloadHistoryEntry): void {
    const path = this.path()
    mkdirSync(join(path, ".."), { recursive: true })
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return
    const entries = [...this.list().reverse(), entry].slice(-500)
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 })
    renameSync(temporary, path)
  }

  clear(): void { rmSync(this.path(), { force: true }) }

  clearSince(timestamp: number): void {
    const entries = this.list().filter((entry) => Date.parse(entry.createdAt) < timestamp).reverse()
    if (!entries.length) { this.clear(); return }
    const path = this.path()
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 })
    renameSync(temporary, path)
  }

  private path(): string { return join(this.configDir(), "browser", "download-history.json") }
}

function assertWithin(root: string, candidate: string): void {
  const relative = resolve(candidate).slice(root.length)
  if (resolve(candidate) === root || !relative.startsWith(sep) || relative.includes(`..${sep}`)) throw new Error("download_path_rejected")
}

function assertNoLinkPath(path: string, allowMissingLeaf = false): void {
  let current = resolve(path)
  if (allowMissingLeaf && !existsSync(current)) current = join(current, "..")
  while (existsSync(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("download_link_rejected")
    const parent = resolve(current, "..")
    if (parent === current) break
    current = parent
  }
}

function isHistoryEntry(value: unknown): value is BrowserDownloadHistoryEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<BrowserDownloadHistoryEntry>
  return typeof entry.id === "string" && typeof entry.filename === "string" && (entry.actor === "user" || entry.actor === "agent") && ["completed", "cancelled", "interrupted"].includes(String(entry.state)) && typeof entry.receivedBytes === "number" && typeof entry.createdAt === "string"
}
