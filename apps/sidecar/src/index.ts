import { argv, stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/system/workspace-watcher";
import { seedDefaultSkills } from "./services/skills/default-skills-seeder";
import { initProxySettings } from "./services/system/proxy-settings-manager";
import {
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation/automation-runner-service";
import {
  setReadingCadenceNotificationWriter,
  startReadingCadenceRunner,
  stopReadingCadenceRunner
} from "./services/reading/reading-cadence-runner";
import { getWorkspaceMcpManager } from "./services/mcp/workspace-mcp-manager";
import { imRuntimeManager } from "./services/im/im-runtime-manager";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { subscribeSubagentAnnounceEvent } from "./services/agent/subagents/subagent-announce-service";
import { createRpcHandlers } from "./rpc/create-rpc-handlers";
import { cleanupExpiredTrash } from "./services/agent/agent-thread-manager";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc/types";
import { formatConsoleArgs } from "./services/infra/log-format";
import { writeLogRecord } from "./services/infra/logger";

// JSON-RPC 使用 stdout 作为协议通道，业务日志统一输出到 stderr，避免污染响应流。
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

function writeResponse(response: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function writeNotification(method: string, params: unknown): void {
  stdout.write(`${JSON.stringify({ method, params })}\n`);
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
    setReadingCadenceNotificationWriter(writeNotification);
    void startReadingCadenceRunner().catch((error) => {
      console.error(`[读书 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
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
  const stopWatcher = (): void => {
    unsubscribeSubagentAnnounce();
    stopWorkspaceWatcher();
    void getWorkspaceMcpManager().disposeAll().catch(() => {});
    void stopAutomationRunner().catch(() => {});
    void stopReadingCadenceRunner().catch(() => {});
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

  stdin.setEncoding("utf8");
  const rl = createInterface({
    input: stdin,
    crlfDelay: Infinity
  });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleRpcLine(trimmed);
  });
}

void boot();
