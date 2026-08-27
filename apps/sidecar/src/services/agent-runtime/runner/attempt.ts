import { createLogger } from "../../infra/logger";
import { resolveMockAttempt } from "./mock-attempt";
import type {
  AgentRuntimeRunParams,
  AgentRuntimeRunResult,
  AgentRuntimeEmitter,
  RunRuntimeCoreAttemptOptions,
} from "../runtime-core/types";
import { buildRuntimeAttemptLogData } from "./attempt-log-summary";
import { humanizeRuntimeErrorMessage } from "./error-message";
import { hasRuntimeCoreSessionTranscript } from "../runtime-core/session-store";
import { LumeRunner } from "./lume-runner";
import { prepareRuntimeCoreAttempt } from "./prepare-attempt";
import {
  getEffectivePluginRuntimeConfig,
} from "../../system/lume-config-service";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import {
  DEFAULT_PLUGIN_STATE_PATH,
  FilePluginStateStore,
} from "../plugins/plugin-state-store.js";
import { SidecarPluginManager } from "../plugins/plugin-manager.js";
import { createCanUseToolHandler } from "../permissions/can-use-tool";

const log = createLogger("runtime-core-attempt");

export async function runRuntimeCoreAttempt(
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions,
): Promise<AgentRuntimeRunResult> {
  const { input, runtime } = params;
  if (runtime.abortSignal?.aborted) {
    emit.onComplete();
    return { status: "aborted" };
  }

  const mockHandler = resolveMockAttempt(input);
  const prepared = await prepareRuntimeCoreAttempt(params);
  if (runtime.abortSignal?.aborted) {
    emit.onComplete();
    return { status: "aborted" };
  }
  if ("status" in prepared) {
    return prepared;
  }

  const runner = await LumeRunner.create({ params, prepared, emit });
  if (runtime.abortSignal?.aborted) return runner.abort();

  if (mockHandler) {
    try {
      const result = await mockHandler(params, runner.emit, options, prepared);
      return runner.finalizeResult(result);
    } catch (error) {
      await runner.finalizeError(error);
      throw error;
    }
  }

  const resumeExistingSession = hasRuntimeCoreSessionTranscript(
    runtime.sessionId,
    prepared.agentDir,
  );
  log.info(
    "[Agent 编排] 准备启动 runtime",
    buildRuntimeAttemptLogData({
      sessionId: runtime.sessionId,
      workspaceSlug: prepared.workspaceSlug,
      provider: prepared.modelResolution.provider,
      modelId: prepared.modelResolution.resolvedModelId,
      resume: resumeExistingSession,
      permissionMode: input.permissionMode,
      cwd: prepared.agentCwd,
    }),
  );

  const pluginManager = new SidecarPluginManager();
  const pluginRuntimeConfig = getEffectivePluginRuntimeConfig(
    prepared.workspaceSlug,
  );
  const pluginInterceptorContexts =
    await pluginManager.buildInterceptorContexts({
      enabled: pluginRuntimeConfig.enabled,
      directories: pluginRuntimeConfig.directories,
    });
  if (runtime.abortSignal?.aborted) return runner.abort();

  // Phase 3c: sensitive-capability gate runtime. Stateless (state lives in the
  // FilePluginStateStore file); same state path SidecarPluginManager uses.
  const pluginPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });

  log.info("Plugin permission interceptors built", {
    sessionId: runtime.sessionId,
    count: pluginInterceptorContexts.length,
    plugins: pluginInterceptorContexts.map((c) => ({
      name: c.pluginName,
      root: c.pluginRoot,
      hasFilesystem: !!c.permissions.filesystem,
      hasNetwork: !!c.permissions.network,
      hasShell: !!c.permissions.shell,
      hasTools: !!c.permissions.tools,
      hasMcpServers: !!c.permissions.mcpServers,
      hasHooks: !!c.permissions.hooks,
    })),
  });

  return runner.runPreparedRuntimeCoreAttempt({
    params,
    prepared,
    options,
    createCanUseTool: (askUserSignal, workflowHooks) =>
      createCanUseToolHandler(
        params,
        prepared,
        runner.emit,
        askUserSignal,
        runner.getRunId(),
        workflowHooks,
        pluginInterceptorContexts,
        pluginPermissionRuntime,
      ),
  });
}

