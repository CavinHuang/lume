import {
  createAgent,
  markProcessJobContinuationConsumed,
  type SDKMessage,
  type Agent,
  type FileCheckpoint,
  type AgentOptions,
  type CompletionGuardResult,
  type ApiType,
  type AgentDefinition,
  type SkillDefinition,
  type ContentBlockParam,
  type ToolResult,
  DEFAULT_CONTEXT_WINDOW,
  createTodoTool,
  type ToolDefinition,
  type PersistedToolContinuation,
  type NormalizedMessageParam,
  detectDanglingToolUses,
  buildResumeContinuations,
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  OpenAiApiMode,
  LumeRuntimeEvent,
  RuntimeCodingReport,
  FileReferenceBinding,
} from "@lume/shared";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeHostPorts } from "../host-ports";
import { createLogger } from "../../infra/logger";
import {
  createRoutingPiAiProvider,
  type PiAiProviderRoute,
} from "../../model-runtime/pi-ai-provider";
import { createConnectionPiAiRoute } from "../../model-runtime/connection-provider";
import {
  getWorkspaceMcpManager,
} from "../../mcp/workspace-mcp-manager";
import type { MemoryV2RecallItem } from "../../memory-v2/types";
import { resolvePlanningTodoContext } from "./planning-todo-context";
import { buildEnabledPluginContext } from "./plugin-enabled-context";
import {
  getEffectiveLumeConfig,
  getEffectivePluginRuntimeConfig,
} from "../../system/lume-config-service";
import { resolveConfiguredPrivateWriteRoots } from "../permissions/permission-config";
import { getSidecarRenderClient } from "../tools/web/render-client-holder";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDir,
  hasRuntimeCoreSessionTranscript,
  type RuntimeCoreSessionManager,
  type RuntimeCoreSessionContextMessage,
} from "./session-store";
import { ContextAssembler } from "../context/context-assembler";
import type { ContextAssemblyInput } from "../context/context-assembler";
import { resolveDesktopContextProjection } from "../../desktop-context/desktop-context-runtime";
import { createKernelContextController } from "../context/context-controller";
import { buildRuntimeUserMessageInput } from "./message-attachment-input";
import { ToolRuntime } from "../tools/tool-runtime";
import { resolvePlanningExecutionContext } from "../../planning/planning-execution-context";
import {
  isBundledBrowserRuntimeAvailable,
  SidecarPluginManager,
} from "../plugins/plugin-manager.js";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import {
  assemblePluginRuntime,
} from "../plugins/runtime-bridge.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import {
  DEFAULT_PLUGIN_STATE_PATH,
  FilePluginStateStore,
} from "../plugins/plugin-state-store.js";
import { buildPluginAgentHooks } from "../plugins/plugin-hooks-bridge.js";
import {
  buildPluginMcpManager,
  buildPluginIdIndex,
  PLUGIN_MCP_WORKSPACE_SLUG,
} from "../plugins/plugin-mcp-bridge.js";
import { clearRuntimeToolDescriptors } from "../tools/tool-descriptor-session";
import { getThreadFileStateCache } from "../tools/thread-file-state-cache";
import {
  createCodingRunTracker,
  type CodingVerificationReport,
  type CodingVerificationStatus,
} from "./coding-run-tracker";
import { runAdvisor } from "../advisor/advisor-service";
import { getComputerUseSessionRegistry } from "../tools/computer-use/computer-use-session";
import {
  filterComputerUseSkills,
  resolveComputerUseSurface,
} from "../tools/computer-use/computer-use-surface";
import {
  createPluginAwareMcpResourceTools,
  replaceMcpResourceTools,
} from "./mcp-resource-router.js";
import {
  cloneTodoState,
  getTodoCompletionBlocker,
  readLatestTodoState,
} from "./todo-state";
import { createFileBackedRunContinuationStore } from "./run-continuation-store";
import type { RunContinuationState } from "./run-continuation";
import { persistAbortContinuation } from "../interruption/abort-continuation";
import { classifyToolKind } from "../interruption/approval-service";
import {
  buildRuntimeCoreTools,
  isAutomationExecution,
} from "./run-tools";
import {
  fingerprintToolSchema,
  estimateToolSchemaTokens,
} from "./tool-schema-metrics";
import {
  createRuntimeSkillFilter,
  resolveSkillDirectories,
} from "./skill-filter";
import {
  executeWorkflowHookSafely,
  applyWorkflowHookEffectsSafely,
} from "./workflow-hook-safety";
import { resolvePromptCachePolicy, resolveSdkApiType } from "./request-policy";
import {
  getResolvedAgentTools,
} from "./run-subagent";
import {
  buildBackgroundTaskResultsContext,
  isTerminalProcessJob,
  publishBackgroundTaskNotificationToBus,
  publishCodingReportToBus,
  waitForProcessJobToFinish,
  type BackgroundTaskResult,
} from "./run-background";
import {
  collectAppendContextEffects,
  type LumeWorkflowHookExecutionResult,
} from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";

const log = createLogger("runtime-core-prompt");

interface RuntimeCoreResolvedModel {
  id: string;
  provider: string;
  channelProvider?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
}

/**
 * 组合根入参(#297 分面分组):52 个扁平字段按领域切为六个命名分面,
 * 以交集组合——构造方仍传扁平字面量,契约按分面阅读。
 */

/** 运行身份:线程归属与执行形态。 */
export interface SessionIdentityInput {
  lumeSessionId: string;
  runId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  subagentType?: string;
  subagentRunId?: string;
  subagentId?: string;
  subagentTaskId?: string;
  subagentAttempt?: number;
  planningClientSubmissionId?: string;
}

/** 工作区与文件路径解析面。 */
export interface WorkspacePathsInput {
  cwd: string;
  agentDir: string;
  lumeWorkDir?: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  projectRoot?: string;
  additionalDirectories?: string[];
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  fileContextId?: string;
  fileReferenceBinding?: FileReferenceBinding;
}

/** 模型与渠道解析面(凭据经 host-ports 解密)。 */
export interface ModelChannelInput {
  provider: string;
  resolvedModelId: string;
  apiKey: string;
  channelProvider?: string;
  channelId?: string;
  openaiApiMode?: OpenAiApiMode;
  apiType?: ApiType;
  modelRef?: string;
  resolvedModel?: RuntimeCoreResolvedModel;
}

/** 用户消息与其附件载荷。 */
export interface MessageInputFields {
  userMessage?: string;
  messageParts?: AgentSendInput["messageParts"];
  messageAttachments?: AgentSendInput["messageAttachments"];
  commentAttachments?: AgentSendInput["commentAttachments"];
  browserAttachments?: AgentSendInput["browserAttachments"];
  messageMetadata?: Record<string, unknown>;
}

/** 事件出口:SDK/live 事件与各类交互请求的上抛通道。 */
export interface RuntimeEmitters {
  emitSdkMessage?: (message: SDKMessage) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  persistCodingReport?: (report: RuntimeCodingReport) => void;
  emitAdvisorReview?: (review: {
    severity: "clear" | "suggestion" | "concern" | "blocker";
    summary: string;
    details?: string;
    modelRef: string;
    durationMs: number;
  }) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
}

