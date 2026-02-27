import { existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { getAgentWorkspacesDir } from "./config-paths";
import { syncWorkspaceMemoryPath } from "./memory-service";

const MEMORY_DEBOUNCE_MS = 1500;

let watcher: FSWatcher | null = null;
let pending = new Map<string, ReturnType<typeof setTimeout>>();

function clearPending(): void {
  for (const timer of pending.values()) {
    clearTimeout(timer);
  }
  pending.clear();
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
        normalized.endsWith("/memory.md") ||
        (normalized.includes("/memory/") && normalized.endsWith(".md"))
      ) {
        scheduleSync(relativeFilename);
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
}
