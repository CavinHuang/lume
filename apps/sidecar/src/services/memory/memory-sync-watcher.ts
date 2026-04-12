import { existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { getAgentWorkspacesDir, getConfigDir, getGlobalMemoryPath } from "../infra/config-paths";
import { syncGlobalMemoryPath, syncWorkspaceMemoryPath } from "./memory-service";

const MEMORY_DEBOUNCE_MS = 1500;

let watcher: FSWatcher | null = null;
let globalWatcher: FSWatcher | null = null;
let pending = new Map<string, ReturnType<typeof setTimeout>>();
let globalPending: ReturnType<typeof setTimeout> | null = null;

function clearPending(): void {
  for (const timer of pending.values()) {
    clearTimeout(timer);
  }
  pending.clear();
  if (globalPending) {
    clearTimeout(globalPending);
    globalPending = null;
  }
}

function scheduleSync(relativeFilename: string): void {
  const normalized = relativeFilename.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const workspaceSlug = parts[0];
  if (!workspaceSlug) return;

  const absPath = resolve(getAgentWorkspacesDir(), normalized);
  const key = `${workspaceSlug}:${normalized}`;

  const prev = pending.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(() => {
    pending.delete(key);
    void syncWorkspaceMemoryPath({
        workspaceSlug,
        absolutePath: absPath
      }).catch((error) => {
        console.warn("[记忆监听] 同步变更失败:", error);
      });
  }, MEMORY_DEBOUNCE_MS);

  pending.set(key, timer);
}

function scheduleGlobalSync(): void {
  if (globalPending) clearTimeout(globalPending);
  globalPending = setTimeout(() => {
    globalPending = null;
    void syncGlobalMemoryPath({
      absolutePath: getGlobalMemoryPath()
    }).catch((error) => {
      console.warn("[记忆监听] 同步全局记忆失败:", error);
    });
  }, MEMORY_DEBOUNCE_MS);
}

export function startMemorySyncWatcher(): void {
  const root = getAgentWorkspacesDir();
  if (!existsSync(root)) return;
  if (watcher) return;

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const relativeFilename = String(filename);
      const normalized = relativeFilename.replace(/\\/g, "/");
      if (
        normalized.endsWith("/MEMORY.md") ||
        (normalized.includes("/memory/") && normalized.endsWith(".md"))
      ) {
        scheduleSync(relativeFilename);
      }
    });
    globalWatcher = watch(getConfigDir(), { recursive: false }, (_event, filename) => {
      if (!filename) return;
      const normalized = String(filename).replace(/\\/g, "/");
      if (normalized === "MEMORY.md" || normalized.endsWith("/MEMORY.md")) {
        scheduleGlobalSync();
      }
    });
    console.log("[记忆监听] 已启动");
  } catch (error) {
    console.warn("[记忆监听] 启动失败:", error);
  }
}

export function stopMemorySyncWatcher(): void {
  clearPending();
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // ignore
  }
  watcher = null;
  if (globalWatcher) {
    try {
      globalWatcher.close();
    } catch {
      // ignore
    }
    globalWatcher = null;
  }
}