/** 执行控制开关:hook/追踪/中止等横切控制。 */
export interface RuntimeControlFlags {
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  applyWorkflowHookEffects?: (
    result: LumeWorkflowHookExecutionResult,
  ) => Promise<void> | void;
  trace?: ContextAssemblyInput["trace"];
  toolConfig?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export type CreateRuntimeCoreSessionInput = SessionIdentityInput &
  WorkspacePathsInput &
  ModelChannelInput &
  MessageInputFields &
  RuntimeEmitters &
  RuntimeControlFlags;

export interface RuntimeCoreSessionLike {
  sessionId: string;
  threadId?: string;
  model?: RuntimeCoreResolvedModel;
  messages: Array<{ role: string }>;
  agent: {
    state: {
      systemPrompt: string;
    };
  };
  getActiveToolNames(): string[];
  dispose(): Promise<void>;
}

export interface CreateRuntimeCoreSessionResult {
  agent: Agent;
  session: RuntimeCoreSessionLike;
  sessionManager: RuntimeCoreSessionManager;
  systemPrompt: string;
  runtimeContext: string;
  userMessageForModel: string | ContentBlockParam[];
  memoryContextUsedItems: MemoryV2RecallItem[];
  tools: ToolDefinition[];
  getVerificationStatus: () => CodingVerificationStatus;
  beforeToolExecution: NonNullable<AgentOptions["onBeforeToolExecution"]>;
  getBaselineCommit: () => string | undefined;
  getBaselineCommits: () => Record<string, string>;
  getVerificationReport: () => import("./coding-run-tracker").CodingVerificationReport;
  refreshCodingChangeSet: () => Promise<unknown>;
  /** 注册 SDK live 事件汇(#285):runner 开始消费查询流时把 tee 投影队列
   * 接进来;传 null 解除(流结束)。 */
  setLiveEventSink: (sink: ((event: unknown) => void) | null) => void;
  getLatestFileCheckpoint: () => FileCheckpoint | undefined;
  getWorkspaceRoots: () => string[];
}

/**
 * 包装器：session 工厂中途抛错（fallback 重试、指纹不匹配、连接初始化失败等）时，
 * 上层 catch（LumeRunner）拿不到 session 无法 dispose——这里按 LIFO 执行已注册的
 * 资源清理后 rethrow，避免泄漏 MCP 子进程 / FS watcher / worker。成功路径由
 * session.dispose() 负责清理，pendingCleanup 随返回值丢弃。
 */
/** 进程内已写 manifest 的 sessionDir——清单是进程环境快照,同进程只写一次 */
const sessionManifestWritten = new Set<string>();

/**
 * session 目录版本清单(#256):导出/排障时确定复现所需版本。
 * appVersion 由 desktop 经 LUME_APP_VERSION 注入(独立运行 sidecar 时缺省)。
 */
function writeSessionManifestOnce(
  sessionDir: string,
  plugins: ReadonlyArray<{ pluginId: string; version: string }>,
): void {
  if (sessionManifestWritten.has(sessionDir)) return;
  sessionManifestWritten.add(sessionDir);
  try {
    writeFileSync(
      join(sessionDir, "manifest.json"),
      JSON.stringify(
        {
          v: 1,
          ...(process.env.LUME_APP_VERSION?.trim()
            ? { appVersion: process.env.LUME_APP_VERSION.trim() }
            : {}),
          plugins: plugins
            .map((plugin) => ({ id: plugin.pluginId, version: plugin.version }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          runtime: {
            node: process.versions.node,
            ...(process.versions.bun ? { bun: process.versions.bun } : {}),
            platform: process.platform,
            arch: process.arch,
          },
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (error) {
    // 清单缺失只影响排障复现信息,不影响运行——静默降级
    log.warn("session manifest 写入失败", {
      sessionDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput,
): Promise<CreateRuntimeCoreSessionResult> {
  const pendingCleanup: Array<() => Promise<unknown> | void> = [];
  try {
    return await createRuntimeCoreSessionImpl(input, pendingCleanup);
  } catch (error) {
    for (let index = pendingCleanup.length - 1; index >= 0; index -= 1) {
      try {
        await pendingCleanup[index]!();
      } catch (cleanupError) {
        log.warn("createRuntimeCoreSession 失败路径清理出错", {
          sessionId: input.lumeSessionId,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }
    }
    throw error;
  }
}

/**
 * 插件运行时 + MCP 装配(#297 子项①自组合根拆出):
 * Phase 3b 注册清单 → assembly;Phase 3d 门控 hooks;advisor Stop hook;
 * MCP Merge-A/B(transient plugin manager + workspace 单例 merge + resource tools)。
 * disposeWorkspace 清理在此注册进 pendingCleanup(无条件,失败也留子进程 state)。
 */
async function assemblePluginsAndMcpRuntime({
  sessionDir,
  workspaceSlug,
  cwd,
  modelRef,
  provider,
  lumeSessionId,
  runId,
  userMessage,
  threadType,
  emitAdvisorReview,
  pendingCleanup,
}: {
  sessionDir: string;
  workspaceSlug?: string;
  cwd: string;
  modelRef?: string;
  provider: string;
  lumeSessionId: string;
  runId?: string;
  userMessage?: string;
  threadType?: AgentSendInput["threadType"];
  emitAdvisorReview?: CreateRuntimeCoreSessionInput["emitAdvisorReview"];
  pendingCleanup: Array<() => Promise<unknown> | void>;
}) {
  const pluginConfig = getEffectivePluginRuntimeConfig(workspaceSlug);
  const computerUseConfig = getEffectiveLumeConfig(workspaceSlug).models
    ?.computerUse;
  const channelProvider = modelRef
    ? (getRuntimeHostPorts().resolveChannelModelBinding(modelRef, "chat")?.channel.provider ??
      provider)
    : provider;
  const computerUseSurface = resolveComputerUseSurface({
    agentSurface: computerUseConfig?.agentSurface,
    modelRef: modelRef,
    skyModelRefs: computerUseConfig?.skyModelRefs,
    channelProvider,
  });
  const pluginManager = new SidecarPluginManager();
  const registeredPlugins = await pluginManager.listRegistered({
    enabled: pluginConfig.enabled,
    // Do not auto-load project-local .lume/plugins just because the Agent cwd is a real project.
    directories: pluginConfig.directories,
  });
  const computerUsePlugin = registeredPlugins.find(
    (plugin) => plugin.pluginId === "computer-use",
  );
  log.info("Computer Use capability selected", {
    sessionId: lumeSessionId,
    runId: runId,
    computerUseSurface,
    pluginVersion: computerUsePlugin?.version,
    modelRef: modelRef,
  });
  const pluginAssembly = await assemblePluginRuntime(registeredPlugins);
  writeSessionManifestOnce(sessionDir, registeredPlugins);
  const surfaceSkills = filterComputerUseSkills(pluginAssembly.skills, computerUseSurface);

  // Phase 3d: build agentOptions.hooks from resolved plugin hooks. Shell-command hooks
  // are gate-aware (§8.1): checkSensitiveCapability(hook:event:matcher) before spawn.
  const hookPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });
  const pluginAgentHooks = buildPluginAgentHooks({
    capabilities: pluginAssembly.hooks,
    runtime: hookPermissionRuntime,
    workspaceSlug: workspaceSlug,
  });
  const agentHooks = { ...pluginAgentHooks };
  const advisorConfig = getEffectiveLumeConfig(workspaceSlug).models
    ?.advisor;
  if (
    threadType !== "subagent" &&
    advisorConfig?.defaultModelRef &&
    advisorConfig.enabled !== false
  ) {
    agentHooks.Stop = [
      ...(agentHooks.Stop ?? []),
      {
        hooks: [
          async (hookInput: Record<string, unknown>) => {
            try {
              const review = await runAdvisor({
                workspaceSlug: workspaceSlug,
                cwd: cwd,
                userMessage: userMessage,
                messages: hookInput.messages,
              });
              if (!review) return undefined;
              emitAdvisorReview?.(review);
            } catch (error) {
              log.warn("Advisor review failed", {
                sessionId: lumeSessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return undefined;
          },
        ],
      },
    ];
  }

  // Phase MCP Merge-A/B: plugin-declared MCP servers via a TRANSIENT WorkspaceMcpManager
  // (independent of the workspace singleton — zero pollution, §16.7 lifecycle via dispose).
  // Merge-B: §8.1 start gate (authorizeConnect → checkSensitiveCapability, mcpServer key) +
  // drop fixed-name management tools (includeManagementTools:false, avoids workspace collision) +
  // stamp pluginId/capability/mcpServerId so the call gate (sensitive-gate.ts) source-binds.
  // Stateless runtime, same state path as attempt.ts → shares approval records.
  const pluginMcpPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });
  const pluginMcpServerIndex = buildPluginIdIndex(pluginAssembly.mcpServers);
  const pluginMcpManager = buildPluginMcpManager(pluginAssembly.mcpServers, {
    permissionRuntime: pluginMcpPermissionRuntime,
    workspaceSlug: workspaceSlug,
    stdioCwd: cwd,
  });
  const workspaceMcpManager = getWorkspaceMcpManager();
  const pluginMcpRuntime = await pluginMcpManager
        .createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG, {
          includeManagementTools: false,
          toolMetadataProvider: (serverId) => {
            const pluginId = pluginMcpServerIndex.get(serverId);
            if (!pluginId) return undefined;
            return { source: "plugin", pluginId, capability: "mcp" };
          },
        })
        .catch((error) => ({
          tools: [],
          diagnostics: [
            {
              pluginName: "PluginMCP",
              severity: "warning" as const,
              reason: error instanceof Error ? error.message : String(error),
            },
          ],
        }));
  // createRuntimeTools 恒 resolve（内部失败也留下已 spawn 的子进程 state），失败清理须无条件注册
  pendingCleanup.push(() =>
    pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG),
  );
  const workspaceMcpRuntime = workspaceSlug
    ? await workspaceMcpManager
        .createRuntimeTools(workspaceSlug)
        .catch((error) => ({
          tools: [],
          diagnostics: [
            {
              pluginName: "MCP",
              severity: "warning" as const,
              reason: error instanceof Error ? error.message : String(error),
            },
          ],
        }))
    : { tools: [], diagnostics: [] };
  // workspaceMcpManager 是进程级单例：runtime 连接跨会话复用，会话结束不做 per-session dispose
  // （此前仅 Wiki Phase B 的 transient 沙箱 manager 需要清理，随功能移除一并消失）。
  const pluginAwareMcpResourceTools =
    workspaceSlug && pluginAssembly.mcpServers.length > 0
      ? createPluginAwareMcpResourceTools({
          workspaceSlug: workspaceSlug,
          pluginServers: pluginAssembly.mcpServers,
          workspaceMcpManager,
          pluginMcpManager,
        })
      : [];
  return {
    surfaceSkills,
    computerUseSurface,
    pluginAssembly,
    registeredPlugins,
    pluginMcpManager,
    pluginMcpRuntime,
    workspaceMcpRuntime,
    pluginAwareMcpResourceTools,
    agentHooks,
  };
}

/**
 * Provider 路由装配(#297 子项①自组合根拆出):
 * 主渠道连接路由 + 配置 fallbackModelRefs 的可用兜底路由。
 */
async function buildProviderRoutes({
  channelId,
  resolvedModel,
  resolvedModelId,
  lumeSessionId,
  channelProvider,
  provider,
  apiKey,
  workspaceSlug,
  apiType,
  openaiApiMode,
}: {
  channelId?: string;
  resolvedModel?: RuntimeCoreResolvedModel;
  resolvedModelId: string;
  lumeSessionId: string;
  channelProvider?: string;
  provider: string;
  apiKey: string;
  workspaceSlug?: string;
  apiType?: ApiType;
  openaiApiMode?: OpenAiApiMode;
}): Promise<PiAiProviderRoute[]> {
  const resolvedApiType = apiType ?? resolveSdkApiType(provider, openaiApiMode);
  const primaryChannel = channelId
    ? getRuntimeHostPorts().getChannelById(channelId)
    : undefined;
  const providerRoutes: PiAiProviderRoute[] = [
    primaryChannel
      ? await createConnectionPiAiRoute({
          channel: primaryChannel,
          modelId: resolvedModel?.id ?? resolvedModelId,
          sessionId: lumeSessionId,
        })
      : {
          modelId: resolvedModel?.id ?? resolvedModelId,
          apiType: resolvedApiType,
          providerId: channelProvider ?? provider,
          baseUrl: resolvedModel?.baseUrl ?? "",
          apiKey: apiKey,
          contextWindow: resolvedModel?.contextWindow,
          maxTokens: resolvedModel?.maxTokens,
          supportsReasoning: resolvedModel?.reasoning,
          sessionId: lumeSessionId,
        },
  ];
  const configuredFallbackRefs =
    getEffectiveLumeConfig(workspaceSlug).models?.agent
      ?.fallbackModelRefs ?? [];
  for (const fallbackRef of configuredFallbackRefs) {
    const binding = getRuntimeHostPorts().resolveChannelModelBinding(fallbackRef, "chat");
    if (!binding) continue;
    if (
      binding.channel.id === channelId &&
      binding.modelId === providerRoutes[0]?.modelId
    )
      continue;
    try {
      providerRoutes.push(
        await createConnectionPiAiRoute({
          channel: binding.channel,
          modelId: binding.modelId,
          sessionId: lumeSessionId,
        }),
      );
    } catch (error) {
      log.warn("skipping unavailable fallback model route", {
        connectionId: binding.channel.id,
        modelId: binding.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return providerRoutes;
}

/**
 * 会话上下文装配(#297 子项①自组合根拆出):
 * runtime skills 过滤 → workflow beforeAssemble hook → ContextAssembler 主装配
 * → afterAssemble hook 与效果应用 → subagent work context 合并。
 */
async function assembleSessionContext({
  input,
  runId,
  toolset,
  surfaceSkills,
  registeredPlugins,
  pluginAssembly,
  initialTodoState,
  subagentDefinition,
}: {
  input: CreateRuntimeCoreSessionInput;
  runId: string;
  toolset: ReturnType<typeof buildRuntimeCoreTools>;
  surfaceSkills: SkillDefinition[];
  registeredPlugins: RegisteredPlugin[];
  pluginAssembly: Awaited<ReturnType<typeof assemblePluginRuntime>>;
  initialTodoState: Awaited<ReturnType<typeof readLatestTodoState>>;
  subagentDefinition: AgentDefinition | undefined;
}) {
  const runtimeSkills = toolset.availableToolNames.includes("mcp__browser__snapshot")
    && !input.browserAttachments?.length
    ? surfaceSkills.filter((skill) => skill.name !== "browser:browser")
    : surfaceSkills;
  const enabledPlugins = buildEnabledPluginContext(
    registeredPlugins,
    { ...pluginAssembly, skills: runtimeSkills },
  );
  const contextTokenBudget = input.resolvedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const beforeContextResult = await executeWorkflowHookSafely(
    input.workflowHooks,
    {
      event: "context.beforeAssemble",
      runId,
      threadId: input.lumeSessionId,
      workspaceId: input.workspaceId,
      workspaceSlug: input.workspaceSlug,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      threadType: input.threadType,
      chatType: input.chatType,
      messageMetadata: input.messageMetadata,
      userMessage: input.userMessage ?? "",
      availableTools: toolset.availableToolNames,
      tokenBudget: contextTokenBudget,
    },
  );
  const workflowContext = beforeContextResult
    ? {
        appendContext: collectAppendContextEffects(beforeContextResult.effects),
      }
    : undefined;
  const desktopContext = await resolveDesktopContextProjection(
    input.messageMetadata,
  );
  const planningExecutionContext = resolvePlanningExecutionContext({
    runId,
    clientSubmissionId: input.planningClientSubmissionId,
  });
  const planningTodoContext = resolvePlanningTodoContext(
    input,
    planningExecutionContext,
  );
  const modelId = input.resolvedModel?.id ?? input.resolvedModelId;
  const promptCache = resolvePromptCachePolicy({
    channelProvider: input.channelProvider,
    provider: input.provider,
    model: modelId,
    threadId: input.lumeSessionId,
    baseUrl: input.resolvedModel?.baseUrl,
  });
  const toolSchemaFingerprint = fingerprintToolSchema(toolset.tools);
  const toolSchemaTokens = estimateToolSchemaTokens(toolset.tools);

  const contextAssembly = await new ContextAssembler().assemble({
    threadId: input.lumeSessionId,
    runId,
    cwd: input.cwd,
    lumeWorkDir: input.lumeWorkDir,
    projectRoot: input.projectRoot,
    modelRef: input.modelRef,
    resolvedModelId: input.resolvedModel?.id ?? input.resolvedModelId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    automationExecution: isAutomationExecution(input.messageMetadata),
    agentSystemPrompt: subagentDefinition?.prompt,
    userMessage: input.userMessage ?? "",
    messageAttachments: input.messageAttachments,
    commentAttachments: input.commentAttachments,
    browserAttachments: input.browserAttachments,
    availableTools: toolset.availableToolNames,
    browserRuntimeAvailable: isBundledBrowserRuntimeAvailable(),
    browserContinuity: input.messageMetadata?.browserContinuity,
    enabledPlugins,
    tokenBudget: contextTokenBudget,
    toolSchemaFingerprint,
    toolSchemaTokens,
    cacheStrategy: promptCache.strategy,
    workflowContext,
    desktopContext,
    todoState: initialTodoState,
    planningTodoContext,
    trace: input.trace,
  });
  const afterContextResult = await executeWorkflowHookSafely(
    input.workflowHooks,
    {
      event: "context.afterAssemble",
      runId,
      threadId: input.lumeSessionId,
      workspaceId: input.workspaceId,
      workspaceSlug: input.workspaceSlug,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      threadType: input.threadType,
      chatType: input.chatType,
      messageMetadata: input.messageMetadata,
      availableTools: toolset.availableToolNames,
      tokenBudget: contextTokenBudget,
      memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
      userMessageForModelLength: contextAssembly.userMessageForModel.length,
    },
  );
  await applyWorkflowHookEffectsSafely(
    input.applyWorkflowHookEffects,
    afterContextResult,
  );
  const systemPrompt = contextAssembly.systemPrompt;
  const runtimeContext = contextAssembly.runtimeContext;
  return {
    runtimeSkills,
    contextAssembly,
    systemPrompt,
    runtimeContext,
    promptCache,
  };
}

async function createRuntimeCoreSessionImpl(
  input: CreateRuntimeCoreSessionInput,
  pendingCleanup: Array<() => Promise<unknown> | void>,
): Promise<CreateRuntimeCoreSessionResult> {
  const sessionDir = getRuntimeCoreSessionDir(
    input.lumeSessionId,
    input.agentDir,
  );
  const runId = input.runId ?? input.lumeSessionId;
  const backgroundProcessJobIds = new Set<string>();
  const consumedBackgroundProcessJobIds = new Set<string>();
  const consumedBackgroundSubagentRunIds = new Set<string>();
  const codingRunTracker = createCodingRunTracker({
    workspaceRoot: input.cwd,
    additionalRoots: input.additionalDirectories,
    statePath: join(
      sessionDir,
      `coding-state-${(input.runId ?? "session").replace(/[^a-zA-Z0-9_-]/g, "_")}.v1.json`,
    ),
    turnId:
      typeof input.messageMetadata?.turnId === "string"
        ? input.messageMetadata.turnId
        : undefined,
    userMessageId:
      typeof input.messageMetadata?.messageId === "string"
        ? input.messageMetadata.messageId
        : undefined,
  });
  pendingCleanup.push(() => codingRunTracker.dispose());
  await codingRunTracker.initialize();
  let approvalRequestCount = 0;
  const getCodingReport = (): CodingVerificationReport &
    RuntimeCodingReport => {
    const report: CodingVerificationReport & RuntimeCodingReport = {
      ...codingRunTracker.getVerificationReport(),
      runId,
      approvalRequestCount,
    };
    return report;
  };
  const publishCodingReport = (): void => {
    const codingReport = getCodingReport();
    if (
      !codingReport.workspaceChanged &&
      !codingReport.pendingBackground &&
      (codingReport.gitActions?.length ?? 0) === 0
    )
      return;
    input.persistCodingReport?.(codingReport);
    // 批次5 第二入口:同一 codingReport 经 ThreadEventBus 发布(flag gate 在 helper 内;
    // 空报告早退于 publish 之前)。T7a:旧路 emitRuntimeEvent(coding.report.updated)删除。
    publishCodingReportToBus({
      sessionDir,
      threadId: input.lumeSessionId,
      runId,
      report: codingReport,
    });
  };
  const handleToolExecution = (
    toolInput: Parameters<typeof codingRunTracker.observe>[0],
  ): void => {
    codingRunTracker.observe(toolInput);
    const task = toolInput.result._meta?.task as
      { id?: string; status?: string } | undefined;
    if (task?.id && task.status === "running") {
      backgroundProcessJobIds.add(task.id);
    }
    if (toolInput.toolName.toLowerCase() === "waitfordelegations") {
      for (const run of getSubagentRunRegistry().listByParentSession(
        input.lumeSessionId,
      )) {
        if (
          run.background &&
          run.parentRunId === runId &&
          run.status !== "running"
        ) {
          consumedBackgroundSubagentRunIds.add(run.runId);
        }
      }
    }
    if (input.runId && task?.id && task.status === "running") {
      const toolName = toolInput.toolName;
      const toolKind =
        toolName.toLowerCase() === "processoutput" ? "read" : "execute";
      const toolUseId = toolInput.result.tool_use_id || task.id;
      const now = new Date().toISOString();
      const store = createFileBackedRunContinuationStore(sessionDir);
      void store
        .get(input.runId)
        .then((existing) => {
          const checkpoint: NonNullable<RunContinuationState["checkpoint"]> = {
            step: "waiting_for_tool_result",
            toolCallId: toolUseId,
            toolName,
            toolKind,
            processJobId: task.id,
            toolCall: {
              id: toolUseId,
              name: toolName,
              input: toolInput.input,
              inputHash: createHash("sha256")
                .update(JSON.stringify(toolInput.input ?? null))
                .digest("hex"),
              kind: toolKind,
            },
          };
          // #650：主槽已有另一个在等后台任务时，旧快照降级进 backgroundCheckpoints
          // 数组保留（按 processJobId 去重更新），不再被本任务覆盖。
          const priorOther =
            existing?.version === 2 &&
            existing.checkpoint.processJobId &&
            existing.checkpoint.processJobId !== task.id
              ? [existing.checkpoint]
              : [];
          const carriedOthers = existing?.version === 2 ? existing.backgroundCheckpoints ?? [] : [];
          const mergedOthers = [
            ...carriedOthers.filter(
              (item) =>
                item.processJobId !== task.id &&
                !priorOther.some((p) => p.processJobId === item.processJobId),
            ),
            ...priorOther.map((p) => ({
              processJobId: p.processJobId!,
              toolCallId: p.toolCallId ?? "",
              toolName: p.toolName ?? "",
              toolKind: p.toolKind ?? ("execute" as const),
              toolCall: p.toolCall ?? {
                id: p.toolCallId ?? "",
                name: p.toolName ?? "",
                input: null,
                inputHash: "",
                kind: p.toolKind ?? ("execute" as const),
              },
              syntheticToolResult: p.syntheticToolResult,
              updatedAt: now,
            })),
          ];
          return store.upsert({
            version: 2,
            runId: input.runId!,
            threadId: input.lumeSessionId,
            status: "waiting_background",
            checkpoint,
            ...(mergedOthers.length > 0 ? { backgroundCheckpoints: mergedOthers } : {}),
            reason: "后台命令已持久化，恢复时重新附着而不重复执行。",
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        })
        .catch((error) => {
          // fire-and-forget 持久化失败（AV 锁/磁盘满等）只降级恢复能力，不允许变成未处理拒绝崩进程
          log.warn("Failed to persist background continuation checkpoint", {
            sessionId: input.lumeSessionId,
            runId: input.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    publishCodingReport();
  };
  const handleAsyncEvent = (event: SDKMessage): void => {
    const updatesCodingReport = codingRunTracker.observeAsyncEvent(event);
    if (
      input.runId &&
      event.type === "system" &&
      event.subtype === "task_notification" &&
      event.status !== "attention"
    ) {
      const continuationStore =
        createFileBackedRunContinuationStore(sessionDir);
      void continuationStore
        .get(input.runId)
        .then((continuation) => {
          if (!continuation || continuation.version !== 2) return;
          const synthetic = {
            type: "tool_result",
            tool_use_id:
              event.tool_use_id ?? continuation.checkpoint.toolCallId ?? "",
            content: event.message ?? event.summary ?? "",
            ...(event.status === "failed" ||
            event.status === "stopped" ||
            event.status === "interrupted"
              ? { is_error: true }
              : {}),
            ...(event.execution
              ? { _meta: { execution: event.execution } }
              : {}),
          };
          // 主槽命中（最新后台任务）
          if (continuation.checkpoint.processJobId === event.task_id) {
            return continuationStore.update(input.runId!, {
              status: "ready_to_resume",
              checkpoint: {
                ...continuation.checkpoint,
                step: "after_tool_result",
                syntheticToolResult: synthetic,
              },
              reason: `后台命令已进入终态：${event.status}。`,
            });
          }
          // #650：次槽命中——把 syntheticToolResult 回填进对应数组项
          const others = continuation.backgroundCheckpoints ?? [];
          const hitIndex = others.findIndex(
            (item) => item.processJobId === event.task_id,
          );
          if (hitIndex < 0) return;
          const nextOthers = others.map((item, index) =>
            index === hitIndex
              ? { ...item, syntheticToolResult: synthetic, updatedAt: new Date().toISOString() }
              : item,
          );
          return continuationStore.update(input.runId!, {
            backgroundCheckpoints: nextOthers,
            updatedAt: new Date().toISOString(),
          });
        })
        .catch((error) => {
          log.warn("Failed to persist background continuation result", {
            sessionId: input.lumeSessionId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (
      input.runId &&
      event.type === "system" &&
      event.subtype === "run_aborted"
    ) {
      void persistAbortContinuation({
        sessionDir,
        runId: input.runId,
        threadId: input.lumeSessionId,
        pendingToolCalls: event.pending_tool_calls,
      }).catch((error) => {
        log.warn("Failed to persist abort continuation", {
          sessionId: input.lumeSessionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // 批次4 旁路注入:同批 late task_notification 再上总线(领域事件双入口归一;
    // 与上方续跑 checkpoint 无耦合,runId 缺省回落线程 id)
    if (event.type === "system" && event.subtype === "task_notification") {
      publishBackgroundTaskNotificationToBus({
        sessionDir,
        threadId: input.lumeSessionId,
        runId,
        event,
      });
    }
    try {
      input.emitSdkMessage?.(event);
    } catch (error) {
      log.warn("Failed to emit asynchronous SDK event", {
        sessionId: input.lumeSessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!updatesCodingReport) return;
    void codingRunTracker
      .refreshChangeSet()
      .catch((error) => {
        log.warn(
          "Failed to refresh Coding changes after background task completion",
          {
            sessionId: input.lumeSessionId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      })
      .finally(() => {
        publishCodingReport();
      });
  };
  const emitToolPermissionRequest = input.emitToolPermissionRequest
    ? (request: AgentToolPermissionRequest) => {
        approvalRequestCount += 1;
        input.emitToolPermissionRequest?.(request);
      }
    : undefined;
  const initialTodoState = await readLatestTodoState({
    sessionDir,
    threadId: input.lumeSessionId,
  });
  let currentTodoState = cloneTodoState(initialTodoState);
  const handleTodoUpdated: Parameters<
    typeof createTodoTool
  >[0]["onTodoUpdated"] = async (state) => {
    currentTodoState = cloneTodoState(state);
    await input.emitTodoUpdated?.(state);
  };
  const sessionManager = createOrResumeRuntimeCoreSessionManager(
    input.cwd,
    input.lumeSessionId,
    input.agentDir,
  );
  const agents = {
    ...getRuntimeHostPorts().buildBuiltinAgents(),
    ...getRuntimeHostPorts().loadCustomAgents(input.workspaceSlug),
  };
  const subagentDefinition = input.subagentType
    ? agents[input.subagentType]
    : undefined;
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d, buildPluginAgentHooks).
  const {
    surfaceSkills,
    computerUseSurface,
    pluginAssembly,
    registeredPlugins,
    pluginMcpManager,
    pluginMcpRuntime,
    workspaceMcpRuntime,
    pluginAwareMcpResourceTools,
    agentHooks,
  } = await assemblePluginsAndMcpRuntime({
    workspaceSlug: input.workspaceSlug,
    cwd: input.cwd,
    modelRef: input.modelRef,
    provider: input.provider,
    lumeSessionId: input.lumeSessionId,
    runId: input.runId,
    userMessage: input.userMessage,
    threadType: input.threadType,
    emitAdvisorReview: input.emitAdvisorReview,
    sessionDir,
    pendingCleanup,
  });

  // #560:MCP 连接失败原本只进 system prompt/日志——本轮静默缺一组工具，直到模型
  // 回答「我没有这个工具」。组装完成即向线程投影 runtime.warning 给用户。
  for (const diagnostic of [
    ...(workspaceMcpRuntime.diagnostics ?? []),
    ...(pluginMcpRuntime.diagnostics ?? []),
  ]) {
    try {
      input.emitRuntimeEvent?.({
        id: `${input.lumeSessionId}:${input.runId}:runtime.warning:${diagnostic.pluginName}`,
        type: "runtime.warning",
        threadId: input.lumeSessionId,
        runId,
        createdAt: new Date().toISOString(),
        message: `${diagnostic.pluginName}：${diagnostic.reason}`,
        source: "mcp"
      });
    } catch {
      // 投影失败不阻断 run 组装
    }
  }

  const toolset = buildRuntimeCoreTools({    cwd: input.cwd,
    filesRoot: input.filesRoot,
    plansRoot: input.plansRoot,
    artifactsRoot: input.artifactsRoot,
    sessionId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    modelRef: input.modelRef,
    provider: input.provider,
    computerUseSurface,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    subagentDefinition,
    fileReferenceBinding: input.fileReferenceBinding,
    messageMetadata: input.messageMetadata,
    planningClientSubmissionId: input.planningClientSubmissionId,
    originalUserInstruction: input.userMessage,
    emitSdkMessage: input.emitSdkMessage,
    emitRuntimeEvent: input.emitRuntimeEvent,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitToolPermissionRequest,
    emitTodoUpdated: handleTodoUpdated,
    initialTodoState,
    runId: input.runId,
    renderClient: getSidecarRenderClient(),
    pluginDiagnostics: pluginAssembly.diagnostics.map((d) => ({
      pluginName: d.pluginId,
      severity: d.severity,
      reason: d.message,
      ...(d.path ? { path: d.path } : {}),
      ...(d.code ? { code: d.code } : {}),
    })),
    pluginCommandTools: pluginAssembly.commandToolDefinitions,
    pluginMcpTools: pluginMcpRuntime.tools,
    abortSignal: input.abortSignal,
    mcpTools: replaceMcpResourceTools(
      workspaceMcpRuntime.tools,
      pluginAwareMcpResourceTools,
    ),
    mcpDiagnostics: [
      ...(workspaceMcpRuntime.diagnostics ?? []),
      ...(pluginMcpRuntime.diagnostics ?? []),
    ],
  });
  const {
    runtimeSkills,
    contextAssembly,
    systemPrompt,
    runtimeContext,
    promptCache,
  } = await assembleSessionContext({
    input,
    runId,
    toolset,
    surfaceSkills,
    registeredPlugins,
    pluginAssembly,
    initialTodoState,
    subagentDefinition,
  });
  const context = sessionManager.buildSessionContext();
  const completionGuard = async (): Promise<CompletionGuardResult> => {
    const registry = getSubagentRunRegistry();
    const subagentRuns = registry
      .listByParentSession(input.lumeSessionId)
      .filter(
        (run) =>
          run.background &&
          run.parentRunId === runId &&
          !consumedBackgroundSubagentRunIds.has(run.runId),
      );
    const processJobIds = [...backgroundProcessJobIds].filter(
      (id) => !consumedBackgroundProcessJobIds.has(id),
    );
    if (subagentRuns.length > 0 || processJobIds.length > 0) {
      const processJobsPromise = Promise.all(
        processJobIds.map((id) =>
          waitForProcessJobToFinish(id, input.abortSignal),
        ),
      );
      await Promise.all([
        subagentRuns.length > 0
          ? (async () => {
              // 总上限:长期不响应的审批/僵尸委派不得无限期挂住父 run。
              // 超时后放行本轮收割,未完成 runs 保持 running(完成后 announce 照发,
              // 下一轮 guard 会再次尝试收割)。
              const waitStartedAt = Date.now();
              const BACKGROUND_WAIT_TOTAL_LIMIT_MS = 30 * 60 * 1000;
              while (
                Date.now() - waitStartedAt < BACKGROUND_WAIT_TOTAL_LIMIT_MS &&
                subagentRuns.some(
                  (run) => registry.get(run.runId)?.status === "running",
                )
              ) {
                await registry.waitForDelegations({
                  parentThreadId: input.lumeSessionId,
                  runIds: subagentRuns.map((run) => run.runId),
                  mode: "all",
                  timeoutMs: 30_000,
                  abortSignal: input.abortSignal,
                });
              }
            })()
          : Promise.resolve(),
        processJobsPromise,
      ]);
      const completedSubagents = subagentRuns
        .map((run) => registry.get(run.runId))
        .filter((run): run is NonNullable<typeof run> =>
          Boolean(run && run.status !== "running"),
        );
      const completedProcessJobs = await processJobsPromise;
      const results: BackgroundTaskResult[] = [
        ...completedSubagents.map((run) => ({
          id: run.runId,
          kind: "subagent" as const,
          status: run.status,
          label: run.label,
          childThreadId: run.childThreadId,
          output: run.outcome?.output,
          error: run.outcome?.error,
        })),
        ...completedProcessJobs.filter(isTerminalProcessJob).map((job) => ({
          id: job.id,
          kind: "process" as const,
          status: job.status,
          label: job.subject,
          output: job.output,
          error:
            job.status === "failed" ||
            job.status === "stopped" ||
            job.status === "interrupted"
              ? job.output
              : undefined,
        })),
      ];
      for (const run of completedSubagents)
        consumedBackgroundSubagentRunIds.add(run.runId);
      for (const job of completedProcessJobs.filter(isTerminalProcessJob)) {
        consumedBackgroundProcessJobIds.add(job.id);
        markProcessJobContinuationConsumed(job.id);
      }
      if (results.length > 0) {
        return {
          type: "continue",
          message: buildBackgroundTaskResultsContext(results),
        };
      }
    }
    const coding = await codingRunTracker.completionGuard();
    return coding ?? getTodoCompletionBlocker(currentTodoState);
  };
  const enableFileCheckpointing = input.permissionMode !== "plan";
  // SDK 工具入口的 containment 根集（#546）必须与 guardrail 的
  // privateWriteRoots 白名单同源，否则 skills/plugins 等已授权写根会被新加的
  // 无条件复核误拒。
  //
  // 但 containment 根集与"additionalDirectories"是两个关注点（#639 复审 P2）：
  // 后者还会流进系统提示词、checkpoint 快照扫描、相对路径解析与 coding
  // tracker 工作区根。skills/plugins/.lume 等内部管理目录走 SDK 的
  // privateWriteRoots 专用通道（只放行写入），不进 additionalDirectories。
  const privateWriteRoots = resolveConfiguredPrivateWriteRoots({
    agentCwd: input.cwd,
    lumeWorkDir: input.lumeWorkDir,
    filesRoot: input.filesRoot,
    plansRoot: input.plansRoot,
    artifactsRoot: input.artifactsRoot,
    workspaceSlug: input.workspaceSlug,
    configuredRoots: getEffectiveLumeConfig(input.workspaceSlug).permissions?.privateWriteRoots,
  });
  const additionalDirectories = [
    ...new Set(
      [
        ...resolveConfiguredPrivateWriteRoots({
          agentCwd: input.cwd,
          lumeWorkDir: input.lumeWorkDir,
          filesRoot: input.filesRoot,
          plansRoot: input.plansRoot,
          artifactsRoot: input.artifactsRoot,
          workspaceSlug: input.workspaceSlug,
          configuredRoots: getEffectiveLumeConfig(input.workspaceSlug).permissions?.privateWriteRoots,
        }),
        ...(input.additionalDirectories ?? []),
        input.lumeWorkDir,
        // artifactsRoot 通常是 lumeWorkDir/artifacts：已被覆盖时跳过，免同树
        // 双扫进 checkpoint 快照（性能复审）
        ...(input.artifactsRoot && (!input.lumeWorkDir || !resolve(input.artifactsRoot).startsWith(resolve(input.lumeWorkDir) + "/"))
          ? [input.artifactsRoot]
          : []),
      ]
        .filter((directory): directory is string => Boolean(directory))
        .map((directory) => resolve(directory))
        .filter((directory) => directory !== resolve(input.cwd)),
    ),
  ];
  const persistedContinuation = resolvePersistedToolContinuation(
    input.messageMetadata,
  );
  // 悬空兜底：无单数 checkpoint 且标记为 dangling-fallback 时，从 session
  // history 检测未配对 tool_use，构造数组型 toolContinuations。
  const danglingFallbackContinuations = persistedContinuation
    ? undefined
    : resolveDanglingFallbackContinuations(
        input.messageMetadata,
        context.messages,
      );
  const toolContinuations = persistedContinuation
    ? [persistedContinuation]
    : danglingFallbackContinuations;
  const runtimeToolConfig = {
    ...input.toolConfig,
  };

  const providerRoutes = await buildProviderRoutes({
    channelId: input.channelId,
    resolvedModel: input.resolvedModel,
    resolvedModelId: input.resolvedModelId,
    lumeSessionId: input.lumeSessionId,
    channelProvider: input.channelProvider,
    provider: input.provider,
    apiKey: input.apiKey,
    workspaceSlug: input.workspaceSlug,
    apiType: input.apiType,
    openaiApiMode: input.openaiApiMode,
  });

  const agentOptions: AgentOptions = {
    subagentRunId: input.subagentRunId,
    provider: createRoutingPiAiProvider(providerRoutes),
    model: input.resolvedModel?.id ?? input.resolvedModelId,
    contextWindow: input.resolvedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    cwd: input.cwd,
    threadType: input.threadType,
    artifactsRoot: input.artifactsRoot,
    ...(Object.keys(runtimeToolConfig).length > 0
      ? { toolConfig: runtimeToolConfig }
      : {}),
    onAsyncEvent: handleAsyncEvent,
    onToolExecution: handleToolExecution,
    onBeforeToolExecution: codingRunTracker.beforeToolExecution,
    systemPrompt,
    runtimeContext,
    promptCache,
    tools: toolset.tools,
    sessionId: input.lumeSessionId,
    ...(toolContinuations ? { toolContinuations } : {}),
    ...(hasRuntimeCoreSessionTranscript(input.lumeSessionId, input.agentDir)
      ? { resume: input.lumeSessionId }
      : {}),
    ...(Object.keys(agentHooks).length > 0 ? { hooks: agentHooks } : {}),
    agents,
    // 真值透传（#571 第 4 项）：此前除 bypassPermissions 外一律折叠成 default，
    // 使 acceptEdits/dontAsk 在 Agent cfg 层失真。查询级 override（lume-runner）
    // 一直传真值，故行为面未变；此处修的是 cfg 谎言，防未来消费方踩假值。
    // 未设模式时归一 default：SDK init 消息的兜底是 || 'bypassPermissions'，
    // undefined 直达会被误报成完全自动（#684 review）。
    permissionMode: input.permissionMode ?? "default",
    includePartialMessages: true,
    skillsDirectories: resolveSkillDirectories(input.cwd, input.workspaceSlug),
    shouldLoadFilesystemSkill: createRuntimeSkillFilter(input.workspaceSlug),
    skills: runtimeSkills,
    resolveRuntimeTools: (tools, runtimeContext) =>
      ToolRuntime.resolveDynamicTools({
        tools,
        cwd: input.cwd,
        sessionId: input.lumeSessionId,
        threadType: runtimeContext.threadType ?? input.threadType,
        permissionMode: input.permissionMode,
        messageMetadata: input.messageMetadata,
        policyInput: {
          provider: input.provider,
          workspaceSlug: input.workspaceSlug,
          threadType: input.threadType,
          chatType: input.chatType,
          messageMetadata: input.messageMetadata,
        },
      }),
    registerGeneratedRuntimeTools: (tools) =>
      ToolRuntime.registerGeneratedTools({
        tools,
        sessionId: input.lumeSessionId,
      }),
    ...(input.userMessage?.trim() ? { completionGuard } : {}),
    additionalDirectories:
      additionalDirectories.length > 0 ? additionalDirectories : undefined,
    // 只放行写入的内部管理根（skills/plugins/.lume/plans/files），不进提示词
    // 与快照（见上方注释）
    privateWriteRoots,
    contextController: createKernelContextController({
      threadId: input.lumeSessionId,
      model: input.resolvedModel?.id ?? input.resolvedModelId,
      contextWindow: input.resolvedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: input.resolvedModel?.maxTokens,
      systemPrompt,
      memoryContext: contextAssembly.memoryContext,
      sessionMessages: context.messages,
      toolSchemaTokens: estimateToolSchemaTokens(toolset.tools),
    }),
    persistSession: true,
    enableFileCheckpointing,
    // 线程级共享读记录（#569）：每条消息新建的 Agent 都注入同一 cache，
    // stale-read 防护跨消息存活。分工：cache=mtime/size/content 新鲜度；
    // "须完整读"门控=file-access-ledger（线程删除时才清理，见
    // thread-file-state-cache.ts 注释）。
    fileStateCache: getThreadFileStateCache(input.lumeSessionId),
  };

  // Live 事件桥(#285):SDK 工具执行期直通的进度事件先落在本桥,runner 侧
  // 开始消费查询流时经 setLiveEventSink 把 tee 投影队列接进来。sink 未接时
  // (消费未开始/已结束)事件静默丢弃——进度本就是瞬态信号。
  const liveEventBridge: { sink: ((event: SDKMessage) => void) | null } = { sink: null };
  agentOptions.onLiveEvent = (event) => {
    liveEventBridge.sink?.(event);
  };

  const agent = createAgent(agentOptions);
  pendingCleanup.push(() => agent.close());
  pendingCleanup.push(() => {
    clearRuntimeToolDescriptors(input.lumeSessionId);
  });
  await agent.getInitializationResult();
  const resolvedTools = getResolvedAgentTools(agent, toolset.tools);

  const session: RuntimeCoreSessionLike = {
    sessionId: input.lumeSessionId,
    threadId: input.lumeSessionId,
    model: input.resolvedModel ?? {
      id: input.resolvedModelId,
      provider: input.provider,
    },
    messages: context.messages.map((message) => ({ role: message.role })),
    agent: {
      state: {
        systemPrompt,
      },
    },
    getActiveToolNames() {
      return resolvedTools.map((tool) => tool.name);
    },
    async dispose() {
      try {
        await agent.close();
      } finally {
        await codingRunTracker.dispose();
      }
      // node_repl 沙箱不再随 run 销毁：registry 按 thread 常驻（跨消息复用 globalThis.agent 等 binding，
      // 对齐 Codex；崩溃自愈见 registry.exec 的错误回收）。清理挂点=线程删除 + sidecar 退出 + idle 回收。
      getComputerUseSessionRegistry().clear(input.lumeSessionId);
      try {
        await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);
      } catch (error) {
        // M-2: a dispose failure (e.g. child-process kill error) must not skip the
        // descriptor/ledger/skill cleanup below — those are required to avoid leaking
        // state into the next session. Log and continue.
        log.warn("Plugin MCP disposeWorkspace failed during session dispose", {
          sessionId: input.lumeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      clearRuntimeToolDescriptors(input.lumeSessionId);
      // file-access-ledger 与线程级 fileStateCache 不随 run 清理（#569）：
      // 跨消息 stale 防护依赖记录存活；清理挂点=线程删除。
    },
  };

  const userMessageForModel = buildRuntimeUserMessageInput({
    userMessage: contextAssembly.userMessageForModel,
    contentBlocks: contextAssembly.userMessageContentBlocks,
    attachments: input.messageAttachments,
    workspaceSlug: input.workspaceSlug,
    threadId: input.lumeSessionId,
  });

  return {
    agent,
    session,
    sessionManager,
    systemPrompt,
    runtimeContext,
    userMessageForModel,
    memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
    tools: resolvedTools,
    getVerificationStatus: codingRunTracker.getVerificationStatus,
    beforeToolExecution: codingRunTracker.beforeToolExecution,
    getBaselineCommit: codingRunTracker.getBaselineCommit,
    getBaselineCommits: codingRunTracker.getBaselineCommits,
    getWorkspaceRoots: () => [resolve(input.cwd), ...additionalDirectories],
    refreshCodingChangeSet: codingRunTracker.refreshChangeSet,
    getLatestFileCheckpoint: () => agent.getLatestFileCheckpoint(),
    getVerificationReport: getCodingReport,
    setLiveEventSink: (sink) => {
      liveEventBridge.sink = sink;
    },
  };
}

function resolvePersistedToolContinuation(
  metadata: Record<string, unknown> | undefined,
): PersistedToolContinuation | undefined {
  const runtimeContinuation = metadata?.runtimeContinuation;
  if (!runtimeContinuation || typeof runtimeContinuation !== "object")
    return undefined;
  const record = runtimeContinuation as Record<string, unknown>;
  const checkpoint = record.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  const checkpointRecord = checkpoint as Record<string, unknown>;
  const toolCall = checkpointRecord.toolCall;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const call = toolCall as Record<string, unknown>;
  if (typeof call.id !== "string" || typeof call.name !== "string")
    return undefined;
  const inputHash = createHash("sha256")
    .update(JSON.stringify(call.input ?? null))
    .digest("hex");
  if (typeof call.inputHash === "string" && call.inputHash !== inputHash) {
    throw new Error("cold-start continuation 的工具输入指纹不匹配");
  }
  const synthetic = checkpointRecord.syntheticToolResult;
  const toolResult =
    synthetic && typeof synthetic === "object"
      ? (synthetic as ToolResult)
      : synthetic === undefined
        ? undefined
        : {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content:
              typeof synthetic === "string"
                ? synthetic
                : JSON.stringify(synthetic),
          };
  return {
    toolCall: {
      id: call.id,
      name: call.name,
      input: call.input,
    },
    ...(toolResult
      ? {
          toolResult: {
            ...toolResult,
            type: "tool_result",
            tool_use_id: call.id,
          },
        }
      : {}),
  };
}

/**
 * 从 runtime-core session context messages 检测末尾 assistant 未配对的
 * tool_use（悬空）。供 dangling-fallback 续跑与 getPendingResume 的
 * 崩溃运行判定共用。
 */
export function detectSessionDanglingToolUses(
  sessionMessages: RuntimeCoreSessionContextMessage[],
) {
  const normalized: NormalizedMessageParam[] = sessionMessages.map(
    (message) => {
      if (message.role === "toolResult") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId ?? "",
              content: "",
            },
          ],
        };
      }
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content as NormalizedMessageParam["content"],
      };
    },
  );
  return detectDanglingToolUses(normalized);
}

/**
 * 悬空兜底：messageMetadata.runtimeContinuation 标记为 dangling-fallback 且
 * 无单数 checkpoint 时，从 session history 检测末尾 assistant 未配对的
 * tool_use，复用 SDK 的 buildResumeContinuations 构造数组——只读/控制工具
 * 相同输入重放一次，副作用工具注入中断说明占位（不自动重放）。
 */
export function resolveDanglingFallbackContinuations(
  metadata: Record<string, unknown> | undefined,
  sessionMessages: RuntimeCoreSessionContextMessage[],
): PersistedToolContinuation[] | undefined {
  const runtimeContinuation = metadata?.runtimeContinuation;
  if (!runtimeContinuation || typeof runtimeContinuation !== "object")
    return undefined;
  if (
    (runtimeContinuation as Record<string, unknown>).source !==
    "dangling-fallback"
  )
    return undefined;
  const dangling = detectSessionDanglingToolUses(sessionMessages);
  if (dangling.length === 0) return undefined;
  return buildResumeContinuations(dangling, {
    isReadOnly: (toolName) => {
      const kind = classifyToolKind(toolName);
      return kind === "read" || kind === "control";
    },
  });
}
