
import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { AGENT_IPC_CHANNELS, LUME_CONFIG_IPC_CHANNELS, MEMORY_IPC_CHANNELS } from "@lume/shared";
import { listAgentWorkspaces } from "../agent/agent-workspace-manager";
import { getAgentWorkspacesDir, getConfigDir, getLumeConfigYamlPath, getStructuredMemoryDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";

type NotificationEmitter = (method: string, params: unknown) => void;

const DEBOUNCE_MS = 500;
const log = createLogger("workspace-watcher");

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

  const emitFilesChanged = (): void => {
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
      // review P1:Windows 下被监视目录被删/移走会向 error 事件报 EPERM,
      // 无监听器即同步 throw 进进程级 uncaught 兜底(累计 5 次退出止损)。
      // 吞掉记日志:该路径信号失效可接受,不得威胁 sidecar 存活。
      watcher.on("error", (error) => {
        log.warn("workspace watcher error", { label, targetPath, error: String(error) });
      });
      watchers.push(watcher);
      log.debug("watching workspace path", { label, targetPath });
    } catch (error) {
      log.error("failed to watch workspace path", { error, label, targetPath });
    }
  };

  safeWatch(watchDir, { recursive: true }, onWorkspaceChanged, "Lume 工作区");
  // #590:project 型工作区根在任意盘位，不在托管目录监视内——git pull/切分支/
  // 外部编辑对文件树零信号，树与 agent 的活磁盘认知分叉。逐个监视真实根目录，
  // 变更并入同一条 WORKSPACE_FILES_CHANGED 通道。ponytail: 工作区列表为启动时
  // 快照，中途新增的项目工作区重启后覆盖；已删路径的残留 watcher 静默无事件。
  for (const workspace of listAgentWorkspaces()) {
    const projectPath = workspace.projectPath?.trim();
    if (!projectPath) continue;
    safeWatch(projectPath, { recursive: true }, () => emitFilesChanged(), `project 工作区 ${workspace.slug}`);
  }
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
    log.warn("no workspace paths are available to watch");
    return;
  }

  try {
    // 保持与旧逻辑一致：启动后输出一次汇总日志
    log.info("workspace file watcher started", { watcherCount: watchers.length });
  } catch (error) {
    log.error("workspace file watcher failed to start", { error });
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
  log.info("workspace file watcher stopped");
}
