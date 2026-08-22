import {
  createAgent,
  markProcessJobContinuationConsumed,
  type SDKMessage,
  type Agent,
  type FileCheckpoint,
  type AgentOptions,
  type CompletionGuardResult,
  type ApiType,
  type ContentBlockParam,
  type ToolResult,
  createTodoTool,
  type ToolDefinition,
  type PersistedToolContinuation,
  type NormalizedMessageParam,
  setLspIdleTimeout,
  warmupLspClients,
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
import {
  buildBuiltinAgents,
  loadCustomAgents,
} from "../../agent/agent-prompt-builder";
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
import {
  getChannelById,
  resolveChannelModelBinding,
} from "../../channel/channel-manager";
import {
  getEffectiveLumeConfig,
  getEffectivePluginRuntimeConfig,
} from "../../system/lume-config-service";
import { getSidecarRenderClient } from "../tools/web/render-client-holder";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { getSubagentCoordinator } from "../../agent/subagents/subagent-coordinator";
import { buildSubagentWorkContext } from "../../agent/subagents/subagent-dispatch-policy";
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
import {
  assemblePluginRuntime,
} from "../plugins/runtime-bridge.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import {
  DEFAULT_PLUGIN_STATE_PATH,
  FilePluginStateStore,
} from "../plugins/plugin-state-store.js";
import { buildPluginAgentHooks } from "../plugins/plugin-hooks-bridge.js";
import { resolveRuntimeLspConfig } from "../lsp/lsp-config.js";
import {
  buildPluginMcpManager,
  buildPluginIdIndex,
  PLUGIN_MCP_WORKSPACE_SLUG,
} from "../plugins/plugin-mcp-bridge.js";
import { clearRuntimeToolDescriptors } from "../tools/tool-descriptor-session";
import { clearRuntimeFileAccessLedger } from "../tools/file-access-ledger";
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
} from "../runner/todo-state";
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store";
import { persistAbortContinuation } from "../interruption/abort-continuation";
import { classifyToolKind } from "../interruption/approval-service";
import {
  applyWorkflowHookEffectsSafely,
  buildEnabledPluginContext,
  buildRuntimeCoreTools,
  createRuntimeSkillFilter,
  estimateToolSchemaTokens,
  executeWorkflowHookSafely,
  fingerprintToolSchema,
  isAutomationExecution,
  resolvePlanningTodoContext,
  resolvePromptCachePolicy,
  resolveSdkApiType,
  resolveSkillDirectories,
} from "./run-tools";
import {
  createBoundSubagentTaskReportTool,
  getResolvedAgentTools,
  resolveBoundSubagentIdentity,
} from "./run-subagent";
import {
  buildBackgroundTaskResultsContext,
  isTerminalProcessJob,
  publishBackgroundTaskNotificationToBus,
  publishCodingReportToBus,
  publishLspDiagnosticsToBus,
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

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  lumeWorkDir?: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  projectRoot?: string;
  additionalDirectories?: string[];
  fileContextId?: string;
  fileReferenceBinding?: FileReferenceBinding;
  agentDir: string;
  userMessage?: string;
  messageParts?: AgentSendInput["messageParts"];
  provider: string;
  channelProvider?: string;
  openaiApiMode?: OpenAiApiMode;
  apiType?: ApiType;
  modelRef?: string;
  resolvedModelId: string;
  resolvedModel?: RuntimeCoreResolvedModel;
  apiKey: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  subagentType?: string;
  subagentRunId?: string;
  subagentId?: string;
  subagentTaskId?: string;
  subagentAttempt?: number;
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageAttachments?: AgentSendInput["messageAttachments"];
  commentAttachments?: AgentSendInput["commentAttachments"];
  browserAttachments?: AgentSendInput["browserAttachments"];
  messageMetadata?: Record<string, unknown>;
  planningClientSubmissionId?: string;
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
  runId?: string;
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  applyWorkflowHookEffects?: (
    result: LumeWorkflowHookExecutionResult,
  ) => Promise<void> | void;
  trace?: ContextAssemblyInput["trace"];
  toolConfig?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

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

async function createRuntimeCoreSessionImpl(
  input: CreateRuntimeCoreSessionInput,
  pendingCleanup: Array<() => Promise<unknown> | void>,
): Promise<CreateRuntimeCoreSessionResult> {
  const boundSubagentIdentity = resolveBoundSubagentIdentity(input);
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
      void createFileBackedRunContinuationStore(sessionDir)
        .upsert({
          version: 2,
          runId: input.runId,
          threadId: input.lumeSessionId,
          status: "waiting_background",
          checkpoint: {
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
          },
          reason: "后台命令已持久化，恢复时重新附着而不重复执行。",
          createdAt: now,
          updatedAt: now,
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
          if (
            !continuation ||
            continuation.version !== 2 ||
            continuation.checkpoint.processJobId !== event.task_id
          )
            return;
          return continuationStore.update(input.runId!, {
            status: "ready_to_resume",
            checkpoint: {
              ...continuation.checkpoint,
              step: "after_tool_result",
              syntheticToolResult: {
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
              },
            },
            reason: `后台命令已进入终态：${event.status}。`,
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
    // 批次5 第二入口:lsp_diagnostics 同批再上总线(与 task_notification 同构旁路)
    if (event.type === "system" && event.subtype === "lsp_diagnostics") {
      publishLspDiagnosticsToBus({
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
  const boundSubagentReportTool = boundSubagentIdentity
    ? createBoundSubagentTaskReportTool(boundSubagentIdentity)
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
    ...buildBuiltinAgents(),
    ...loadCustomAgents(input.workspaceSlug),
  };
  const subagentDefinition = input.subagentType
    ? agents[input.subagentType]
    : undefined;
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d, buildPluginAgentHooks).
  const pluginConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
  const computerUseConfig = getEffectiveLumeConfig(input.workspaceSlug).models
    ?.computerUse;
  const channelProvider = input.modelRef
    ? (resolveChannelModelBinding(input.modelRef, "chat")?.channel.provider ??
      input.provider)
    : input.provider;
  const computerUseSurface = resolveComputerUseSurface({
    agentSurface: computerUseConfig?.agentSurface,
    modelRef: input.modelRef,
    skyModelRefs: computerUseConfig?.skyModelRefs,
    channelProvider,
  });
  const pluginManager = new SidecarPluginManager();
  const registeredPlugins = await pluginManager.listRegistered({
    enabled: pluginConfig.enabled,
    // Do not auto-load project-local .lume/plugins just because the Agent cwd is a real project.
    directories: pluginConfig.directories,
  });
  const discoveredLspConfig = await resolveRuntimeLspConfig({
    cwd: input.cwd,
    user: getEffectiveLumeConfig(input.workspaceSlug).lsp,
    plugins: registeredPlugins,
  });
  const runLspConfig =
    input.toolConfig?.lsp &&
    typeof input.toolConfig.lsp === "object" &&
    !Array.isArray(input.toolConfig.lsp)
      ? (input.toolConfig.lsp as Record<string, unknown>)
      : undefined;
  const lspConfig = {
    ...discoveredLspConfig,
    ...(runLspConfig ?? {}),
    ...(discoveredLspConfig.servers ||
    (runLspConfig?.servers && typeof runLspConfig.servers === "object")
      ? {
          servers: {
            ...(discoveredLspConfig.servers ?? {}),
            ...(runLspConfig?.servers &&
            typeof runLspConfig.servers === "object"
              ? (runLspConfig.servers as Record<string, unknown>)
              : {}),
          },
        }
      : {}),
  };
  setLspIdleTimeout(lspConfig.idleTimeoutMs);
  // 默认保持懒启动；lazy: false 时在 run 启动阶段后台预热 rootMarkers 匹配的
  // server（warmupLspClients 内置 5s race，慢环境自动放行），首个 Write/Edit
  // 不再付 language server 冷启动代价。fire-and-forget，不阻塞首事件。
  if (lspConfig.enabled !== false && lspConfig.lazy === false) {
    void warmupLspClients(input.cwd, { lsp: lspConfig }).catch(() => undefined);
  }
  const computerUsePlugin = registeredPlugins.find(
    (plugin) => plugin.pluginId === "computer-use",
  );
  log.info("Computer Use capability selected", {
    sessionId: input.lumeSessionId,
    runId: input.runId,
    computerUseSurface,
    pluginVersion: computerUsePlugin?.version,
    modelRef: input.modelRef,
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
    workspaceSlug: input.workspaceSlug,
  });
  const agentHooks = { ...pluginAgentHooks };
  const advisorConfig = getEffectiveLumeConfig(input.workspaceSlug).models
    ?.advisor;
  if (
    input.threadType !== "subagent" &&
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
                workspaceSlug: input.workspaceSlug,
                cwd: input.cwd,
                userMessage: input.userMessage,
                messages: hookInput.messages,
              });
              if (!review) return undefined;
              input.emitAdvisorReview?.(review);
            } catch (error) {
              log.warn("Advisor review failed", {
                sessionId: input.lumeSessionId,
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
    workspaceSlug: input.workspaceSlug,
    stdioCwd: input.cwd,
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
  const workspaceMcpRuntime = input.workspaceSlug
    ? await workspaceMcpManager
        .createRuntimeTools(input.workspaceSlug)
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
  if (input.workspaceSlug) {
    pendingCleanup.push(() =>
      workspaceMcpManager.disposeWorkspace(input.workspaceSlug!),
    );
  }
  const pluginAwareMcpResourceTools =
    input.workspaceSlug && pluginAssembly.mcpServers.length > 0
      ? createPluginAwareMcpResourceTools({
          workspaceSlug: input.workspaceSlug,
          pluginServers: pluginAssembly.mcpServers,
          workspaceMcpManager,
          pluginMcpManager,
        })
      : [];
  const toolset = buildRuntimeCoreTools({
    cwd: input.cwd,
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
    boundSubagentReportTool,
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
  const runtimeSkills = toolset.availableToolNames.includes("mcp__browser__snapshot")
    && !input.browserAttachments?.length
    ? surfaceSkills.filter((skill) => skill.name !== "browser:browser")
    : surfaceSkills;
  const enabledPlugins = buildEnabledPluginContext(
    registeredPlugins,
    { ...pluginAssembly, skills: runtimeSkills },
  );
  const contextTokenBudget = input.resolvedModel?.contextWindow ?? 32_000;
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
    agentSystemPrompt: boundSubagentIdentity
      ? [
          subagentDefinition?.prompt,
          "You are executing one bound Subagent Task. Do not create nested subagents or change the task acceptance criteria. Before ending this run, call TaskReport with submitted, failed, or blocked status and a concise summary. TaskReport is a submission to the parent agent, never final acceptance.",
          `Bound task: ${boundSubagentIdentity.taskId}; attempt: ${input.subagentAttempt ?? 1}.`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : subagentDefinition?.prompt,
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
  const unresolvedSubagentTasks =
    input.threadType === "subagent"
      ? []
      : getSubagentCoordinator()
          .list(input.lumeSessionId)
          .tasks.filter(
            (task) =>
              task.status === "open" ||
              task.status === "running" ||
              task.status === "awaiting_review",
          );
  const systemPrompt = contextAssembly.systemPrompt;
  const runtimeContext = [
    contextAssembly.runtimeContext,
    buildSubagentWorkContext(unresolvedSubagentTasks),
  ]
    .filter(Boolean)
    .join("\n\n");
  const context = sessionManager.buildSessionContext();
  const existingCompletionGuard = boundSubagentIdentity
    ? () =>
        getSubagentCoordinator().getRunCompletionBlocker(
          boundSubagentIdentity.runId,
        )
    : input.runId
      ? () =>
          getSubagentCoordinator().getCompletionBlocker(
            input.lumeSessionId,
            input.runId!,
          )
      : undefined;
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
              while (
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
    const existing = await existingCompletionGuard?.();
    if (existing) return existing;
    const coding = await codingRunTracker.completionGuard();
    return coding ?? getTodoCompletionBlocker(currentTodoState);
  };
  const codingCompletionEnabled = !(
    input.subagentRunId &&
    input.subagentTaskId &&
    !input.runId &&
    !boundSubagentIdentity
  );
  const enableFileCheckpointing = input.permissionMode !== "plan";
  const additionalDirectories = [
    ...new Set(
      [
        ...(input.additionalDirectories ?? []),
        input.lumeWorkDir,
        input.artifactsRoot,
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
    ...(input.toolConfig ?? {}),
    ...(Object.keys(lspConfig).length > 0 ? { lsp: lspConfig } : {}),
  };

  const apiType =
    input.apiType ?? resolveSdkApiType(input.provider, input.openaiApiMode);
  const primaryChannel = input.channelId
    ? getChannelById(input.channelId)
    : undefined;
  const providerRoutes: PiAiProviderRoute[] = [
    primaryChannel
      ? await createConnectionPiAiRoute({
          channel: primaryChannel,
          modelId: input.resolvedModel?.id ?? input.resolvedModelId,
          sessionId: input.lumeSessionId,
        })
      : {
          modelId: input.resolvedModel?.id ?? input.resolvedModelId,
          apiType,
          providerId: input.channelProvider ?? input.provider,
          baseUrl: input.resolvedModel?.baseUrl ?? "",
          apiKey: input.apiKey,
          contextWindow: input.resolvedModel?.contextWindow,
          maxTokens: input.resolvedModel?.maxTokens,
          supportsReasoning: input.resolvedModel?.reasoning,
          sessionId: input.lumeSessionId,
        },
  ];
  const configuredFallbackRefs =
    getEffectiveLumeConfig(input.workspaceSlug).models?.agent
      ?.fallbackModelRefs ?? [];
  for (const fallbackRef of configuredFallbackRefs) {
    const binding = resolveChannelModelBinding(fallbackRef, "chat");
    if (!binding) continue;
    if (
      binding.channel.id === input.channelId &&
      binding.modelId === providerRoutes[0]?.modelId
    )
      continue;
    try {
      providerRoutes.push(
        await createConnectionPiAiRoute({
          channel: binding.channel,
          modelId: binding.modelId,
          sessionId: input.lumeSessionId,
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
  const agentOptions: AgentOptions = {
    provider: createRoutingPiAiProvider(providerRoutes),
    model: input.resolvedModel?.id ?? input.resolvedModelId,
    contextWindow: input.resolvedModel?.contextWindow ?? 32_000,
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
    permissionMode:
      input.permissionMode === "bypassPermissions"
        ? "bypassPermissions"
        : "default",
    includePartialMessages: true,
    skillsDirectories: resolveSkillDirectories(input.cwd, input.workspaceSlug),
    shouldLoadFilesystemSkill: createRuntimeSkillFilter(input.workspaceSlug),
    skills: runtimeSkills,
    resolveRuntimeTools: (tools, runtimeContext) =>
      ToolRuntime.resolveDynamicTools({
        tools,
        requiredTools: boundSubagentReportTool
          ? [boundSubagentReportTool]
          : undefined,
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
    ...(codingCompletionEnabled &&
    (input.userMessage?.trim() || existingCompletionGuard)
      ? { completionGuard }
      : {}),
    additionalDirectories:
      additionalDirectories.length > 0 ? additionalDirectories : undefined,
    contextController: createKernelContextController({
      threadId: input.lumeSessionId,
      model: input.resolvedModel?.id ?? input.resolvedModelId,
      contextWindow: input.resolvedModel?.contextWindow ?? 32_000,
      maxOutputTokens: input.resolvedModel?.maxTokens,
      systemPrompt,
      memoryContext: contextAssembly.memoryContext,
      sessionMessages: context.messages,
      toolSchemaTokens: estimateToolSchemaTokens(toolset.tools),
    }),
    persistSession: true,
    enableFileCheckpointing,
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
    clearRuntimeFileAccessLedger(input.lumeSessionId);
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
      if (input.workspaceSlug) {
        await workspaceMcpManager
          .disposeWorkspace(input.workspaceSlug)
          .catch((error) => {
            log.warn("Workspace MCP dispose failed", {
              sessionId: input.lumeSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      clearRuntimeToolDescriptors(input.lumeSessionId);
      clearRuntimeFileAccessLedger(input.lumeSessionId);
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
