import { createLogger } from "../../infra/logger";
import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { resolveChannelModelBinding } from "../../channel/channel-manager";
import { resolveMockAttempt } from "./mock-attempt";
import type {
  AgentRuntimeRunParams,
  AgentRuntimeRunResult,
  AgentRuntimeEmitter,
  RunRuntimeCoreAttemptOptions,
} from "./types";
import { buildRuntimeAttemptLogData } from "./attempt-log-summary";
import { hasRuntimeCoreSessionTranscript } from "../runtime-core/session-store";
import { LumeRunner } from "./lume-runner";
import { prepareRuntimeCoreAttempt } from "./prepare-attempt";
import {
  getEffectiveLumeConfig,
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

export function resolveRuntimeModelAttemptParams(
  params: AgentRuntimeRunParams,
): AgentRuntimeRunParams[] {
  const workspaceSlug = params.runtime.workspaceId
    ? getAgentWorkspace(params.runtime.workspaceId)?.slug
    : undefined;
  const fallbackRefs =
    getEffectiveLumeConfig(workspaceSlug).models?.agent?.fallbackModelRefs ??
    [];
  const refs = uniqueModelRefs([params.runtime.modelRef, ...fallbackRefs]);
  const attempts: AgentRuntimeRunParams[] = [
    { ...params, runtime: { ...params.runtime } },
  ];
  for (const modelRef of refs) {
    if (modelRef === params.runtime.modelRef) continue;
    const binding = resolveChannelModelBinding(modelRef, "chat");
    if (!binding) continue;
    attempts.push({
      ...params,
      runtime: {
        ...params.runtime,
        modelRef,
        channelId: binding.channel.id,
        resolvedModelId: binding.modelId,
      },
    });
  }
  return attempts;
}

export async function runAgentRuntime(
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
): Promise<AgentRuntimeRunResult> {
  const threadKey = params.input.threadId;
  acquireRuntimeActivityPlaceholder(threadKey);
  let result: AgentRuntimeRunResult;
  try {
    result = await runRuntimeCoreAttempt(params, emit, {
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
  if (result.status === "errored") {
    emit.onError(
      `Agent Runtime 执行失败: ${result.errorMessage ?? "未知错误"}`,
    );
  }
  return result;
}

function uniqueModelRefs(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || result.includes(trimmed)) continue;
    result.push(trimmed);
  }
  return result;
}

export function isRuntimeModelFallbackRetryable(
  errorMessage?: string,
): boolean {
  if (!errorMessage) return false;
  const value = errorMessage.toLowerCase();
  return (
    value.includes("timeout") ||
    value.includes("timed out") ||
    value.includes("rate limit") ||
    value.includes("429") ||
    value.includes("temporar") ||
    value.includes("500") ||
    value.includes("502") ||
    value.includes("503") ||
    value.includes("504") ||
    value.includes("econnreset") ||
    value.includes("econnrefused") ||
    value.includes("etimedout") ||
    value.includes("enotfound") ||
    value.includes("network") ||
    value.includes("unavailable") ||
    value.includes("fetch failed") ||
    value.includes("connection refused") ||
    value.includes("socket hang up")
  );
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
