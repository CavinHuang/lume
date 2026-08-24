import { argv } from "node:process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/system/workspace-watcher";
import { seedDefaultSkills } from "./services/skills/default-skills-seeder";
import { initProxySettings } from "./services/system/proxy-settings-manager";
import {
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation/automation-runner-service";
import { getWorkspaceMcpManager } from "./services/mcp/workspace-mcp-manager";
import { imRuntimeManager } from "./services/im/im-runtime-manager";
import { AGENT_IPC_CHANNELS, BROWSER_HANDLER_WAIT_CAP_MS } from "@lume/shared";
import { subscribeSubagentAnnounceEvent } from "./services/agent-runtime/subagents/subagent-announce-service";
import { createRpcHandlers } from "./rpc/create-rpc-handlers";
import { cleanupExpiredTrash, subscribeThreadListChanged } from "./services/agent/agent-thread-manager";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc/types";
import {
  acknowledgeLogBatch,
  flushLogTransport,
  setLogBatchNotificationWriter,
  writeEmergencyLog,
  writeLogRecord
} from "./services/infra/logger";
import { assertSidecarNativeRuntime } from "./services/infra/native-runtime";
import { createProcessRpcTransport, MAX_RPC_MESSAGE_BYTES } from "./rpc/process-transport";
import { browserRpcErrorFromPayload, classifyBrowserRpcResponse } from "./rpc/browser-rpc-sequence";
import { createReverseRpcRenderClient } from "./services/agent-runtime/tools/web/reverse-rpc-render-client";
import { setSidecarRenderClient } from "./services/agent-runtime/tools/web/render-client-holder";
import { setPersistedSettingsMutationWriter } from "./services/system/settings-store";
import { setLogDigestPolicy } from "./services/infra/log-digest";
import type { LumeLogDigestPolicy } from "@lume/shared";
import { installPrivilegedCredential } from "./services/infra/privileged-auth";
import { installConnectionVaultKey } from "./services/channel/connection-credential-store";
import { createBrowserBroker } from "./services/browser/browser-broker";
import { setActiveBrowserBroker } from "./services/browser/browser-broker-holder";
import { ExternalChromeTransport } from "./services/browser/external-chrome-transport";
import { startBackgroundProcessRecovery } from "./services/agent/background-process-recovery";
import { closePlanningTodoStore } from "./services/planning/planning-todo-store";
import { reconcilePlanningStartOperations } from "./services/planning/planning-start-service";
import { closePlanningCalendarStore } from "./services/planning/planning-calendar-store";
import { startPlanningReminderScheduler, stopPlanningReminderScheduler } from "./services/planning/planning-reminder-scheduler";
import { getNodeReplRuntimeRegistry } from "./services/agent-runtime/tools/node-repl/node-repl-runtime-registry";
import { installRuntimeHostPorts } from "./services/agent/agent-runtime-ports-binding";

// 组合根最先注入 agent-runtime 的宿主端口(#289):任何 RPC/服务调用之前。
installRuntimeHostPorts();

const rpcTransport = createProcessRpcTransport(
  process.env.LUME_SIDECAR_TRANSPORT === "stdio" ? { parentPort: null } : undefined,
);
const SETTINGS_ACK_TIMEOUT_MS = 10_000;
// 容纳 desktop 最长常规请求:handler 上限 BROWSER_HANDLER_WAIT_CAP_MS(shared
// 单源)+ 非 guest-optional 方法先吃的 waitForGuest ≤10s + RPC 余量。desktop 的
// navigate/打字/批量串行已各自有界(#638),browserAuth 入确认级长等待档。
const BROWSER_REQUEST_TIMEOUT_MS = BROWSER_HANDLER_WAIT_CAP_MS + 15_000;
const BROWSER_CONFIRMATION_TIMEOUT_MS = 5 * 60_000;
const pendingSettingsMutations = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
const pendingBrowserMainRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
const browserRpcSecret = process.env.LUME_BROWSER_RPC_SECRET ? Buffer.from(process.env.LUME_BROWSER_RPC_SECRET, "base64url") : null;
let browserRpcOutboundSequence = 0;
let browserRpcInboundSequence = 0;

function writeResponse(response: JsonRpcResponse): void {
  rpcTransport.send(JSON.stringify(response));
}

function writeNotification(method: string, params: unknown): void {
  rpcTransport.send(JSON.stringify({ method, params }));
}

function requestBrowserMain(request: import("@lume/shared").BrowserActionRequest): Promise<unknown> {
  if (!browserRpcSecret) return Promise.reject(new Error("browser transport unavailable"));
  return new Promise((resolve, reject) => {
    const sequence = ++browserRpcOutboundSequence;
    // policy:confirm 等用户在弹窗操作;tab_browser_auth_request(browserAuth
    // 凭据窗)同样等用户输入,desktop 侧 expiresAt 允许至 +5min。
    const timeoutMs = request.method === "policy:confirm" || request.method === "tab_browser_auth_request"
      ? BROWSER_CONFIRMATION_TIMEOUT_MS
      : BROWSER_REQUEST_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      pendingBrowserMainRequests.delete(request.requestId);
      // 请求已送达 desktop，变更型动作可能已执行——不能与"未执行"塌缩为同一错误码
      // 确认类等待超时=用户未在时限内裁决,动作必然未执行、desktop 弹窗仍开着,
      // 报 executed_unknown 是双重误导(#606 review)
      if (request.method === "policy:confirm" || request.method === "tab_browser_auth_request") {
        reject(Object.assign(new Error("confirmation timed out"), { code: "confirmation_timeout" }));
        return;
      }
      reject(Object.assign(new Error("browser request timed out"), { code: "executed_unknown" }));
    }, timeoutMs);
    pendingBrowserMainRequests.set(request.requestId, { resolve, reject, timeout });
    rpcTransport.send(JSON.stringify({
      id: request.requestId,
      method: "browser:request",
      params: request,
      browserRpc: { sequence, mac: browserRpcMac("sidecar->main", sequence, request.requestId, request) }
    }));
  });
}

