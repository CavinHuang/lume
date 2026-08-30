import { argv } from "node:process";
import { randomUUID } from "node:crypto";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/system/workspace-watcher";
import { seedDefaultSkills } from "./services/skills/default-skills-seeder";
import { createBrowserMainBridge, setActiveBrowserMainBridge } from "./services/browser/bridge-transport";
import { initProxySettings, getActiveProxyConfig } from "./services/system/proxy-settings-manager";
import { setProxyConfigProvider } from "./services/infra/proxy-config-holder";
import { setOutboundNotificationWriter } from "./services/infra/outbound-notification";
import {
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation/automation-runner-service";
import { getWorkspaceMcpManager } from "./services/mcp/workspace-mcp-manager";
import { imRuntimeManager } from "./services/im/im-runtime-manager";
import { abortActiveFeishuRunCards, recoverInterruptedFeishuRunCards } from "./services/im/feishu/feishu-card-stream";
import { AGENT_IPC_CHANNELS, IM_IPC_CHANNELS, QUIET_RPC_METHODS, summarizeValue, extractCorrelationIds, toLumeRpcErrorShape, RPC_ERROR_CODES } from "@lume/shared";
import { subscribeSubagentAnnounceEvent } from "./services/agent-runtime/subagents/subagent-announce-service";
import { createRpcHandlers } from "./rpc/create-rpc-handlers";
import { cleanupExpiredTrash, subscribeThreadListChanged, onAgentThreadTitleChanged } from "./services/agent/agent-thread-manager";
import { subscribeImMirrorStreamActivity, syncMirrorGroupNameFromMeta } from "./services/im/mirror/im-mirror-service";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc/types";
import {
  acknowledgeLogBatch,
  flushLogTransport,
  setLogBatchNotificationWriter,
  writeEmergencyLog,
  writeLogRecord,
  setLogFileLevel,
  shouldEmitLog,} from "./services/infra/logger";
import { assertSidecarNativeRuntime } from "./services/infra/native-runtime";
import { createProcessRpcTransport, MAX_RPC_MESSAGE_UNITS } from "./rpc/process-transport";
import { createReverseRpcRenderClient } from "./services/agent-runtime/tools/web/reverse-rpc-render-client";
import { setSidecarRenderClient } from "./services/agent-runtime/tools/web/render-client-holder";
import { setPersistedSettingsMutationWriter } from "./services/system/settings-store";
import { setLogDigestPolicy } from "./services/infra/log-digest";
import { migrateLegacySecretCiphertexts } from "./services/system/secret-reencryption-service";
import type { LumeLogDigestPolicy } from "@lume/shared";
import { installPrivilegedCredential } from "./services/infra/privileged-auth";
import { installSecretEncryptionKey } from "./services/infra/secret-crypto";
import { installConnectionVaultKey } from "./services/channel/connection-credential-store";
import { startBackgroundProcessRecovery } from "./services/agent/background-process-recovery";
import { closePlanningTodoStore } from "./services/planning/planning-todo-store";
import { reconcilePlanningStartOperations } from "./services/planning/planning-start-service";
import { closePlanningCalendarStore } from "./services/planning/planning-calendar-store";
import { startPlanningReminderScheduler, stopPlanningReminderScheduler } from "./services/planning/planning-reminder-scheduler";
import { getNodeReplRuntimeRegistry } from "./services/agent-runtime/tools/node-repl/node-repl-runtime-registry";
import { installRuntimeHostPorts } from "./services/agent/agent-runtime-ports-binding";
import { disposeTerminalBridge } from "./services/terminal/terminal-bridge";

// 组合根最先注入 agent-runtime 的宿主端口(#289):任何 RPC/服务调用之前。
installRuntimeHostPorts();
// #578 review fix round2:proxy 读取器顶层无条件注入——纯读盘操作不依赖
// parentPort(stdio smoke/测试形态同样生效);且必须早于 rpcTransport.listen,
// 否则启动窗口内出站 fetch 会静默降级直连绕过用户代理(fail-open)。
setProxyConfigProvider(getActiveProxyConfig);

const rpcTransport = createProcessRpcTransport(
  process.env.LUME_SIDECAR_TRANSPORT === "stdio" ? { parentPort: null } : undefined,
);
const SETTINGS_ACK_TIMEOUT_MS = 10_000;
const pendingSettingsMutations = new Map<string, {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

function writeResponse(response: JsonRpcResponse): void {
  rpcTransport.send(JSON.stringify(response));
}

function writeNotification(method: string, params: unknown): void {
  rpcTransport.send(JSON.stringify({ method, params }));
}

if ((process as typeof process & { parentPort?: unknown }).parentPort) {
  // #580:出站通知写入器组合根一次注入,取代 agent/automation/desktop-context 三域分散 setter
  setOutboundNotificationWriter(writeNotification);
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

const SLOW_RPC_MS = 2_000;
// 浏览器命令桥(sidecar→main 的 lume:browser-execute):MAC+sequence 传输,
// 密钥由 desktop 注入(LUME_BROWSER_RPC_SECRET);未注入时桥不可用,
// 浏览器工具 isEnabled 侧呈现为不可用,调用侧呈现为 backend_unavailable。
const browserMainBridge = createBrowserMainBridge({
  send: (line) => rpcTransport.send(line),
  secret: process.env.LUME_BROWSER_RPC_SECRET ? Buffer.from(process.env.LUME_BROWSER_RPC_SECRET, "base64url") : null,
});
setActiveBrowserMainBridge(browserMainBridge);
rpcTransport.onClose(() => browserMainBridge.failAllPending());
// Process-wide reverse-RPC render client. Bridges WebFetch JS-render requests
// to the desktop PageRenderer. Fed into BOTH the RPC handlers (so render:result
// resolves pending renders) and the agent runtime (so WebFetch can invoke it).
const renderClient = createReverseRpcRenderClient({ sendNotification: writeNotification });
setSidecarRenderClient(renderClient);
const handlers = createRpcHandlers({ writeNotification, renderClient });

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
  if (line.length > MAX_RPC_MESSAGE_UNITS) {
    writeResponse({
      error: { code: RPC_ERROR_CODES.MESSAGE_TOO_LARGE, message: "RPC message exceeds size limit." }
    });
    return;
  }
  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeResponse({
      error: { code: RPC_ERROR_CODES.BAD_JSON, message: "Invalid JSON payload." }
    });
    return;
  }

  // 无 method 的载荷是对请求的响应:浏览器命令桥的响应(MAC+sequence)先行消费,
  // 其余(本进程无挂起的出站请求)静默丢弃。
  if (payload.id !== undefined && !payload.method) {
    const envelope = payload as JsonRpcRequest & { browserRpc?: unknown };
    if (envelope.browserRpc !== undefined && browserMainBridge.handleResponse(envelope)) return;
    return;
  }

  const method = payload.method;
  if (!method) {
    writeResponse({
      id: payload.id,
      error: {
        code: RPC_ERROR_CODES.BAD_REQUEST,
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
    // 与 system.secret-encryption-key 同型：畸形 key 抛错时回 error 响应，
    // 不让 desktop 侧 await 等满超时（交叉复审发现 pre-existing 同缺陷）
    try {
      installConnectionVaultKey((payload.params as { key?: unknown } | null)?.key);
      if (payload.id !== undefined) writeResponse({ id: payload.id, result: { ok: true } });
    } catch (error) {
      if (payload.id !== undefined) {
        writeResponse({
          id: payload.id,
          error: { code: RPC_ERROR_CODES.CONNECTION_VAULT_KEY_INVALID, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return;
  }

  if (method === "system.secret-encryption-key") {
    // 该分支位于 generic handlers 的 try/catch 之外：畸形 key 抛错时必须回
    // error 响应，否则 desktop 启动关键路径上的 await 要等满 RPC 超时上限才降级。
    // (#783 review 修复:此前存在两个同名分支,前者命中即 return 使含
    // migrateLegacySecretCiphertexts 的版本永不可达,#637 弱密文升级从未执行——
    // 仅保留本超集分支,行为零差异、恢复升级链路)
    try {
      installSecretEncryptionKey((payload.params as { key?: unknown } | null)?.key);
      // #637：密钥就位后把存量弱种子密文升级为 v2。注:该 async 函数体内全为
      // 同步 IO,迁移实际同步完成后才回 ok 应答(常态 <10ms、首启数十 ms,
      // 锁忙等 fail-fast 上限 300ms 且被内层 catch 吞);幂等,v2 前缀跳过。
      void migrateLegacySecretCiphertexts().catch((error) => {
        writeLogRecord({
          level: "warn",
          context: "sidecar.secret-reencryption",
          event: "migration.failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
      void recoverInterruptedFeishuRunCards().then((result) => {
        if (result.recovered + result.failed + result.discarded === 0) return;
        writeLogRecord({
          level: result.failed > 0 ? "warn" : "info",
          context: "sidecar.im",
          event: "im.feishu_cards_recovered",
          message: "上次进程遗留的飞书运行卡片已完成启动补偿",
          data: { ...result }
        });
      }).catch((error) => {
        writeLogRecord({
          level: "warn",
          context: "sidecar.im",
          event: "im.feishu_cards_recovery_failed",
          message: "飞书运行卡片启动补偿失败",
          error: { message: error instanceof Error ? error.message : String(error) }
        });
      });
      if (payload.id !== undefined) writeResponse({ id: payload.id, result: { ok: true } });
    } catch (error) {
      if (payload.id !== undefined) {
        writeResponse({
          id: payload.id,
          error: { code: RPC_ERROR_CODES.SECRET_ENCRYPTION_KEY_INVALID, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
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

  if (method === "system.log-level") {
    // main 在 logging 设置热更时下发；无效级别静默忽略（保持当前门槛）。
    setLogFileLevel((payload.params as { level?: unknown } | null)?.level);
    if (payload.id !== undefined) writeResponse({ id: payload.id, result: { ok: true } });
    return;
  }

  const handler = handlers[method];
  // 关联 ID 提前到 try 外声明，failed 分支同样可用。
  const correlation = extractCorrelationIds(payload.params);
  if (!handler) {
    writeResponse({
      id: payload.id,
      error: {
        code: RPC_ERROR_CODES.NOT_IMPLEMENTED,
        message: `Method not implemented: ${method}`
      }
    });
    return;
  }

  try {
    const startedAt = performance.now();
    const result = await handler(payload.params);
    const durationMs = performance.now() - startedAt;
    // 与 main 进程 safeLogIpcEvent 同语义：摘要/记录自身的异常不得把成功 RPC 变成失败。
    const emitRpcLog = (record: Parameters<typeof writeLogRecord>[0]) => {
      try {
        writeLogRecord(record);
      } catch {
        // ignore：观测异常静默降级。
      }
    };
    if (durationMs >= SLOW_RPC_MS) {
      emitRpcLog({
        level: "warn",
        context: "rpc.server",
        event: "rpc.slow",
        message: `slow sidecar RPC: ${method}`,
        durationMs,
        // correlation 在前：信封的真实请求 ID 不被 params 内的同名字段遮蔽。
        ...correlation,
        rpcRequestId: String(payload.id),
        data: { method, params: summarizeValue(payload.params) }
      });
    } else if (!QUIET_RPC_METHODS.has(method) && shouldEmitLog("debug")) {
      // #755: 生产 info 门下每笔 RPC 白付 params/result 摘要成本——级别门前置，
      // 摘要只在事件确定要写时才求值。
      emitRpcLog({
        level: "debug",
        context: "rpc.server",
        event: "rpc.completed",
        message: `sidecar RPC completed: ${method}`,
        status: "ok",
        durationMs,
        ...correlation,
        rpcRequestId: String(payload.id),
        data: {
          method,
          get params() { return summarizeValue(payload.params) },
          get result() { return summarizeValue(result) },
        },
      });
    }
    writeResponse({ id: payload.id, result });
  } catch (error) {
    try {
      writeLogRecord({
        level: "error",
        context: "rpc.server",
        event: "rpc.failed",
        message: `sidecar RPC failed: ${method}`,
        status: "error",
        ...correlation,
        rpcRequestId: String(payload.id),
        data: { method, params: summarizeValue(payload.params), error }
      });
    } catch {
      // failed 记录自身异常不得吞掉原始错误响应。
    }
    writeResponse({
      id: payload.id,
      error: toLumeRpcErrorShape(error)
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
  let lastUncaughtSignature = "";
  // #548 评估结论（round14 需求回溯）：issue 提议的"同类错误去重计数"不采纳——
// 根因是已知良性异步错误源反复触发，本次已全部封堵（spawn 监听 ×5、downloadFile 全失败路径、
// worker diag 回传）；去重会弱化止损语义（五个不同严重错误代表系统性恶化，理应退出），
// 且 stack+emergency 签名已让人工判断"是否同类"成为可能。若未来仍见误触发，修具体错误源而非放宽止损。
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
  process.on("uncaughtException", (thrown) => {
    uncaughtCount += 1;
    // 运行时透传任意 throw 值（throw null/字符串），守卫内部再抛会击穿止损器本身
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    lastUncaughtSignature = `${error.name}: ${error.message}`;
    writeLogRecord({
      level: "error",
      context: "sidecar.lifecycle",
      event: "sidecar.uncaught_exception",
      message: `uncaught exception (guarded ${uncaughtCount}/${UNCAUGHT_EXIT_THRESHOLD})`,
      // stack 截断首行定位：无它则五条日志都无法还原抛出点（#548 review round5）
      error: {
        message: error.message,
        stack: error.stack?.split("\n").slice(0, 6).join("\n")
      }
    });
    if (uncaughtCount >= UNCAUGHT_EXIT_THRESHOLD) {
      writeEmergencyLog(
        `sidecar exiting after ${uncaughtCount} uncaught exceptions (pid=${process.pid}, last=${lastUncaughtSignature})`
      );
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
  if (envAutostartEnabled("LUME_IM_AUTOSTART", true)) {
    // #598：error 态账号指数退避自愈（随 IM 启动同生命周期）
    imRuntimeManager.startAutoRecovery();
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
  // #544 会话镜像：保活窗口推桌面 main（引用计数 powerSaveBlocker）+ 群名跟随标题
  const unsubscribeMirrorStreamActivity = subscribeImMirrorStreamActivity((activity) => {
    writeNotification(IM_IPC_CHANNELS.MIRROR_STREAM_ACTIVE, activity);
  });
  const unsubscribeMirrorTitle = onAgentThreadTitleChanged((threadId, title) => {
    void syncMirrorGroupNameFromMeta(threadId, title);
  });
  let stopping: Promise<void> | undefined;
  const stopWatcher = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
    unsubscribeSubagentAnnounce();
    unsubscribeThreadListChanged();
    unsubscribeMirrorStreamActivity();
    unsubscribeMirrorTitle();
    stopBackgroundProcessRecovery();
    stopWorkspaceWatcher();
    await Promise.allSettled([
      getWorkspaceMcpManager().disposeAll(),
      stopAutomationRunner(),
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
    closePlanningCalendarStore();
    closePlanningTodoStore();
    flushLogTransport();
    })();
    return stopping;
  };
  process.once("exit", () => { void stopWatcher(); });
  // 清理阶段任一同步抛错（盘满下 fs 操作真实可现）不得吞掉退出——
  // 否则信号被完全忽略，desktop 仅等 3s 无 SIGKILL 升级，sidecar 变僵尸进程
  const gracefulExit = async () => {
    try {
      // #598：优雅关停即时收尾；无法捕获的强杀由下次启动的持久快照补偿。
      await Promise.race([
        abortActiveFeishuRunCards(),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
      void getNodeReplRuntimeRegistry().shutdownAll?.();
      disposeTerminalBridge();
      await Promise.race([
        stopWatcher(),
        new Promise((resolve) => setTimeout(resolve, 60_000))
      ]);
    } catch (error) {
      writeLogRecord({
        level: "error",
        context: "sidecar.lifecycle",
        event: "sidecar.shutdown_cleanup_failed",
        message: "关停清理阶段异常，强制退出",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    }
    process.exit(0);
  };
  process.once("SIGINT", gracefulExit);
  process.once("SIGTERM", gracefulExit);

}

void boot().catch((error) => {
  writeEmergencyLog("sidecar boot failed", error);
  process.exit(1);
});
