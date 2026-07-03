import { argv, stderr } from "node:process";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/system/workspace-watcher";
import { seedDefaultSkills } from "./services/skills/default-skills-seeder";
import { initProxySettings } from "./services/system/proxy-settings-manager";
import {
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation/automation-runner-service";
import { getWorkspaceMcpManager } from "./services/mcp/workspace-mcp-manager";
import { imRuntimeManager } from "./services/im/im-runtime-manager";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { subscribeSubagentAnnounceEvent } from "./services/agent/subagents/subagent-announce-service";
import { createRpcHandlers } from "./rpc/create-rpc-handlers";
import { cleanupExpiredTrash, subscribeThreadListChanged } from "./services/agent/agent-thread-manager";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc/types";
import { formatConsoleArgs } from "./services/infra/log-format";
import { setLogRecordNotificationWriter, writeLogRecord } from "./services/infra/logger";
import { assertSidecarNativeRuntime } from "./services/infra/native-runtime";
import { createProcessRpcTransport } from "./rpc/process-transport";

const rpcTransport = createProcessRpcTransport();

function writeResponse(response: JsonRpcResponse): void {
  rpcTransport.send(JSON.stringify(response));
}

function writeNotification(method: string, params: unknown): void {
  rpcTransport.send(JSON.stringify({ method, params }));
}

if ((process as typeof process & { parentPort?: unknown }).parentPort) {
  setLogRecordNotificationWriter((record) => writeNotification("system.log", record));
}

// JSON-RPC 使用 Electron parentPort 或 stdio，业务日志统一输出到 stderr。
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    const line = formatConsoleArgs({
      source: "sidecar",
      context: "app",
      args
    });
    stderr.write(`${line}\n`);
    writeLogRecord({
      level: level === "log" ? "info" : level,
      context: "console",
      message: line
    });
  };
}
const handlers = createRpcHandlers({ writeNotification });

function envAutostartEnabled(key: string, defaultEnabled: boolean): boolean {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim() === "") {
    return defaultEnabled;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

async function handleRpcLine(line: string): Promise<void> {
  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeResponse({
      error: { code: "E_BAD_JSON", message: "Invalid JSON payload." }
    });
    return;
  }

  const method = payload.method;
  if (!method) {
    writeResponse({
      id: payload.id,
      error: {
        code: "E_BAD_REQUEST",
        message: "Missing method."
      }
    });
    return;
  }

  const handler = handlers[method];
  if (!handler) {
    writeResponse({
      id: payload.id,
      error: {
        code: "E_NOT_IMPLEMENTED",
        message: `Method not implemented: ${method}`
      }
    });
    return;
  }

  try {
    console.error(`[sidecar] rpc_in method=${method} id=${String(payload.id)}`);
    const result = await handler(payload.params);
    console.error(`[sidecar] rpc_out ok method=${method} id=${String(payload.id)}`);
    writeResponse({ id: payload.id, result });
  } catch (error) {
    console.error(`[sidecar] rpc_out err method=${method} id=${String(payload.id)} error=${error instanceof Error ? error.message : String(error)}`);
    writeResponse({
      id: payload.id,
      error: {
        code: "E_RPC",
        message: error instanceof Error ? error.message : "Unknown sidecar error"
      }
    });
  }
}

async function boot(): Promise<void> {
  console.error(`[sidecar] booted (pid=${process.pid}) args=${argv.slice(2).join(" ")}`);
  const native = assertSidecarNativeRuntime();
  console.error(`[sidecar] native ready capabilities=${native.capabilities.join(",")}`);
  void initProxySettings().catch((error) => {
    console.error(`[代理配置] 初始化失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (envAutostartEnabled("LUME_AUTOMATION_RUNNER_AUTOSTART", false)) {
    const { setAutomationNotificationWriter } = await import("./services/automation/automation-runner-service");
    setAutomationNotificationWriter(writeNotification);
    void startAutomationRunner().catch((error) => {
      console.error(`[自动化 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (envAutostartEnabled("LUME_READING_RUNNER_AUTOSTART", true)) {
    const { startRoutineRunner } = await import("./services/routine/routine-runner");
    void startRoutineRunner().catch((error) => {
      console.error(`[日程 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (envAutostartEnabled("LUME_DEFAULT_SKILLS_AUTOSTART", false)) {
    seedDefaultSkills();
  }
  if (envAutostartEnabled("LUME_IM_AUTOSTART", true)) {
    void imRuntimeManager.startEnabledAccounts().catch((error) => {
      console.error(`[IM Runtime] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  // 启动时清理过期回收站条目
  try { cleanupExpiredTrash(); } catch { /* non-critical */ }
  const unsubscribeSubagentAnnounce = subscribeSubagentAnnounceEvent((event) => {
    writeNotification(AGENT_IPC_CHANNELS.SUBAGENT_COMPLETED, event);
  });
  const unsubscribeThreadListChanged = subscribeThreadListChanged(() => {
    writeNotification(AGENT_IPC_CHANNELS.THREAD_LIST_CHANGED, null);
  });
  const stopWatcher = (): void => {
    unsubscribeSubagentAnnounce();
    unsubscribeThreadListChanged();
    stopWorkspaceWatcher();
    void getWorkspaceMcpManager().disposeAll().catch(() => {});
    void stopAutomationRunner().catch(() => {});
    const { stopRoutineRunner } = require("./services/routine/routine-runner");
    stopRoutineRunner();
    imRuntimeManager.stopAll();
  };
  process.once("exit", stopWatcher);
  process.once("SIGINT", () => {
    stopWatcher();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stopWatcher();
    process.exit(0);
  });

  rpcTransport.listen((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleRpcLine(trimmed);
  });
  writeNotification("system.ready", { native });
}

void boot().catch((error) => {
  console.error(`[sidecar] boot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