function browserRpcMac(direction: "sidecar->main" | "main->sidecar", sequence: number, id: string, body: unknown): string {
  if (!browserRpcSecret) throw new Error("browser transport unavailable");
  return createHmac("sha256", browserRpcSecret)
    .update(`${direction}|${sequence}|${id}|${JSON.stringify(body)}`)
    .digest("base64url");
}

function verifyBrowserRpcMac(direction: "sidecar->main" | "main->sidecar", sequence: number, id: string, body: unknown, mac: unknown): boolean {
  if (typeof mac !== "string" || !browserRpcSecret) return false;
  const expected = Buffer.from(browserRpcMac(direction, sequence, id, body));
  const actual = Buffer.from(mac);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

if ((process as typeof process & { parentPort?: unknown }).parentPort) {
  setLogBatchNotificationWriter((batch) => writeNotification("system.log-batch", batch));
  setPersistedSettingsMutationWriter((settings) => new Promise<void>((resolve, reject) => {
    const mutationId = randomUUID();
    const timeout = setTimeout(() => {
      pendingSettingsMutations.delete(mutationId);
      reject(new Error("desktop settings persistence acknowledgement timed out"));
    }, SETTINGS_ACK_TIMEOUT_MS);
    pendingSettingsMutations.set(mutationId, { resolve, reject, timeout });
    try {
      writeNotification("system.settings-replace", { mutationId, settings });
    } catch (error) {
      clearTimeout(timeout);
      pendingSettingsMutations.delete(mutationId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }));
}

const QUIET_RPC_METHODS = new Set([
  "healthcheck",
  "general-settings:get",
  "agent:list-threads",
  "agent:list-subagent-runs",
  "agent:get-pending-interactive",
  "agent:list-workspaces",
  "model-meta:get"
]);
const SLOW_RPC_MS = 2_000;
// Process-wide reverse-RPC render client. Bridges WebFetch JS-render requests
// to the desktop PageRenderer. Fed into BOTH the RPC handlers (so render:result
// resolves pending renders) and the agent runtime (so WebFetch can invoke it).
const renderClient = createReverseRpcRenderClient({ sendNotification: writeNotification });
setSidecarRenderClient(renderClient);
const externalChromeTransport = process.env.LUME_CHROME_BRIDGE_ENDPOINT && process.env.LUME_CHROME_BRIDGE_PAIRING_ID && process.env.LUME_CHROME_BRIDGE_GENERATION && process.env.LUME_CHROME_BRIDGE_HOST_PATH && process.env.LUME_CHROME_BRIDGE_HOST_SHA256
  ? new ExternalChromeTransport({
    // 与内置后端同治:不传会落回默认 10s,extension 后端的 30s 等待同样被先杀误报(#603)
    requestTimeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
    endpoint: process.env.LUME_CHROME_BRIDGE_ENDPOINT,
    pairingId: process.env.LUME_CHROME_BRIDGE_PAIRING_ID,
    generation: Number(process.env.LUME_CHROME_BRIDGE_GENERATION),
    hostPath: process.env.LUME_CHROME_BRIDGE_HOST_PATH,
    hostSha256: process.env.LUME_CHROME_BRIDGE_HOST_SHA256,
    onStateChange: (state) => {
      browserBroker?.setExternalState({ hostConnected: state.connected });
      writeNotification("browser:backend-state", state);
    },
  })
  : undefined;
const browserBroker = createBrowserBroker({ request: requestBrowserMain }, externalChromeTransport, (state) => {
  writeNotification("browser:backend-state", state);
});
void externalChromeTransport?.start().catch((error) => {
  writeNotification("browser:backend-state", { connected: false, error: error instanceof Error ? error.message : "bridge unavailable" });
});
setActiveBrowserBroker(browserBroker);
const handlers = createRpcHandlers({ writeNotification, renderClient, browserBroker });

function envAutostartEnabled(key: string, defaultEnabled: boolean): boolean {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim() === "") {
    return defaultEnabled;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

async function handleRpcLine(line: string): Promise<void> {
  // 统一 chokepoint：超限消息不进 JSON.parse（防解析期超量内存分配）
  if (line.length > MAX_RPC_MESSAGE_BYTES) {
    writeResponse({
      error: { code: "E_MESSAGE_TOO_LARGE", message: "RPC message exceeds size limit." }
    });
    return;
  }
  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeResponse({
      error: { code: "E_BAD_JSON", message: "Invalid JSON payload." }
    });
    return;
  }

  if (payload.id !== undefined && !payload.method) {
    const responsePayload = payload as JsonRpcResponse & { browserRpc?: { sequence?: unknown; mac?: unknown } };
    const sequence = responsePayload.browserRpc?.sequence;
    const mac = responsePayload.browserRpc?.mac;
    const body = responsePayload.error ? { ok: false, error: responsePayload.error.code } : { ok: true, result: responsePayload.result };
    const macOk = typeof sequence === "number" && verifyBrowserRpcMac("main->sidecar", sequence, String(payload.id), body, mac);
    const verdict = classifyBrowserRpcResponse(typeof sequence === "number" ? sequence : 0, macOk, browserRpcInboundSequence);
    if (verdict === "advance") browserRpcInboundSequence = sequence as number;
    const pending = pendingBrowserMainRequests.get(String(payload.id));
    if (!pending) return; // 迟到响应（请求已超时删除）：advance 已治愈序列号，丢弃结果
    clearTimeout(pending.timeout);
    pendingBrowserMainRequests.delete(String(payload.id));
    if (verdict === "reject-pending") {
      pending.reject(new Error("browser transport authentication failed"));
      return;
    }
    const response = responsePayload;
    if (response.error) pending.reject(browserRpcErrorFromPayload(response.error));
    else pending.resolve(response.result);
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

  if (method === "system.log-ack") {
    const batchId = (payload.params as { batchId?: unknown } | null)?.batchId;
    if (typeof batchId === "string") acknowledgeLogBatch(batchId);
    return;
  }

  if (method === "system.logging-policy") {
    setLogDigestPolicy(payload.params as LumeLogDigestPolicy);
    return;
  }

  if (method === "system.privileged-credential") {
    installPrivilegedCredential((payload.params as { credential?: unknown } | null)?.credential);
    return;
  }

  if (method === "system.connection-vault-key") {
    installConnectionVaultKey((payload.params as { key?: unknown } | null)?.key);
    if (payload.id !== undefined) writeResponse({ id: payload.id, result: { ok: true } });
    return;
  }

  if (method === "system.settings-ack") {
    const params = payload.params as { mutationId?: unknown; ok?: unknown; error?: unknown } | null;
    const mutationId = typeof params?.mutationId === "string" ? params.mutationId : "";
    const pending = pendingSettingsMutations.get(mutationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingSettingsMutations.delete(mutationId);
    if (params?.ok === true) pending.resolve();
    else pending.reject(new Error(typeof params?.error === "string" ? params.error : "desktop settings persistence failed"));
    return;
  }

  if (method === "browser:settings" && payload.id === undefined) {
    await handlers[method]?.(payload.params);
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
    const startedAt = performance.now();
    const result = await handler(payload.params);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_RPC_MS) {
      writeLogRecord({
        level: "warn",
        context: "rpc.server",
        event: "rpc.slow",
        message: `slow sidecar RPC: ${method}`,
        durationMs,
        rpcRequestId: String(payload.id),
        data: { method }
      });
    } else if (!QUIET_RPC_METHODS.has(method)) {
      writeLogRecord({
        level: "debug",
        context: "rpc.server",
        event: "rpc.completed",
        message: `sidecar RPC completed: ${method}`,
        status: "ok",
        durationMs,
        rpcRequestId: String(payload.id),
        data: { method }
      });
    }
    writeResponse({ id: payload.id, result });
  } catch (error) {
    writeLogRecord({
      level: "error",
      context: "rpc.server",
      event: "rpc.failed",
      message: `sidecar RPC failed: ${method}`,
      status: "error",
      rpcRequestId: String(payload.id),
      data: { method, error }
    });
    writeResponse({
      id: payload.id,
      error: {
        code: "E_RPC",
        message: error instanceof Error ? error.message : "Unknown sidecar error"
      }
    });
  }
}

/**
 * 进程级兜底：sidecar 承载全部线程/IM 连接/cron，崩溃即整批丢失（desktop 侧需重新 fork 冷启动）。
 * Node ≥15 默认 --unhandled-rejections=throw，任一漏网的 fire-and-forget 拒绝都会终止进程；
 * 这里改为记录日志并存活。uncaughtException 可能留下半写状态，累计超阈值仍退出止损。
 */
function installProcessErrorGuards(): void {
  let uncaughtCount = 0;
  const UNCAUGHT_EXIT_THRESHOLD = 5;
  process.on("unhandledRejection", (reason) => {
    writeLogRecord({
      level: "error",
      context: "sidecar.lifecycle",
      event: "sidecar.unhandled_rejection",
      message: "unhandled promise rejection (guarded, process kept alive)",
      error: { message: reason instanceof Error ? reason.message : String(reason) }
    });
  });
  process.on("uncaughtException", (error) => {
    uncaughtCount += 1;
    writeLogRecord({
      level: "error",
      context: "sidecar.lifecycle",
      event: "sidecar.uncaught_exception",
      message: `uncaught exception (guarded ${uncaughtCount}/${UNCAUGHT_EXIT_THRESHOLD})`,
      error: { message: error instanceof Error ? error.message : String(error) }
    });
    if (uncaughtCount >= UNCAUGHT_EXIT_THRESHOLD) {
      writeEmergencyLog(`sidecar exiting after ${uncaughtCount} uncaught exceptions (pid=${process.pid})`);
      process.exit(1);
    }
  });
}

async function boot(): Promise<void> {
  installProcessErrorGuards();
  writeLogRecord({
    level: "info",
    context: "sidecar.lifecycle",
    event: "sidecar.started",
    message: `sidecar started (pid=${process.pid})`,
    data: { args: argv.slice(2) }
  });
  const native = assertSidecarNativeRuntime();
  writeLogRecord({
    level: "info",
    context: "sidecar.lifecycle",
    event: "sidecar.ready",
    message: "sidecar native runtime ready",
    data: { capabilities: native.capabilities }
  });

  rpcTransport.listen((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleRpcLine(trimmed);
  });
  writeNotification("system.ready", { native });
  const stopBackgroundProcessRecovery = startBackgroundProcessRecovery();

  // 单例守卫仍然早于所有 runner：ready 只表示 RPC/native 已可用，
  // 不让单例检查或可选启动项阻塞桌面端握手。
  try {
    const { acquireSingleInstance } = await import("./services/infra/single-instance");
    acquireSingleInstance();
  } catch (error) {
    writeLogRecord({
      level: "error",
      context: "sidecar.lifecycle",
      event: "sidecar.single_instance_failed",
      message: "sidecar single-instance guard failed",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  }
  void initProxySettings().catch((error) => {
    writeLogRecord({
      level: "error",
      context: "sidecar.proxy",
      event: "proxy.initialization_failed",
      message: "proxy initialization failed",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  });
  // 完成事件写入器恒注册：懒启动路径（run-now/create 等）同样依赖它把
  // automation:run-completed 推给前端，不能随 autostart 门控一起被跳过（#647 P0-2）。
  {
    const { setAutomationNotificationWriter } = await import("./services/automation/automation-runner-service");
    setAutomationNotificationWriter(writeNotification);
  }
  // 默认自启：否则 sidecar 重启后既有 enabled 任务全部静默停摆，
  // 只能靠次日日程生成或用户恰好编辑任务才被拉起（#647 P0-1）。
  if (envAutostartEnabled("LUME_AUTOMATION_RUNNER_AUTOSTART", true)) {
    void startAutomationRunner().catch((error) => {
      writeLogRecord({
        level: "error",
        context: "sidecar.automation",
        event: "automation.runner_start_failed",
        message: "automation runner failed to start",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    });
  }
  if (envAutostartEnabled("LUME_READING_RUNNER_AUTOSTART", true)) {
    const { startRoutineRunner } = await import("./services/routine/routine-runner");
    void startRoutineRunner().catch((error) => {
      writeLogRecord({
        level: "error",
        context: "sidecar.routine",
        event: "routine.runner_start_failed",
        message: "routine runner failed to start",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    });
  }
  if (envAutostartEnabled("LUME_DEFAULT_SKILLS_AUTOSTART", false)) {
    seedDefaultSkills();
  }
  {
    const { setDesktopContextNotificationWriter } = await import("./services/desktop-context/desktop-context-runtime");
    setDesktopContextNotificationWriter(writeNotification);
  }
  if (envAutostartEnabled("LUME_IM_AUTOSTART", true)) {
    void imRuntimeManager.startEnabledAccounts().catch((error) => {
      writeLogRecord({
        level: "error",
        context: "sidecar.im",
        event: "im.runtime_start_failed",
        message: "IM runtime failed to start",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    });
  }
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  void import("./services/memory-v2/job-recovery")
    .then(({ recoverMemoryJobsOnStartup }) => recoverMemoryJobsOnStartup())
    .catch((error) => {
      writeLogRecord({
        level: "error",
        context: "memory-v2.job-recovery",
        event: "memory.job_recovery_failed",
        message: "memory jobs could not be recovered during startup",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    });
  // 冷启动预热：把首条消息的模块加载/MCP 冷连接挪到启动后的空闲期（fire-and-forget）
  void import("./services/warmup/cold-start-warmup")
    .then(({ startColdStartWarmup }) => startColdStartWarmup())
    .catch((error) => {
      writeLogRecord({
        level: "warn",
        context: "sidecar.warmup",
        event: "cold_start_warmup.start_failed",
        message: "cold start warmup could not be started",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    });
  // 启动时清理过期回收站条目
  try { cleanupExpiredTrash(); } catch { /* non-critical */ }
  try { reconcilePlanningStartOperations(); } catch { /* retried on the next start or idempotent request */ }
  startPlanningReminderScheduler(writeNotification);
  const unsubscribeSubagentAnnounce = subscribeSubagentAnnounceEvent((event) => {
    writeNotification(AGENT_IPC_CHANNELS.SUBAGENT_COMPLETED, event);
  });
  const unsubscribeThreadListChanged = subscribeThreadListChanged(() => {
    writeNotification(AGENT_IPC_CHANNELS.THREAD_LIST_CHANGED, null);
  });
  let stopping: Promise<void> | undefined;
  const stopWatcher = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
    unsubscribeSubagentAnnounce();
    unsubscribeThreadListChanged();
    stopBackgroundProcessRecovery();
    stopWorkspaceWatcher();
    await Promise.allSettled([
      getWorkspaceMcpManager().disposeAll(),
      stopAutomationRunner(),
      externalChromeTransport?.close() ?? Promise.resolve(),
    ]);
    const { memoryJobService } = await import("./services/memory-v2/job-service");
    await memoryJobService.waitForSettled(60_000);
    const { stopRoutineRunner } = require("./services/routine/routine-runner");
    stopRoutineRunner();
    imRuntimeManager.stopAll();
    stopPlanningReminderScheduler();
    for (const pending of pendingSettingsMutations.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("sidecar is stopping"));
    }
    pendingSettingsMutations.clear();
    for (const pending of pendingBrowserMainRequests.values()) { clearTimeout(pending.timeout); pending.reject(new Error("sidecar is stopping")); }
    pendingBrowserMainRequests.clear();
    setActiveBrowserBroker(null);
    closePlanningCalendarStore();
    closePlanningTodoStore();
    flushLogTransport();
    })();
    return stopping;
  };
  process.once("exit", () => { void stopWatcher(); });
  process.once("SIGINT", async () => {
    void getNodeReplRuntimeRegistry().shutdownAll?.();
    await Promise.race([stopWatcher(), new Promise((resolve) => setTimeout(resolve, 60_000))]);
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    void getNodeReplRuntimeRegistry().shutdownAll?.();
    await Promise.race([stopWatcher(), new Promise((resolve) => setTimeout(resolve, 60_000))]);
    process.exit(0);
  });

}

void boot().catch((error) => {
  writeEmergencyLog("sidecar boot failed", error);
  process.exit(1);
});
