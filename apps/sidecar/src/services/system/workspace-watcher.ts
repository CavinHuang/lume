
import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { AGENT_IPC_CHANNELS, LUME_CONFIG_IPC_CHANNELS, MEMORY_IPC_CHANNELS } from "@lume/shared";
import { getAgentWorkspacesDir, getConfigDir, getLumeConfigYamlPath, getStructuredMemoryDir } from "../infra/config-paths";

type NotificationEmitter = (method: string, params: unknown) => void;

const DEBOUNCE_MS = 500;

let watchers: FSWatcher[] = [];
let capabilitiesTimer: ReturnType<typeof setTimeout> | null = null;
let filesTimer: ReturnType<typeof setTimeout> | null = null;
let memoryTimer: ReturnType<typeof setTimeout> | null = null;
let lumeConfigTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (capabilitiesTimer) {
    clearTimeout(capabilitiesTimer);
    capabilitiesTimer = null;
  }
  if (filesTimer) {
    clearTimeout(filesTimer);
    filesTimer = null;
  }
  if (memoryTimer) {
    clearTimeout(memoryTimer);
    memoryTimer = null;
  }
  if (lumeConfigTimer) {
    clearTimeout(lumeConfigTimer);
    lumeConfigTimer = null;
  }
}

export function startWorkspaceWatcher(emit: NotificationEmitter): void {
  const watchDir = getAgentWorkspacesDir();
  const onWorkspaceChanged = (_eventType: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const normalized = String(filename).replace(/\\/g, "/");
    if (normalized === "memory" || normalized.startsWith("memory/") || normalized.includes("/memory/")) {
      emitMemoryChanged();
      return;
    }
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

  const emitMemoryChanged = (): void => {
    if (memoryTimer) clearTimeout(memoryTimer);
    memoryTimer = setTimeout(() => {
      emit(MEMORY_IPC_CHANNELS.SOURCE_FILES_CHANGED, {});
      memoryTimer = null;
    }, DEBOUNCE_MS);
  };

  const emitGlobalCapabilitiesChanged = (): void => {
    if (capabilitiesTimer) clearTimeout(capabilitiesTimer);
    capabilitiesTimer = setTimeout(() => {
      emit(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
      capabilitiesTimer = null;
    }, DEBOUNCE_MS);
  };

  const emitLumeConfigChanged = (): void => {
    if (lumeConfigTimer) clearTimeout(lumeConfigTimer);
    lumeConfigTimer = setTimeout(() => {
      emit(LUME_CONFIG_IPC_CHANNELS.CHANGED, {});
      lumeConfigTimer = null;
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
  safeWatch(getStructuredMemoryDir(), { recursive: true }, () => emitMemoryChanged(), "Lume 全局记忆目录");
  safeWatch(getConfigDir(), { recursive: false }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = String(filename).replace(/\\/g, "/").toLowerCase();
    if (normalized === "lume.yaml" || normalized.endsWith("/lume.yaml")) {
      emitLumeConfigChanged();
    }
  }, "Lume 全局配置目录");
  safeWatch(getLumeConfigYamlPath(), {}, () => emitLumeConfigChanged(), "Lume 全局配置文件");
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
