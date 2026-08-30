/**
 * 恢复存储 —— BrowserRecoveryStorePort 的 JSON 文件实现(跨重启 tab 恢复)。
 *
 * 装配:assemble.ts 以 `recoveryStore: createRecoveryStore(deps.configDir)` 注入
 * BrowserGuestManager options(ZCode residencyOptions.recoveryStore 的落地形态;
 * ZCode 原实现位于提取域外,本文件按端口契约实现)。
 *
 * 存储:`<configDir>/browser-recovery/store.json`
 *   { schemaVersion: 1, shells: BrowserTabShellSnapshot[], pageStates: BrowserPageStateSnapshot[] }
 * 写入经 debounce 合并,原子落盘(临时文件 + rename);读入损坏/schema 不符按空存储处理。
 *
 * 清理策略:
 *   - updatedAt 距今超过 7 天的条目(shell 与 pageState)在加载与每次变更后清除;
 *   - shell 总量上限 50,超出按 updatedAt 保留最新(被裁 shell 的 pageState 一并清除)。
 */
import { randomUUID } from "crypto"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { join } from "path"
import type {
  BrowserPageStateSnapshot,
  BrowserRecoveryStorePort,
  BrowserRestoredTabShell,
  BrowserTabShellSnapshot,
} from "./guest-manager"

/** 条目保留时长(按 updatedAt;超过即清除) */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** shell 记录上限(超出按 updatedAt 保留最新) */
const MAX_SHELLS = 50
/** 变更落盘的 debounce 时长 */
const DEFAULT_FLUSH_DEBOUNCE_MS = 150

/** store.json 载荷形状 */
interface RecoveryFilePayload {
  schemaVersion: 1
  shells: BrowserTabShellSnapshot[]
  pageStates: BrowserPageStateSnapshot[]
}

/** createRecoveryStore 可调项(测试注入;缺省见常量) */
export interface RecoveryStoreOptions {
  now?: () => number
  maxShells?: number
  retentionMs?: number
  flushDebounceMs?: number
  warn?: (message: string, error?: unknown) => void
}

/** 宽松记录校验:至少是带 string tabId 的对象(损坏条目直接丢弃) */
function isRecordLike(value: unknown): value is { tabId: string } {
  return typeof value === "object" && value !== null && typeof (value as { tabId?: unknown }).tabId === "string"
}

/** 解析 store.json;损坏/schema 不符 → null(按空存储处理) */
function parsePayload(raw: string): RecoveryFilePayload | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== "object") return null
    const candidate = data as { schemaVersion?: unknown; shells?: unknown; pageStates?: unknown }
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.shells) || !Array.isArray(candidate.pageStates)) {
      return null
    }
    return {
      schemaVersion: 1,
      shells: candidate.shells.filter(isRecordLike) as BrowserTabShellSnapshot[],
      pageStates: candidate.pageStates.filter(isRecordLike) as BrowserPageStateSnapshot[],
    }
  } catch {
    return null
  }
}

/**
 * 创建恢复存储。IO 惰性:首次访问才读盘;写经 debounce 合并,临时文件 + rename 原子落盘。
 * 端口形状见 guest-manager.ts 的 BrowserRecoveryStorePort;额外提供 flushNow(测试/退出的即时落盘)。
 */
