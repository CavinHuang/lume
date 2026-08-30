/**
 * runtime-core SDK 工具装配(#177 自 run.ts 拆出,纯移动):
 * 基础 SDK 对齐工具、Lume 运行时工具、Agent/Delegate/WaitForDelegations
 * 委托工具定义与插件/MCP 工具合并。
 */
import {
  assertTaskRefDiscriminant,
  buildSidecarSubagentExecutionInput,
  buildSidecarSubagentRunContext,
  canDelegateFromThread,
  deriveDelegateTitle,
  parseTaskRef,
  resolveForegroundSubagentTimeoutMs,
  resolveSubagentModelOverride,
  createSubagentParentProgressReporter,
  resolveSubagentProgressTitle,
  runForegroundSubagentWithTimeout,
  runSidecarSubagent,
  runTaskLinkedSubagent,
  taskExecutorStopHandlers,
} from "./run-subagent";
import type { CreateRuntimeCoreSessionInput } from "./run";
import { buildWaitForDelegationsResult } from "./delegation-result";
import {
  AskUserQuestionTool,
  AgentTool,
  BashTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  MultiEditTool,
  NotebookEditTool,
  ProcessOutputTool,
  ProcessStopTool,
  EnterWorktreeTool,
  ExitWorktreeTool,
  type SDKMessage,
  type Agent,
  type AgentDefinition,
  type AgentOptions,
  type ApiType,
  type PromptCachePolicy,
  type RenderClient,
  type TodoState,
  SkillTool,
  createTodoTool,
  defineTool,
  type ToolDefinition,
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  OpenAiApiMode,
  LumeRuntimeEvent,
  FileReferenceBinding,
  PlanningTodo,
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { EnabledPluginContextItem } from "../host-ports";
import {
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceSkillsDir,
} from "../../infra/config-paths";
import {
  resolveMemoryRuntimeConfig,
  shouldIncludeCitations,
} from "../../memory-v2/policy";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { createLumeRuntimeTools } from "../tools/create-lume-tools";
import { createSdkWebTools } from "../tools/web/create-web-tools";
import { resolveSubagentSpawnPolicy } from "../subagents/subagent-policy";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import { getRuntimeCoreEntry } from "./runtime-entry";
import { createSelectWorktreeTool } from "./select-worktree-tool";
import { announceSubagentCompletion } from "../subagents/subagent-announce-service";
import { getRuntimeHostPorts } from "../host-ports";
import { createLogger } from "../../infra/logger";
import { getRuntimeCoreSessionDir } from "./session-store";
import { createMainTaskTools, type TaskCompletionSnapshot } from "../task/task-tools";
import { ToolRuntime, type ToolRuntimeDiagnostic } from "../tools/tool-runtime";
import {
  bindPlanningExecutionRun,
  resolvePlanningExecutionContext,
} from "../../planning/planning-execution-context";
import { getPlanningTodoStore } from "../../planning/planning-todo-store";
import { type PluginRuntimeAssembly } from "../plugins/runtime-bridge.js";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import { getComputerUseSessionRegistry } from "../tools/computer-use/computer-use-session";
import { type ResolvedComputerUseSurface } from "../tools/computer-use/computer-use-surface";
import { withDesktopAutomationFallbackGuard } from "../tools/computer-use/desktop-automation-fallback-guard";
import type { LumeToolDescriptor } from "../tools/tool-types";
import { type LumeWorkflowHookExecutionResult } from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";

const delegationLog = createLogger("delegation");

interface RuntimeCoreToolset {
  tools: ToolDefinition[];
  availableToolNames: string[];
  descriptorsByCanonicalName: Map<string, LumeToolDescriptor>;
  pluginDiagnostics: ToolRuntimeDiagnostic[];
  mcpDiagnostics: ToolRuntimeDiagnostic[];
}

const ListDirectoryTool = defineTool({
  name: "ls",
  description: "List files and directories in a path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute or relative directory path. Defaults to current directory.",
      },
    },
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    try {
      const targetPath = resolve(
        context.cwd,
        typeof input.path === "string" ? input.path : ".",
      );
      const entries = await readdir(targetPath, { withFileTypes: true });
      return {
        data: {
          path: targetPath,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file",
          })),
        },
      };
    } catch (error) {
      return {
        data: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true,
      };
    }
  },
});

