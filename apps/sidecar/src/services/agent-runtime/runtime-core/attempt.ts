import { createLogger } from "../../infra/logger";
import { buildRuntimeAttemptLogData } from "../../agent/agent-log-summary";
import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { resolveChannelModelBinding } from "../../channel/channel-manager";
import { resolveMockAttempt } from "./mock-attempt";
import type {
  AgentRuntimeRunParams,
  AgentRuntimeRunResult,
  AgentRuntimeEmitter,
  RunRuntimeCoreAttemptOptions,
} from "../runner/types";
import { hasRuntimeCoreSessionTranscript } from "./session-store";
import { LumeRunner } from "../runner/lume-runner";
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

const activePiSessions = new Map<string, { abort: () => Promise<void> }>();

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
  const result = await runRuntimeCoreAttempt(params, emit, {
    registerAbort: (sessionId, abort) => {
      activePiSessions.set(sessionId, { abort });
    },
    unregisterAbort: (sessionId) => {
      activePiSessions.delete(sessionId);
    },
  });
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
  activePiSessions.delete(threadId);
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
