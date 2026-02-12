/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\workspace-watcher.ts
 * Adaptation:
 * - Replaced Electron webContents.send with sidecar notification emitter callback.
 * - Watch target switched to Lume sidecar workspace path utility.
 */

import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { getAgentWorkspacesDir } from "./config-paths";

type NotificationEmitter = (method: string, params: unknown) => void;

const DEBOUNCE_MS = 500;

let watcher: FSWatcher | null = null;
let capabilitiesTimer: ReturnType<typeof setTimeout> | null = null;
let filesTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (capabilitiesTimer) {
    clearTimeout(capabilitiesTimer);
    capabilitiesTimer = null;
  }
  if (filesTimer) {
    clearTimeout(filesTimer);
    filesTimer = null;
  }
}

export function startWorkspaceWatcher(emit: NotificationEmitter): void {
  const watchDir = getAgentWorkspacesDir();
  if (!existsSync(watchDir)) {
    console.warn("[工作区监听] 目录不存在，跳过:", watchDir);
    return;
  }

  try {
    watcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const normalized = String(filename).replace(/\\/g, "/");
      const isCapabilitiesChange =
        normalized.endsWith("/mcp.json") || normalized.includes("/skills/");

      if (isCapabilitiesChange) {
        if (capabilitiesTimer) clearTimeout(capabilitiesTimer);
        capabilitiesTimer = setTimeout(() => {
          emit(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
          capabilitiesTimer = null;
        }, DEBOUNCE_MS);
        return;
      }

      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(() => {
        emit(AGENT_IPC_CHANNELS.WORKSPACE_FILES_CHANGED, {});
        filesTimer = null;
      }, DEBOUNCE_MS);
    });

    console.log("[工作区监听] 已启动文件监听:", watchDir);
  } catch (error) {
    console.error("[工作区监听] 启动失败:", error);
  }
}

export function stopWorkspaceWatcher(): void {
  clearTimers();
  if (!watcher) return;
  watcher.close();
  watcher = null;
  console.log("[工作区监听] 已停止");
}