function createBaseSdkAlignedTools(
  permissionMode: AgentSendInput["permissionMode"],
  options: {
    includeAskUserQuestion: boolean;
    includeWebTools: boolean;
    workspaceSlug?: string;
    renderClient?: RenderClient;
  },
): ToolDefinition[] {
  const readOnlyTools: ToolDefinition[] = [
    FileReadTool,
    GlobTool,
    GrepTool,
    ListDirectoryTool,
    ...(options.includeWebTools
      ? createSdkWebTools({
          workspaceSlug: options.workspaceSlug,
          renderClient: options.renderClient,
        })
      : []),
  ];

  if (permissionMode === "plan") {
    return [
      ...readOnlyTools,
      ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
      SkillTool,
    ];
  }

  return [
    ...readOnlyTools,
    ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
    FileWriteTool,
    FileEditTool,
    MultiEditTool,
    BashTool,
    ProcessOutputTool,
    ProcessStopTool,
    NotebookEditTool,
    SkillTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
  ];
}

export function buildRuntimeCoreTools(input: {
  cwd: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  modelRef?: string;
  provider?: string;
  computerUseSurface?: ResolvedComputerUseSurface;
  chatType?: AgentSendInput["chatType"];
  threadType?: AgentSendInput["threadType"];
  /** 主线程 Task 运行时创建后回调（完成门控/轮次提醒据此访问触碰任务快照） */
  onMainTaskRuntime?: (runtime: { getTouchedTasks: () => TaskCompletionSnapshot[] }) => void;
  permissionMode?: AgentSendInput["permissionMode"];
  subagentDefinition?: AgentDefinition;
  messageMetadata?: Record<string, unknown>;
  planningClientSubmissionId?: string;
  fileReferenceBinding?: FileReferenceBinding;
  originalUserInstruction?: string;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
  initialTodoState?: TodoState | null;
  runId?: string;
  renderClient?: RenderClient;
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
  mcpTools?: ToolDefinition[];
  mcpDiagnostics?: ToolRuntimeDiagnostic[];
  /** Plugin command-tool ToolDefinitions built by PluginRuntimeBridge (Phase 3b). */
  pluginCommandTools?: ToolDefinition[];
  /** Plugin MCP tool definitions (Phase MCP Merge-A) from the plugin-scoped MCP manager. */
  pluginMcpTools?: ToolDefinition[];
  abortSignal?: AbortSignal;
}): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations =
    memoryRuntimeConfig.recallNotice !== "off" &&
    shouldIncludeCitations(
      memoryRuntimeConfig.citationsMode,
      input.chatType ?? "direct",
    );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const baseTools = createBaseSdkAlignedTools(permissionMode, {
    includeAskUserQuestion: automationExecution !== true,
    includeWebTools: true,
    workspaceSlug: input.workspaceSlug,
    renderClient: input.renderClient,
  }).map((tool) =>
    tool.name === "Bash" && input.computerUseSurface === "sky"
      ? withDesktopAutomationFallbackGuard(tool, {
          computerUseActive: () =>
            getComputerUseSessionRegistry().isActive(input.sessionId),
          originalUserInstruction: input.originalUserInstruction,
        })
      : tool,
  );
  const todoTool = createTodoTool({
    threadId: input.sessionId,
    initialTodos: input.initialTodoState?.todos,
    onTodoUpdated: input.emitTodoUpdated,
  });
  const planningClientSubmissionId = input.planningClientSubmissionId;
  if (
    input.runId &&
    planningClientSubmissionId &&
    resolvePlanningExecutionContext({
      clientSubmissionId: planningClientSubmissionId,
    })
  ) {
    bindPlanningExecutionRun(planningClientSubmissionId, input.runId);
  }
  const planningExecutionContext = resolvePlanningExecutionContext({
    runId: input.runId,
    clientSubmissionId: planningClientSubmissionId,
  });
  const lumeTools = createLumeRuntimeTools({
    threadId: input.sessionId,
    cwd: input.cwd,
    filesRoot: input.filesRoot,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    modelRef: input.modelRef,
    threadType: input.threadType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    originalUserInstruction: input.originalUserInstruction,
    computerUseSurface: input.computerUseSurface,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    runId: input.runId,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitDesktopActionVisualEvent: input.emitRuntimeEvent,
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {}),
    planningExecutionContext,
  });

  const policyInput = {
    provider: input.provider,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata,
  };

  const isMainTaskThread =
    input.threadType === "main" || input.threadType === undefined;
  // SelectWorktree 仅主任务线程 + 交互执行注入：后台自动任务与子 Agent 不得
  // 重定向交互会话的开发目录（对齐 Proma 对 automation/delegation 的排除）；
  // plan 模式与 Enter/ExitWorktree 一致排除（绑定是会话状态变更）。
  const selectWorktreeTool = createSelectWorktreeTool({
    threadId: input.sessionId,
    enabled: isMainTaskThread && automationExecution !== true && permissionMode !== "plan",
  });
  const mainTaskRuntime = isMainTaskThread
    ? createMainTaskTools({
        sessionDir: getRuntimeCoreSessionDir(input.sessionId),
        threadId: input.sessionId,
        runId: input.runId,
        emitRuntimeEvent: input.emitRuntimeEvent,
        onCancellationRequested: ({ executorRef }) => {
          if (executorRef) taskExecutorStopHandlers.get(executorRef)?.();
        },
      })
    : undefined;
  if (mainTaskRuntime) input.onMainTaskRuntime?.(mainTaskRuntime);

  const mainTaskTools = mainTaskRuntime?.tools ?? [];

  const delegateTool: ToolDefinition = {
    ...AgentTool,
    name: "Delegate",
    description:
      "Delegate a task to an INDEPENDENT, sidebar-visible child session. Use for long-running or important tasks that should be tracked as their own conversation. The child session appears under the parent in the sidebar. Returns the child's final result. Only one level of delegation is allowed. Set run_in_background=true to start the child asynchronously and return immediately with a delegationId; later collect results with WaitForDelegations.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task for the delegated child session",
        },
        description: {
          type: "string",
          description: "A short (3-5 word) description of the task",
        },
        thread_title: {
          type: "string",
          description:
            "Optional title for the child session (defaults to description)",
        },
        subagent_type: { type: "string" },
        model: { type: "string" },
        mode: {
          type: "string",
          enum: [
            "default",
            "acceptEdits",
            "bypassPermissions",
            "plan",
            "dontAsk",
            "auto",
          ],
        },
        task_ref: {
          type: "object",
          required: ["taskListId", "taskId", "claimToken"],
          properties: {
            taskListId: { type: "string" },
            taskId: { type: "string" },
            claimToken: { type: "string" },
          },
          description:
            "Associate this independently-created executor with a claimed main-agent Task.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "If true, start the child session asynchronously and return immediately with a delegationId. Use WaitForDelegations to collect results later.",
        },
      },
      required: ["prompt", "description"],
    },
    // 独立 childThreadId + registry 同步 Map 操作，可并发；
    // spawn policy 的 maxFanout(6) 兜底限流。
    isConcurrencySafe: () => true,
    async call(toolInput: any, context: any) {
      const parentThreadId = context.sessionId ?? "";
      const policy = resolveSubagentSpawnPolicy({
        parentThreadId,
        parentPermissionMode: permissionMode,
      });
      if (!policy.ok) {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: policy.error ?? "spawn policy rejected",
          is_error: true,
        };
      }
      if (toolInput.task_ref !== undefined) {
        if (!mainTaskRuntime)
          return {
            type: "tool_result" as const,
            tool_use_id: "",
            content: "Task-linked Delegate calls are main-agent only",
            is_error: true,
          };
        try {
          assertTaskRefDiscriminant(toolInput);
          if (toolInput.run_in_background === true)
            throw new Error(
              "Task-linked Delegate calls are serialized and cannot run in background",
            );
          const taskRef = parseTaskRef(toolInput.task_ref, parentThreadId);
          const modelOverride = resolveSubagentModelOverride({
            toolInput,
            workspaceSlug: input.workspaceSlug,
          });
          return await runTaskLinkedSubagent({
            toolInput,
            context,
            taskStore: mainTaskRuntime.store,
            taskRef,
            parentThreadId,
            modelOverride,
            workspaceId: input.workspaceId,
            workspaceSlug: input.workspaceSlug,
            channelId: input.channelId,
            chatType: input.chatType,
            messageMetadata: input.messageMetadata,
            fileReferenceBinding: input.fileReferenceBinding,
            permissionMode,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitBrowserAuthRequest: input.emitBrowserAuthRequest,
            emitDesktopActionRequest: input.emitDesktopActionRequest,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
          });
        } catch (error) {
          return {
            type: "tool_result" as const,
            tool_use_id: "",
            content: error instanceof Error ? error.message : String(error),
            is_error: true,
          };
        }
      }
      // D7: 仅允许一级 delegate —— 当前父 thread 若已是某 subagent run 的 child，拒绝
      const depthGuard = canDelegateFromThread(parentThreadId);
      if (!depthGuard.ok) {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: depthGuard.error ?? "depth rejected",
          is_error: true,
        };
      }
      const modelOverride = resolveSubagentModelOverride({
        toolInput,
        workspaceSlug: input.workspaceSlug,
      });
      // ★ 关键差异：创建会话栏可见的子会话 thread（带 parentThreadId）
      const childMeta = getRuntimeHostPorts().createThreadWithModelRef(
        typeof toolInput.thread_title === "string"
          ? toolInput.thread_title
          : typeof toolInput.description === "string"
            ? toolInput.description
            : undefined,
        modelOverride.modelRef,
        modelOverride.channelId ?? input.channelId,
        input.workspaceId,
        parentThreadId,
        modelOverride.resolvedModelId ?? context.model,
        { fileContextMode: "inherit" },
      );
      const subagentRun = buildSidecarSubagentRunContext({
        parentThreadId,
        parentToolUseId: context.toolUseId,
        toolInput,
        policy,
        createChildThreadId: () => childMeta.id,
      });
      const enrichedContext = {
        ...context,
        emitEvent: input.emitSdkMessage
          ? (event: SDKMessage) => {
              input.emitSdkMessage!(event);
            }
          : context.emitEvent,
        onSubagentEnd: async ({
          status,
          output,
          error,
        }: {
          status: "completed" | "errored" | "aborted" | "timed_out";
          output?: string;
          error?: string;
        }) => {
          getSubagentRunRegistry().update(subagentRun.runId, {
            status,
            outcome: { output, error },
          });
          const run = getSubagentRunRegistry().get(subagentRun.runId);
          if (run) await announceSubagentCompletion({ run });
          const newTitle = deriveDelegateTitle(childMeta.title, output);
          if (newTitle && newTitle !== childMeta.title) {
            getRuntimeHostPorts().updateThreadMeta(childMeta.id, { title: newTitle });
          }
        },
      };
      const runInBackground = toolInput.run_in_background === true;
      // 前台折叠进度投影（#560②/#777）：仅前台发——后台委托的工具卡即刻返回，
      // 无消费语境；后台可见性走会话栏子线程 + WaitForDelegations。
      const progressReporter = runInBackground
        ? undefined
        : createSubagentParentProgressReporter({
            parentThreadId,
            runId: input.runId ?? parentThreadId,
            title: resolveSubagentProgressTitle(toolInput),
            emit: (event) => input.emitRuntimeEvent?.(event),
          });
      const executionInput = buildSidecarSubagentExecutionInput({
        forwardedToolInput: subagentRun.forwardedToolInput,
        modelOverride,
        runInBackground,
      });
      getSubagentRunRegistry().create({
        ...subagentRun.registryInput,
        parentRunId: input.runId ?? subagentRun.registryInput.parentRunId,
        background: runInBackground,
        deliveryThreadId: parentThreadId,
        parentToolUseId: context.toolUseId,
        threadBound: true,
        ...(modelOverride.modelRef ? { modelRef: modelOverride.modelRef } : {}),
        ...(modelOverride.channelId
          ? { channelId: modelOverride.channelId }
          : input.channelId
            ? { channelId: input.channelId }
            : {}),
        ...(modelOverride.resolvedModelId
          ? { modelId: modelOverride.resolvedModelId }
          : context.model
            ? { modelId: context.model }
            : {}),
      });
      const executeSubagent = () =>
        runSidecarSubagent({
          toolInput: executionInput,
          context: enrichedContext,
          runId: subagentRun.runId,
          childThreadId: childMeta.id,
          parentThreadId,
          deliveryThreadId: parentThreadId,
          parentToolUseId: context.toolUseId,
          subagentType: subagentRun.registryInput.resolvedAgentId,
          modelOverride,
          channelId: input.channelId,
          workspaceId: input.workspaceId,
          chatType: input.chatType,
          messageMetadata: input.messageMetadata,
          fileReferenceBinding: input.fileReferenceBinding,
          onRuntimeEvent: (event) => {
            // 桥接 registry runId ↔ 子线程 attempt runId,web 投影按此匹配事件流
            if (event.runId) {
              try {
                getSubagentRunRegistry().bindRuntimeRun(subagentRun.runId, event.runId);
              } catch {
                // bind 失败不阻断事件流
              }
            }
            input.emitRuntimeEvent?.(event);
          },
          progressReporter,
          permissionMode,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitBrowserAuthRequest: input.emitBrowserAuthRequest,
          emitDesktopActionRequest: input.emitDesktopActionRequest,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
        });
      if (runInBackground) {
        // ★ 注册 completion 信号量，供 WaitForDelegations 感知完成（须在 resolve 之前注册）
        getSubagentRunRegistry().createDelegationCompletion(subagentRun.runId);
        const stopBackgroundSubagent = () => {
          void Promise.resolve()
            .then(() => getRuntimeCoreEntry().stopAgentRuntime(childMeta.id))
            .catch(() => undefined);
        };
        if (input.abortSignal?.aborted) {
          // abort 竞窗:signal 已中止时 listener 永不触发,直接停掉刚 spawn 的子代理
          stopBackgroundSubagent();
        }
        input.abortSignal?.addEventListener("abort", stopBackgroundSubagent, {
          once: true,
        });
        void executeSubagent()
          .then(async (execution) => {
            try {
              await enrichedContext.onSubagentEnd?.({
                runId: subagentRun.runId,
                status: execution.status,
                output: execution.output,
                error: execution.error,
              });
            } catch (error) {
              // 收尾失败(announce/persist 等)不得把已写入的终态覆盖为 errored
              delegationLog.warn("delegate onSubagentEnd failed", { error: error instanceof Error ? error.message : String(error) });
            }
            // ★ resolve 信号量，唤醒等待方
            getSubagentRunRegistry().resolveDelegationCompletion(
              subagentRun.runId,
            );
          })
          .catch(async (err: any) => {
            const existing = getSubagentRunRegistry().get(subagentRun.runId);
            // 已有终态(then 内部分完成)时不覆盖,避免 completed→errored 翻转
            if (!existing || !["completed", "errored", "aborted", "timed_out", "canceled"].includes(existing.status)) {
              getSubagentRunRegistry().update(subagentRun.runId, {
                status: "errored",
                outcome: { error: err?.message ?? String(err) },
              });
              const run = getSubagentRunRegistry().get(subagentRun.runId);
              if (run) await announceSubagentCompletion({ run });
            }
            // ★ 出错时也要 resolve，避免等待方永久挂起
            getSubagentRunRegistry().resolveDelegationCompletion(
              subagentRun.runId,
            );
          })
          .finally(() => {
            input.abortSignal?.removeEventListener(
              "abort",
              stopBackgroundSubagent,
            );
          });
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({
            delegationId: subagentRun.runId,
            childThreadId: childMeta.id,
            status: "started",
          }),
        };
      }
      try {
        // 前台 run 也注册 completion:同批并发的 WaitForDelegations 不至于为它白等满 timeout
        getSubagentRunRegistry().createDelegationCompletion(subagentRun.runId);
        const stopForegroundSubagent = () => {
          void Promise.resolve()
            .then(() => getRuntimeCoreEntry().stopAgentRuntime(childMeta.id))
            .catch(() => undefined);
        };
        if (input.abortSignal?.aborted) {
          stopForegroundSubagent();
        }
        input.abortSignal?.addEventListener("abort", stopForegroundSubagent, {
          once: true,
        });
        try {
          const execution = await runForegroundSubagentWithTimeout({
            execution: executeSubagent(),
            childThreadId: childMeta.id,
            timeoutMs: resolveForegroundSubagentTimeoutMs(),
            stopSubagent: async (threadId: string) => {
              return getRuntimeCoreEntry().stopAgentRuntime(threadId);
            },
          });
          // 终态帧在超时判定后补发：超时路径父流已继续，静默关闭不再回写
          if (execution.status !== "timed_out") {
            progressReporter?.finalize(execution.status);
          } else {
            progressReporter?.close();
          }
          try {
            await enrichedContext.onSubagentEnd?.({
              runId: subagentRun.runId,
              status: execution.status,
              output: execution.output,
              error: execution.error,
            });
          } catch (error) {
            delegationLog.warn("delegate onSubagentEnd failed", { error: error instanceof Error ? error.message : String(error) });
          }
          return execution.result;
        } finally {
          input.abortSignal?.removeEventListener("abort", stopForegroundSubagent);
          getSubagentRunRegistry().resolveDelegationCompletion(
            subagentRun.runId,
          );
        }
      } catch (err: any) {
        progressReporter?.finalize("errored");
        const existing = getSubagentRunRegistry().get(subagentRun.runId);
        if (!existing || !["completed", "errored", "aborted", "timed_out", "canceled"].includes(existing.status)) {
          getSubagentRunRegistry().update(subagentRun.runId, {
            status: "errored",
            outcome: { error: err?.message ?? String(err) },
          });
        }
        throw err;
      }
    },
  };

  const waitForDelegationsTool: ToolDefinition = {
    name: "WaitForDelegations",
    description:
      "Wait for previously delegated background child sessions to finish and return their results. Use after Delegate(run_in_background=true). Input: mode 'all'(default)|'any', min_completed (for any, default 1), timeout_seconds (default 1800, max 7200). Returns status (completed|timeout), completedCount, runningCount, and a delegations array with each child's result.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["all", "any"],
          description:
            "'all' waits for every delegation; 'any' returns once min_completed have finished",
        },
        min_completed: {
          type: "number",
          description:
            "For mode 'any': number of completions to wait for (default 1)",
        },
        timeout_seconds: {
          type: "number",
          description: "Max wait in seconds (default 1800, max 7200)",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return "Wait for delegated background sessions.";
    },
    async call(toolInput: any, context: any) {
      const parentThreadId = context.sessionId ?? "";
      return buildWaitForDelegationsResult(
        toolInput ?? {},
        parentThreadId,
        getSubagentRunRegistry(),
        { abortSignal: context.abortSignal },
      );
    },
  };

  const taskLoopTools =
    input.threadType === "subagent"
      ? [todoTool]
      : [
          ...(isMainTaskThread ? mainTaskTools : []),
          delegateTool,
          waitForDelegationsTool,
          todoTool,
        ];

  return ToolRuntime.build({
    cwd: input.cwd,
    sessionId: input.sessionId,
    permissionMode,
    threadType: input.threadType,
    subagentDefinition: input.subagentDefinition,
    messageMetadata: input.messageMetadata,
    policyInput,
    pluginDiagnostics: input.pluginDiagnostics,
    mcpDiagnostics: input.mcpDiagnostics,
        groups: [
          { source: "sdk", tools: selectWorktreeTool ? [...baseTools, selectWorktreeTool] : baseTools },
          { source: "task", tools: taskLoopTools },
          { source: "lume", tools: lumeTools.customTools as ToolDefinition[] },
          ...(input.mcpTools?.length
            ? [
                {
                  source: "mcp" as const,
                  tools: sortDiscoveredTools(input.mcpTools),
                },
              ]
            : []),
          ...(input.pluginCommandTools?.length
            ? [
                {
                  source: "plugin" as const,
                  tools: sortDiscoveredTools(input.pluginCommandTools),
                },
              ]
            : []),
          ...(input.pluginMcpTools?.length
            ? [
                {
                  source: "plugin" as const,
                  tools: sortDiscoveredTools(input.pluginMcpTools),
                },
              ]
            : []),
        ],
  });
}


function sortDiscoveredTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

export function isAutomationExecution(
  messageMetadata?: Record<string, unknown>,
): boolean {
  if (!messageMetadata) {
    return false;
  }
  return (
    typeof messageMetadata.automationJobId === "string" ||
    typeof messageMetadata.automationTrigger === "string"
  );
}
