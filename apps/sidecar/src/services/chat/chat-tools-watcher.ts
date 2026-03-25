import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { CHAT_TOOL_IPC_CHANNELS } from "@lume/shared";
import { getChatToolsPath, getConfigDir } from "../infra/config-paths";

type NotificationEmitter = (method: string, params: unknown) => void;

const DEBOUNCE_MS = 500;

let watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmit(emit: NotificationEmitter): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    emit(CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED, {
      toolId: "*",
      changeType: "external"
    });
    debounceTimer = null;
  }, DEBOUNCE_MS);
}

export function startChatToolsWatcher(emit: NotificationEmitter): void {
  if (watchers.length > 0) return;

  const filePath = getChatToolsPath();
  const fileName = basename(filePath);
  const configDir = getConfigDir();

  try {
    const dirWatcher = watch(configDir, {}, (_eventType, filename) => {
      if (!filename) return;
      if (String(filename) !== fileName) return;
      scheduleEmit(emit);
    });
    watchers.push(dirWatcher);
  } catch (error) {
    console.warn("[Chat 工具监听] 监听配置目录失败:", error);
  }

  if (existsSync(filePath)) {
    try {
      const fileWatcher = watch(filePath, {}, () => {
        scheduleEmit(emit);
      });
      watchers.push(fileWatcher);
    } catch (error) {
      console.warn("[Chat 工具监听] 监听工具配置文件失败:", error);
    }
  }

  if (watchers.length === 0) {
    console.warn("[Chat 工具监听] 未启动任何 watcher");
  }
}

export function stopChatToolsWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (watchers.length === 0) return;
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore watcher close error
    }
  }
  watchers = [];
}
