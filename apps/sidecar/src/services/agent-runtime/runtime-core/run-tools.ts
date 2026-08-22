/**
 * runtime-core SDK 工具装配(#177 自 run.ts 拆出,纯移动):
 * 基础 SDK 对齐工具、Lume 运行时工具、Agent/Delegate/WaitForDelegations
 * 委托工具定义与插件/MCP 工具合并。
 */
import {
  assertTaskRefDiscriminant,
  buildSidecarSubagentExecutionInput,
  buildSidecarSubagentRunContext,
  buildSubagentTaskInstruction,
  canDelegateFromThread,
  deriveDelegateTitle,
  parseTaskRef,
  resolveForegroundSubagentTimeoutMs,
  resolveSubagentModelOverride,
  runForegroundSubagentWithTimeout,
  runSidecarSubagent,
  runTaskLinkedSubagent,
  taskExecutorStopHandlers,
} from "./run-subagent";
import type { CreateRuntimeCoreSessionInput } from "./run";
import {
  AskUserQuestionTool,
  AgentTool,
  BashTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
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
import { type EnabledPluginContextItem } from "../../agent/agent-prompt-builder";
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
import { resolveSubagentSpawnPolicy } from "../../agent/subagents/subagent-policy";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { getSubagentCoordinator } from "../../agent/subagents/subagent-coordinator";
import { resolveSubagentDispatchPolicy } from "../../agent/subagents/subagent-dispatch-policy";
import { announceSubagentCompletion } from "../../agent/subagents/subagent-announce-service";
import {
  createAgentThreadWithModelRef,
  getAgentThreadMeta,
  updateAgentThreadMeta,
} from "../../agent/agent-thread-manager";
import { getRuntimeCoreSessionDir } from "./session-store";
import { createMainTaskTools } from "../task/task-tools";
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
  permissionMode?: AgentSendInput["permissionMode"];
  subagentDefinition?: AgentDefinition;
  boundSubagentReportTool?: ToolDefinition;
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
  wikiProposalEnabled?: boolean;
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
    wikiProposalEnabled: input.wikiProposalEnabled,
    planningExecutionContext,
  });
  const askWikiOnly =
    getAgentThreadMeta(input.sessionId)?.wikiProfile?.kind === "ask-wiki";

  const policyInput = {
    provider: input.provider,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata,
  };

  const isMainTaskThread =
    input.threadType === "main" || input.threadType === undefined;
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

  const sidecarAgentTool: ToolDefinition = {
    ...AgentTool,
    description:
      "Launch an independent subagent. For a persistent Task, first claim it with TaskUpdate and then pass task_ref; Task itself never creates or schedules the subagent.",
    isConcurrencySafe: () => false,
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
      const modelOverride = resolveSubagentModelOverride({
        toolInput,
        workspaceSlug: input.workspaceSlug,
      });
      try {
        if (toolInput.task_ref !== undefined) {
          if (!mainTaskRuntime)
            throw new Error("Task-linked Agent calls are main-agent only");
          assertTaskRefDiscriminant(toolInput);
          const taskRef = parseTaskRef(toolInput.task_ref, parentThreadId);
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
        }
        const coordinator = getSubagentCoordinator();
        const taskId =
          typeof toolInput.task_id === "string"
            ? toolInput.task_id.trim()
            : undefined;
        const subagentId =
          typeof toolInput.subagent_id === "string"
            ? toolInput.subagent_id.trim()
            : undefined;
        const work = coordinator.list(parentThreadId);
        const dispatch = resolveSubagentDispatchPolicy({
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
          taskId,
          subagentId,
          newTask: toolInput.new_task === true,
          unresolvedTasks: work.tasks.filter(
            (task) =>
              task.status === "open" ||
              task.status === "running" ||
              task.status === "awaiting_review",
          ),
        });
        if (!dispatch.allowed) {
          return {
            type: "tool_result" as const,
            tool_use_id: "",
            content: dispatch.message,
            is_error: true,
          };
        }
        const result = await coordinator.runAgentTask({
          parentThreadId,
          parentRunId: input.runId ?? parentThreadId,
          parentToolUseId: context.toolUseId ?? crypto.randomUUID(),
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
          description:
            typeof toolInput.description === "string"
              ? toolInput.description
              : "Subagent",
          subagentType:
            typeof toolInput.subagent_type === "string"
              ? toolInput.subagent_type
              : undefined,
          subagentId,
          taskId,
          acceptanceCriteria: Array.isArray(toolInput.acceptance_criteria)
            ? toolInput.acceptance_criteria.filter(
                (item: unknown): item is string => typeof item === "string",
              )
            : undefined,
          expectedArtifacts: Array.isArray(toolInput.expected_artifacts)
            ? toolInput.expected_artifacts.filter(
                (item: unknown): item is string => typeof item === "string",
              )
            : undefined,
          createSession: ({ subagentId, title, agentType }) => {
            const child = createAgentThreadWithModelRef(
              title,
              modelOverride.modelRef,
              modelOverride.channelId ?? input.channelId,
              input.workspaceId,
              parentThreadId,
              modelOverride.resolvedModelId ?? context.model,
              { fileContextMode: "inherit" },
            );
            return { threadId: child.id, modelRef: modelOverride.modelRef };
          },
          execute: async ({ run, session, task, feedback, signal }) => {
            const stopChild = () => {
              void import("./attempt")
                .then((module) => module.stopAgentRuntime(session.threadId))
                .catch(() => undefined);
            };
            signal.addEventListener("abort", stopChild, { once: true });
            try {
              const execution = await runSidecarSubagent({
                toolInput: {
                  ...toolInput,
                  prompt: buildSubagentTaskInstruction(task, feedback),
                  run_in_background: undefined,
                  isolation: undefined,
                  subagent_run_id: run.runId,
                },
                context,
                runId: run.runId,
                childThreadId: session.threadId,
                parentThreadId,
                deliveryThreadId: parentThreadId,
                parentToolUseId: context.toolUseId,
                subagentType: session.agentType,
                subagentId: session.subagentId,
                subagentTaskId: task.taskId,
                subagentAttempt: run.attempt,
                modelOverride,
                channelId: input.channelId,
                workspaceId: input.workspaceId,
                chatType: input.chatType,
                messageMetadata: input.messageMetadata,
                fileReferenceBinding: input.fileReferenceBinding,
                onRuntimeEvent: (event) => {
                  coordinator.bindRuntimeRun(run.runId, event.runId);
                  input.emitRuntimeEvent?.(event);
                },
                permissionMode,
                emitAskUserQuestion: input.emitAskUserQuestion,
                emitBrowserAuthRequest: input.emitBrowserAuthRequest,
                emitToolPermissionRequest: input.emitToolPermissionRequest,
              });
              return {
                status:
                  execution.status === "aborted"
                    ? "cancelled"
                    : execution.status,
                error: execution.error,
                completionSummary: execution.completionSummary,
              };
            } finally {
              signal.removeEventListener("abort", stopChild);
            }
          },
        });
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify(result),
        };
      } catch (error) {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: `Subagent error: ${error instanceof Error ? error.message : String(error)}`,
          is_error: true,
        };
      }
    },
  };

  const finishAgentTaskTool = defineTool({
    name: "FinishAgentTask",
    description:
      "Accept, defer, or cancel a submitted Subagent task. A completed Run is not accepted until this tool is called.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        resolution: {
          type: "string",
          enum: ["accepted", "deferred", "cancelled"],
        },
        reason: { type: "string" },
      },
      required: ["task_id", "resolution", "reason"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const value =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const taskId =
        typeof value.task_id === "string" ? value.task_id.trim() : "";
      const reason =
        typeof value.reason === "string" ? value.reason.trim() : "";
      const resolution = value.resolution;
      if (
        !taskId ||
        !reason ||
        (resolution !== "accepted" &&
          resolution !== "deferred" &&
          resolution !== "cancelled")
      )
        throw new Error("FinishAgentTask 参数无效");
      const task = getSubagentCoordinator().finishTask({
        taskId,
        resolution,
        reason,
      });
      return { data: { ok: true, taskId: task.taskId, status: task.status } };
    },
  });

  const retireSubagentTool = defineTool({
    name: "RetireSubagent",
    description:
      "Retire an idle persistent Subagent Session while keeping its child-thread history available.",
    inputSchema: {
      type: "object",
      properties: {
        subagent_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["subagent_id", "reason"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const value =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const subagentId =
        typeof value.subagent_id === "string" ? value.subagent_id.trim() : "";
      const reason =
        typeof value.reason === "string" ? value.reason.trim() : "";
      if (!subagentId || !reason) throw new Error("RetireSubagent 参数无效");
      const session = getSubagentCoordinator().retireSession({
        subagentId,
        reason,
      });
      return {
        data: {
          ok: true,
          subagentId: session.subagentId,
          status: session.status,
        },
      };
    },
  });

  const mainTaskTools = mainTaskRuntime?.tools ?? [];
  const taskLoopTools =
    input.threadType === "subagent"
      ? input.boundSubagentReportTool
        ? [input.boundSubagentReportTool, todoTool]
        : [todoTool]
      : [
          ...(isMainTaskThread ? mainTaskTools : []),
          sidecarAgentTool,
          finishAgentTaskTool,
          retireSubagentTool,
          todoTool,
        ];

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
    isConcurrencySafe: () => false,
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
      const childMeta = createAgentThreadWithModelRef(
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
            updateAgentThreadMeta(childMeta.id, { title: newTitle });
          }
        },
      };
      const runInBackground = toolInput.run_in_background === true;
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
          onRuntimeEvent: input.emitRuntimeEvent,
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
          void import("./attempt")
            .then((module) => module.stopAgentRuntime(childMeta.id))
            .catch(() => undefined);
        };
        input.abortSignal?.addEventListener("abort", stopBackgroundSubagent, {
          once: true,
        });
        void executeSubagent()
          .then(async (execution) => {
            await enrichedContext.onSubagentEnd?.({
              runId: subagentRun.runId,
              status: execution.status,
              output: execution.output,
              error: execution.error,
            });
            // ★ resolve 信号量，唤醒等待方
            getSubagentRunRegistry().resolveDelegationCompletion(
              subagentRun.runId,
            );
          })
          .catch(async (err: any) => {
            getSubagentRunRegistry().update(subagentRun.runId, {
              status: "errored",
              outcome: { error: err?.message ?? String(err) },
            });
            const run = getSubagentRunRegistry().get(subagentRun.runId);
            if (run) await announceSubagentCompletion({ run });
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
        const execution = await runForegroundSubagentWithTimeout({
          execution: executeSubagent(),
          childThreadId: childMeta.id,
          timeoutMs: resolveForegroundSubagentTimeoutMs(),
          stopSubagent: async (threadId: string) => {
            const { stopAgentRuntime } = await import("./attempt");
            return stopAgentRuntime(threadId);
          },
        });
        await enrichedContext.onSubagentEnd?.({
          runId: subagentRun.runId,
          status: execution.status,
          output: execution.output,
          error: execution.error,
        });
        return execution.result;
      } catch (err: any) {
        getSubagentRunRegistry().update(subagentRun.runId, {
          status: "errored",
          outcome: { error: err?.message ?? String(err) },
        });
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
      );
    },
  };

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
    groups: askWikiOnly
      ? [{ source: "lume", tools: lumeTools.customTools as ToolDefinition[] }]
      : [
          { source: "sdk", tools: baseTools },
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

export function resolvePlanningTodoContext(
  input: Pick<
    CreateRuntimeCoreSessionInput,
    "lumeSessionId" | "messageParts" | "messageMetadata"
  >,
  executionContext: ReturnType<typeof resolvePlanningExecutionContext>,
): Array<
  Pick<
    PlanningTodo,
    | "id"
    | "title"
    | "description"
    | "status"
    | "priority"
    | "workspaceId"
    | "dueDate"
    | "dueAt"
    | "dueTimezone"
    | "revision"
  >
> {
  if (!executionContext) return [];
  const parts =
    input.messageParts ??
    (Array.isArray(input.messageMetadata?.messageParts)
      ? (input.messageMetadata.messageParts as AgentSendInput["messageParts"])
      : undefined) ??
    [];
  const ids = new Set(executionContext.authorizedTodoIds);
  if (
    executionContext.surface === "main" ||
    executionContext.surface === "quick-input"
  ) {
    for (const todo of getPlanningTodoStore().listPrimaryTodosForThread(
      input.lumeSessionId,
    )) {
      if (ids.has(todo.id))
        parts.push({
          type: "planning_todo_ref",
          schemaVersion: 1,
          uri: `lume://planning/todo/${todo.id}`,
          todoId: todo.id,
          relation: "primary",
          displayText: todo.title,
        });
    }
  }
  const snapshots = new Map<string, PlanningTodo>();
  for (const part of parts) {
    if (part?.type !== "planning_todo_ref" || !ids.has(part.todoId)) continue;
    try {
      const todo = getPlanningTodoStore().get(part.todoId);
      if (todo.status === "open" && !todo.deletedAt)
        snapshots.set(todo.id, todo);
    } catch {
      /* historical/deleted refs remain unavailable in the editor */
    }
  }
  return [...snapshots.values()].map(
    ({
      id,
      title,
      description,
      status,
      priority,
      workspaceId,
      dueDate,
      dueAt,
      dueTimezone,
      revision,
    }) => ({
      id,
      title,
      ...(description ? { description } : {}),
      status,
      priority,
      ...(workspaceId ? { workspaceId } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(dueTimezone ? { dueTimezone } : {}),
      revision,
    }),
  );
}

function sortDiscoveredTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveSdkApiType(
  provider: string,
  openaiApiMode?: OpenAiApiMode,
): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "google") {
    return "google-generative-ai";
  }
  if (normalized === "anthropic" || normalized === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (normalized === "deepseek") {
    return "deepseek-chat-completions";
  }
  if (openaiApiMode === "responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

export function resolvePromptCachePolicy(input: {
  channelProvider?: string;
  provider: string;
  model: string;
  threadId: string;
  baseUrl?: string;
}): PromptCachePolicy {
  const channelProvider = (input.channelProvider ?? input.provider)
    .trim()
    .toLowerCase();
  const routingKey = `lume:v1:${createHash("sha256")
    .update(`${channelProvider}\0${input.model}\0${input.threadId}`)
    .digest("hex")}`;
  if (
    channelProvider === "anthropic" &&
    isOfficialEndpoint(input.baseUrl, "api.anthropic.com")
  ) {
    return {
      strategy: "anthropic-ephemeral",
      ttl: "5m",
      cacheStableSystem: true,
      cacheConversation: true,
      runtimeRole: "system",
    };
  }
  if (
    channelProvider === "openai" &&
    isOfficialEndpoint(input.baseUrl, "api.openai.com")
  ) {
    return { strategy: "implicit", routingKey, runtimeRole: "developer" };
  }
  if (channelProvider === "openrouter") {
    return {
      strategy: "openrouter-sticky",
      routingKey,
      runtimeRole: "system",
      ...(input.model.toLowerCase().startsWith("anthropic/")
        ? { ttl: "5m" as const, cacheStableSystem: true }
        : {}),
    };
  }
  if (channelProvider === "deepseek") {
    return { strategy: "implicit", runtimeRole: "user" };
  }
  return { strategy: "implicit", runtimeRole: "user" };
}

function isOfficialEndpoint(
  baseUrl: string | undefined,
  officialHost: string,
): boolean {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === officialHost;
  } catch {
    return false;
  }
}

export function fingerprintToolSchema(tools: ToolDefinition[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ),
    )
    .digest("hex");
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

export function resolveSkillDirectories(
  cwd: string,
  workspaceSlug?: string,
): string[] {
  const roots = [
    getDefaultSkillsDir(),
    getUserSkillsDir(),
    getAliceUserSkillsDir(),
    join(cwd, ".alice", "skills"),
    join(cwd, ".lume", "skills"),
  ];
  if (workspaceSlug) {
    roots.push(getWorkspaceSkillsDir(workspaceSlug));
  }
  return roots;
}

function normalizeSkillList(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function createRuntimeSkillFilter(
  workspaceSlug?: string,
): AgentOptions["shouldLoadFilesystemSkill"] {
  if (!workspaceSlug) return undefined;

  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const enabled = normalizeSkillList(effectiveConfig.skills?.enabled);
  const disabled = normalizeSkillList(effectiveConfig.skills?.disabled);
  if (enabled.size === 0 && disabled.size === 0) return undefined;

  const controlledRoots = new Set([
    resolve(getDefaultSkillsDir()),
    resolve(getWorkspaceSkillsDir(workspaceSlug)),
  ]);

  return ({ root, skillName }) => {
    if (!controlledRoots.has(resolve(root))) return true;
    if (disabled.has(skillName)) return false;
    if (enabled.size > 0 && !enabled.has(skillName)) return false;
    return true;
  };
}

export function buildEnabledPluginContext(
  plugins: RegisteredPlugin[],
  assembly: PluginRuntimeAssembly,
): EnabledPluginContextItem[] {
  if (plugins.length === 0) return [];

  const skillsByPlugin = new Map<string, EnabledPluginContextItem["skills"]>();
  for (const skill of assembly.skills) {
    const pluginId = skill.name.split(":")[0];
    if (!pluginId) continue;
    const skills = skillsByPlugin.get(pluginId) ?? [];
    skills.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    });
    skillsByPlugin.set(pluginId, skills);
  }

  const commandToolsByPlugin = new Map<string, string[]>();
  for (const tool of assembly.commandToolDefinitions) {
    const runtimeMetadata = tool.runtimeMetadata as
      { pluginId?: string } | undefined;
    const pluginId = runtimeMetadata?.pluginId;
    if (!pluginId) continue;
    const tools = commandToolsByPlugin.get(pluginId) ?? [];
    tools.push(tool.name);
    commandToolsByPlugin.set(pluginId, tools);
  }

  const mcpServersByPlugin = new Map<string, string[]>();
  for (const server of assembly.mcpServers) {
    const servers = mcpServersByPlugin.get(server.pluginId) ?? [];
    servers.push(`${server.pluginId}:${server.serverId}`);
    mcpServersByPlugin.set(server.pluginId, servers);
  }

  const diagnosticsByPlugin = new Map<string, string[]>();
  for (const diagnostic of assembly.diagnostics) {
    if (!diagnostic.pluginId) continue;
    const diagnostics = diagnosticsByPlugin.get(diagnostic.pluginId) ?? [];
    diagnostics.push(diagnostic.message);
    diagnosticsByPlugin.set(diagnostic.pluginId, diagnostics);
  }

  return plugins.map((plugin) => {
    const diagnostics = [
      ...plugin.diagnostics.map((diagnostic) => diagnostic.message),
      ...(diagnosticsByPlugin.get(plugin.pluginId) ?? []),
    ];
    if (plugin.permissionState && plugin.permissionState.state !== "loaded") {
      diagnostics.push(
        `${plugin.permissionState.state}: ${plugin.permissionState.reason}`,
      );
    }
    return {
      pluginId: plugin.pluginId,
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
      ...(plugin.description ? { description: plugin.description } : {}),
      skills: skillsByPlugin.get(plugin.pluginId) ?? [],
      commandTools: commandToolsByPlugin.get(plugin.pluginId) ?? [],
      mcpServers: mcpServersByPlugin.get(plugin.pluginId) ?? [],
      diagnostics: Array.from(new Set(diagnostics)),
    };
  });
}

export function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum +
      Math.ceil(
        (tool.name.length +
          tool.description.length +
          JSON.stringify(tool.inputSchema ?? {}).length) /
          4,
      ),
    0,
  );
}