// ─── Agent Runtime runner (migrated from runner/run.ts) ───

interface ActiveRuntimeSessionEntry {
  abort: () => Promise<void>;
  /** 占位标记：run 尚在准备阶段（真实 abort 句柄未就绪）。 */
  placeholder?: boolean;
  /** 占位期间被 stop 过；升级为真实句柄时需补触发中止。 */
  aborted?: boolean;
}

const activePiSessions = new Map<string, ActiveRuntimeSessionEntry>();

/**
 * run 开始准备即占位活动标记：MCP 冷连接等重准备阶段可达数十秒，
 * 删除/移动/清空护栏依赖此标记全程可见（#396）。
 */
export function acquireRuntimeActivityPlaceholder(threadId: string): void {
  const entry: ActiveRuntimeSessionEntry = {
    abort: async () => {
      entry.aborted = true;
    },
    placeholder: true,
  };
  activePiSessions.set(threadId, entry);
}

/** 回收占位标记（仅占位形态；真实句柄由 unregisterAbort 删除）。 */
export function releaseRuntimeActivityPlaceholder(threadId: string): void {
  const entry = activePiSessions.get(threadId);
  if (entry?.placeholder) activePiSessions.delete(threadId);
}

export async function runAgentRuntime(
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
): Promise<AgentRuntimeRunResult> {
  const threadKey = params.input.threadId;
  acquireRuntimeActivityPlaceholder(threadKey);
  let result: AgentRuntimeRunResult;
  // #520:兜底补发仅在内部从未 emit 过错误时执行——runner.fail() 链路已发过
  // 一次,无条件补发会让忽略 fromActiveRun 标志的消费者(如 IM 通道)收到双份
  // 失败终值
  let errorEmitted = false;
  const emitWithTracking: AgentRuntimeEmitter = {
    ...emit,
    onError: (error) => {
      errorEmitted = true;
      return emit.onError(error);
    }
  };
  try {
    result = await runRuntimeCoreAttempt(params, emitWithTracking, {
      registerAbort: (sessionId, abort) => {
        // 升级占位为真实句柄；准备阶段被 stop 过的 run 在此补触发中止。
        const placeholder = activePiSessions.get(sessionId);
        activePiSessions.set(sessionId, { abort });
        if (placeholder?.placeholder && placeholder.aborted) {
          void abort().catch(() => undefined);
        }
      },
      unregisterAbort: (sessionId) => {
        activePiSessions.delete(sessionId);
      },
    });
  } finally {
    // 准备阶段失败（如会话创建抛错）时占位仍残留，必须清理；
    // 正常路径此条目已由 unregisterAbort 删除，此处仅回收占位形态。
    releaseRuntimeActivityPlaceholder(threadKey);
  }
  if (result.status === "errored" && !errorEmitted) {
    // #559:错误上屏前经人性化层——剥内部前缀、映射渠道错误码
    emit.onError(
      humanizeRuntimeErrorMessage(`Agent Runtime 执行失败: ${result.errorMessage ?? "未知错误"}`),
    );
  }
  return result;
}

export async function stopAgentRuntime(threadId: string): Promise<boolean> {
  const active = activePiSessions.get(threadId);
  if (!active) {
    return false;
  }
  await active.abort();
  // 占位标记保留在位：升级为真实句柄时依据 aborted 补触发中止；
  // 提前删除会让护栏窗口重开且丢失中止信号（#396）。
  if (!active.placeholder) activePiSessions.delete(threadId);
  return true;
}

export function isAgentRuntimeSessionActive(threadId: string): boolean {
  return activePiSessions.has(threadId);
}

export async function stopAllAgentRuntimeSessions(): Promise<void> {
  const all = Array.from(activePiSessions.entries());
  for (const [sessionId, active] of all) {
    await active.abort();
    activePiSessions.delete(sessionId);
  }
}