export function createRecoveryStore(configDir: string, options: RecoveryStoreOptions = {}): BrowserRecoveryStorePort & { flushNow(): Promise<void> } {
  const storeDir = join(configDir, "browser-recovery")
  const filePath = join(storeDir, "store.json")
  const now = options.now ?? (() => Date.now())
  const maxShells = options.maxShells ?? MAX_SHELLS
  const retentionMs = options.retentionMs ?? RETENTION_MS
  const flushDebounceMs = options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS
  const warn = options.warn ?? (() => {})

  const shells = new Map<string, BrowserTabShellSnapshot>()
  const pageStates = new Map<string, BrowserPageStateSnapshot>()
  let loaded = false
  let loadPromise: Promise<void> | null = null
  let dirty = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  /** 清理:超期条目清除 + shell 总量封顶(被裁 shell 的 pageState 一并清除) */
  function normalize(): void {
    const cutoff = now() - retentionMs
    for (const [tabId, shell] of shells) {
      if (shell.updatedAt < cutoff) {
        shells.delete(tabId)
        pageStates.delete(tabId)
      }
    }
    for (const [tabId, pageState] of pageStates) {
      if (pageState.updatedAt < cutoff) pageStates.delete(tabId)
    }
    if (shells.size > maxShells) {
      const stale = [...shells.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(maxShells)
      for (const shell of stale) {
        shells.delete(shell.tabId)
        pageStates.delete(shell.tabId)
      }
    }
  }

  async function load(): Promise<void> {
    if (loaded) return
    if (!loadPromise) {
      loadPromise = (async () => {
        let payload: RecoveryFilePayload | null = null
        try {
          payload = parsePayload(await readFile(filePath, "utf8"))
        } catch {
          payload = null // 首次使用/文件缺失/读失败均按空存储
        }
        if (payload) {
          for (const shell of payload.shells) shells.set(shell.tabId, shell)
          for (const pageState of payload.pageStates) pageStates.set(pageState.tabId, pageState)
          normalize()
        }
        loaded = true
      })()
    }
    await loadPromise
  }

  function serialize(): RecoveryFilePayload {
    return { schemaVersion: 1, shells: [...shells.values()], pageStates: [...pageStates.values()] }
  }

  async function writeAtomically(payload: RecoveryFilePayload): Promise<void> {
    await mkdir(storeDir, { recursive: true })
    const tempPath = join(storeDir, `store-${randomUUID()}.tmp`)
    await writeFile(tempPath, JSON.stringify(payload), "utf8")
    await rename(tempPath, filePath)
  }

  /** 立即落盘(合并并发写;与在途写串行) */
  function flush(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (!dirty) return writeChain
    dirty = false
    const payload = serialize()
    writeChain = writeChain
      .then(() => writeAtomically(payload))
      .catch(error => warn("[browser-recovery] failed to persist recovery store", error))
    return writeChain
  }

  function scheduleSave(): void {
    dirty = true
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void flush()
    }, flushDebounceMs)
  }

  return {
    async upsert(shell: BrowserTabShellSnapshot): Promise<void> {
      await load()
      shells.set(shell.tabId, shell)
      normalize()
      scheduleSave()
    },
    async remove(tabId: string): Promise<void> {
      await load()
      const hadShell = shells.delete(tabId)
      const hadPageState = pageStates.delete(tabId)
      if (hadShell || hadPageState) scheduleSave()
    },
    async listShells(query: {
      workspaceKey: string
      remoteSessionId?: string
      sessionId?: string
    }): Promise<BrowserRestoredTabShell[]> {
      await load()
      const matched = [...shells.values()]
        // workspaceKey 必须一致;remoteSessionId 缺省 = 本地壳(无远端会话);sessionId 缺省 = 全部
        .filter(shell =>
          shell.workspaceKey === query.workspaceKey &&
          (query.remoteSessionId === undefined ? !shell.remoteSessionId : shell.remoteSessionId === query.remoteSessionId) &&
          (query.sessionId === undefined || shell.sessionId === query.sessionId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return matched.map(shell => ({
        tabId: shell.tabId,
        workspaceKey: shell.workspaceKey,
        ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
        sessionId: shell.sessionId,
        ...(shell.browserId ? { browserId: shell.browserId } : {}),
        ...(shell.browserGeneration ? { browserGeneration: shell.browserGeneration } : {}),
        lifecycle: shell.lifecycle,
        origin: shell.origin,
        restoreUrl: shell.restoreUrl,
        title: shell.title,
        faviconUrl: shell.faviconUrl,
        viewport: shell.viewport ? { ...shell.viewport } : null,
        openedAt: shell.openedAt,
        lastSelectedAt: shell.lastSelectedAt,
      }))
    },
    async getPageState(tabId: string): Promise<BrowserPageStateSnapshot | undefined> {
      await load()
      const pageState = pageStates.get(tabId)
      return pageState ? { ...pageState, entries: pageState.entries.map(entry => ({ ...entry })) } : undefined
    },
    async upsertPageState(snapshot: BrowserPageStateSnapshot): Promise<void> {
      await load()
      pageStates.set(snapshot.tabId, snapshot)
      scheduleSave()
    },
    async removePageState(tabId: string): Promise<void> {
      await load()
      if (pageStates.delete(tabId)) scheduleSave()
    },
    async whenIdle(): Promise<void> {
      await load()
      await flush()
    },
    flushNow: () => flush(),
  }
}