export async function executeWorkflowHookSafely(
  workflowHooks: LumeWorkflowHookRuntimeLike | undefined,
  event: LumeWorkflowHookEvent,
): Promise<LumeWorkflowHookExecutionResult | null> {
  if (!workflowHooks) return null;
  try {
    return await workflowHooks.execute(event);
  } catch {
    return null;
  }
}

export async function applyWorkflowHookEffectsSafely(
  applyWorkflowHookEffects: CreateRuntimeCoreSessionInput["applyWorkflowHookEffects"],
  result: LumeWorkflowHookExecutionResult | null,
): Promise<void> {
  if (!applyWorkflowHookEffects || !result) return;
  try {
    await applyWorkflowHookEffects(result);
  } catch {
    // Hook observe effects must not block runtime session creation.
  }
}

/**
 * WaitForDelegations 工具的纯逻辑：根据 registry 收敛结果构造返回 JSON。
 * 提取为模块级导出函数以便单测（工具闭包本身不可从外部调用）。
 */
export async function buildWaitForDelegationsResult(
  toolInput: {
    mode?: string;
    min_completed?: number;
    timeout_seconds?: number;
  },
  parentThreadId: string,
  registry: {
    waitForDelegations(input: {
      parentThreadId: string;
      mode: "all" | "any";
      minCompleted?: number;
      timeoutMs: number;
    }): Promise<{
      status: "completed" | "timeout";
      completedCount: number;
      runningCount: number;
    }>;
    listByParentSession(
      parentThreadId: string,
    ): Array<{
      runId: string;
      childThreadId: string;
      label?: string;
      status: string;
      outcome?: { output?: string; error?: string };
    }>;
  },
): Promise<{ type: "tool_result"; tool_use_id: string; content: string }> {
  const mode = toolInput.mode === "any" ? "any" : "all";
  const timeoutMs = Math.min(
    Math.max((toolInput.timeout_seconds ?? 1800) * 1000, 1000),
    2 * 3600 * 1000,
  );
  const result = await registry.waitForDelegations({
    parentThreadId,
    mode,
    minCompleted: toolInput.min_completed,
    timeoutMs,
  });
  const runs = registry.listByParentSession(parentThreadId);
  const delegations = runs.map((r) => ({
    delegationId: r.runId,
    childThreadId: r.childThreadId,
    ...(r.label ? { label: r.label } : {}),
    status: r.status,
    ...(r.outcome?.output
      ? { outputSummary: r.outcome.output.slice(0, 2000) }
      : {}),
    ...(r.outcome?.error ? { error: r.outcome.error } : {}),
  }));
  return {
    type: "tool_result" as const,
    tool_use_id: "",
    content: JSON.stringify({
      status: result.status,
      mode,
      completedCount: result.completedCount,
      runningCount: result.runningCount,
      delegations,
    }),
  };
}
