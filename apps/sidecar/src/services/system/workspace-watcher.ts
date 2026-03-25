/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\workspace-watcher.ts
 * Adaptation:
 * - Replaced Electron webContents.send with sidecar notification emitter callback.
 * - Watch target switched to Lume sidecar workspace path utility.
 */

import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { getAgentWorkspacesDir } from "../infra/config-paths";

type NotificationEmitter = (method: string, params: unknown) => void;

const DEBOUNCE_MS = 500;

const claudeRoot = join(homedir(), ".claude");
const claudeJsonPath = join(homedir(), ".claude.json");
const claudePluginPath = join(claudeRoot, "plugins");
const claudeSkillsPath = join(claudeRoot, "skills");

let watchers: FSWatcher[] = [];
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
  const onWorkspaceChanged = (_eventType: string, filename: string | Buffer | null): void => {
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
  };

  const emitGlobalCapabilitiesChanged = (): void => {
    if (capabilitiesTimer) clearTimeout(capabilitiesTimer);
    capabilitiesTimer = setTimeout(() => {
      emit(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
      capabilitiesTimer = null;
    }, DEBOUNCE_MS);
  };

  const safeWatch = (
    targetPath: string,
    options: { recursive?: boolean },
    onChange: (eventType: string, filename: string | Buffer | null) => void,
    label: string
  ): void => {
    if (!existsSync(targetPath)) {
      return;
    }
    try {
      const watcher = watch(targetPath, options, onChange);
      watchers.push(watcher);
      console.log(`[工作区监听] 已监听 ${label}: ${targetPath}`);
    } catch (error) {
      console.error(`[工作区监听] 监听 ${label} 失败:`, error);
    }
  };

  safeWatch(watchDir, { recursive: true }, onWorkspaceChanged, "Lume 工作区");
  safeWatch(claudeRoot, { recursive: true }, () => emitGlobalCapabilitiesChanged(), "Claude 全局目录");
  safeWatch(claudeJsonPath, {}, () => emitGlobalCapabilitiesChanged(), "Claude 全局配置");
  safeWatch(claudePluginPath, { recursive: true }, () => emitGlobalCapabilitiesChanged(), "Claude 插件目录");
  safeWatch(claudeSkillsPath, { recursive: true }, () => emitGlobalCapabilitiesChanged(), "Claude Skills 目录");

  if (watchers.length === 0) {
    console.warn("[工作区监听] 未找到可监听目录，已跳过监听初始化");
    return;
  }

  try {
    // 保持与旧逻辑一致：启动后输出一次汇总日志
    console.log("[工作区监听] 文件监听已启动");
  } catch (error) {
    console.error("[工作区监听] 启动失败:", error);
  }
}

export function stopWorkspaceWatcher(): void {
  clearTimers();
  if (watchers.length === 0) return;
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // 忽略单个 watcher 关闭异常
    }
  }
  watchers = [];
  console.log("[工作区监听] 已停止");
}
