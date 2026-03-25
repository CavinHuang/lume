import { argv, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { ChannelGatewayIngressStatus } from "@lume/shared";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/system/workspace-watcher";
import { startMemorySyncWatcher, stopMemorySyncWatcher } from "./services/memory/memory-sync-watcher";
import { startChatToolsWatcher, stopChatToolsWatcher } from "./services/chat/chat-tools-watcher";
import { seedDefaultSkills } from "./services/system/default-skills-seeder";
import { startRelayServer, stopRelayServer } from "./services/browser/extension-relay";
import { initProxySettings } from "./services/system/proxy-settings-manager";
import {
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation/automation-runner-service";
import {
  getFeishuGatewayConfig,
} from "./services/channel-gateway/feishu-config-manager";
import {
  startFeishuIngressServer,
  stopFeishuIngressServer
} from "./services/channel-gateway/feishu-ingress-service";
import {
  startFeishuWsIngressServer,
  stopFeishuWsIngressServer
} from "./services/channel-gateway/feishu-ws-ingress-service";
import {
  startFeishuRetryWorker,
  stopFeishuRetryWorker
} from "./services/channel-gateway/feishu-retry-worker";
import { subscribeSubagentAnnounceEvent } from "./services/pi-agent/subagents/subagent-announce-bus";
import { createRpcHandlers } from "./rpc/create-rpc-handlers";
import { closeMemoryManagers } from "./rpc/memory-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc/types";

// JSON-RPC 使用 stdout 作为协议通道，业务日志统一输出到 stderr，避免污染响应流。
console.log = (...args: unknown[]) => {
  console.error(...args);
};

function writeResponse(response: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function writeNotification(method: string, params: unknown): void {
  stdout.write(`${JSON.stringify({ method, params })}\n`);
}
const handlers = createRpcHandlers({ writeNotification });

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

function boot(): void {
  console.error(`[sidecar] booted (pid=${process.pid}) args=${argv.slice(2).join(" ")}`);
  const relayAutostart = process.env.LUME_BROWSER_RELAY_AUTOSTART?.toLowerCase() !== "0";
  void initProxySettings().catch((error) => {
    console.error(`[代理配置] 启动初始化失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (relayAutostart) {
    void startRelayServer().then(({ port }) => {
      console.error(`[浏览器 Relay] 已启动: http://127.0.0.1:${port}/`);
    }).catch((error) => {
      console.error(`[浏览器 Relay] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const channelIngressAutostart = process.env.LUME_CHANNEL_GATEWAY_AUTOSTART?.toLowerCase() !== "0";
  if (channelIngressAutostart) {
    const channelConfig = getFeishuGatewayConfig();
    if (channelConfig.connectionMode === "websocket") {
      void startFeishuWsIngressServer().then((status: ChannelGatewayIngressStatus) => {
        console.error(`[渠道网关] 飞书 WebSocket 已启动: connected=${status.wsConnected}`);
      }).catch((error: unknown) => {
        console.error(`[渠道网关] 飞书 WebSocket 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      void startFeishuIngressServer().then((status: ChannelGatewayIngressStatus) => {
        console.error(`[渠道网关] 飞书 webhook 已启动: ${status.webhookUrl ?? "unknown"}`);
      }).catch((error: unknown) => {
        console.error(`[渠道网关] 飞书 webhook 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  startFeishuRetryWorker();
  void startAutomationRunner().catch((error) => {
    console.error(`[自动化 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  seedDefaultSkills();
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  startMemorySyncWatcher();
  startChatToolsWatcher((method, params) => writeNotification(method, params));
  const unsubscribeSubagentAnnounce = subscribeSubagentAnnounceEvent((event) => {
    writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
  });
  const stopWatcher = (): void => {
    unsubscribeSubagentAnnounce();
    stopWorkspaceWatcher();
    stopMemorySyncWatcher();
    stopChatToolsWatcher();
    closeMemoryManagers();
    void stopAutomationRunner().catch(() => {});
    void stopRelayServer().catch(() => {});
    void stopFeishuIngressServer().catch(() => {});
    void stopFeishuWsIngressServer().catch(() => {});
    stopFeishuRetryWorker();
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

boot();
