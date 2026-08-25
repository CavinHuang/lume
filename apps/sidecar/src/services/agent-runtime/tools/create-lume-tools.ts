import type { SDKMessage, ToolDefinition } from "@lume/agent-sdk";
import { getRuntimeHostPorts } from "../host-ports";
import type { AgentAskUserQuestionRequest, AgentBrowserAuthRequest, AgentDesktopActionRequest, AgentToolPermissionRequest, DesktopActionVisualRuntimeEvent } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { MemoryToolPolicy } from "../../memory-v2/policy";
import { createSdkMemoryTools } from "./memory/create-memory-tools";
import { createDreamEvidenceTools } from "./memory/create-dream-evidence-tools";
import { createSdkCronTools } from "./cron/create-cron-tools";
import { createAutomationListTools } from "./cron/automation-list-tools";
import { createAutomationTemplateTools } from "./cron/automation-template-tools";
import { createSdkImTools } from "./im/create-im-tools";
import { createSdkImCliTools } from "./im-cli/create-im-cli-tools";
import { createSdkConnectorTools } from "./connectors/create-connector-tools";
import { dingtalkCliConfig } from "./im-cli/providers/dingtalk";
import { larkCliConfig } from "./im-cli/providers/feishu";
import { wecomCliConfig } from "./im-cli/providers/wecom";
import { getImCliBaseDir } from "../../infra/config-paths";
import { resolveEnabledMemoryToolNames } from "./tool-policy-matcher";
import { createSdkReadingTools } from "./reading/create-reading-tools";
import { createPersonalizeUiTool } from "./ui/create-personalize-ui-tool";
import { createRoutineTools } from "./routine/create-routine-tools";
import { createImageGenTools } from "./image-gen/create-image-gen-tools";
import { createNodeReplMcpTools } from "./node-repl/create-node-repl-tools";
import { createComputerUseMcpTools } from "./computer-use/create-computer-use-tools";
import { createComputerUseVisionRouter } from "./computer-use/computer-use-vision-router";
import { getComputerUseSessionRegistry } from "./computer-use/computer-use-session";
import type { ResolvedComputerUseSurface } from "./computer-use/computer-use-surface";
import { createComputerUseRequestBridge } from "./node-repl/node-repl-computer-use-bridge";
import { createPlanningTodoTools } from "./planning/create-planning-todo-tools";
import { createSuggestionTools } from "./suggest/create-suggestion-tools";
import type { ExecutionSurfaceContext } from "../../planning/planning-execution-context";
import { createBrowserMcpTools } from "./browser/create-browser-tools";

export interface CreateLumeRuntimeToolsInput {
  threadId: string;
  runId?: string;
  cwd?: string;
  filesRoot?: string;
  workspaceId?: string;
  channelId?: string;
  modelRef?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  workspaceSlug?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  originalUserInstruction?: string;
  computerUseSurface?: ResolvedComputerUseSurface;
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  automationExecution?: boolean;
  planningExecutionContext?: ExecutionSurfaceContext;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitDesktopActionVisualEvent?: (event: DesktopActionVisualRuntimeEvent) => void;
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
}

export interface CreateLumeRuntimeToolsOutput {
  customTools: ToolDefinition[];
}

export function createLumeRuntimeTools(input: CreateLumeRuntimeToolsInput): CreateLumeRuntimeToolsOutput {
  const threadMeta = getRuntimeHostPorts().getThreadMeta(input.threadId);
  const writeAllowed = input.threadType !== "subagent" && input.chatType !== "group" && input.chatType !== "channel";
  const dreamProfile = threadMeta?.memoryProfile?.kind === "dream" ? threadMeta.memoryProfile : undefined;
  const enabledMemoryToolNames = [
    ...resolveEnabledMemoryToolNames(input.memoryToolPolicy),
    ...(dreamProfile ? ["memory.search" as const, "memory.read" as const] : [])
  ]
    .filter((name) => writeAllowed || (name !== "memory.remember" && name !== "memory.forget"));
  const enabledMemoryTools = new Set(enabledMemoryToolNames);
  const memoryTools = input.workspaceSlug
    ? createSdkMemoryTools({
      workspaceSlug: input.workspaceSlug,
      enabledTools: enabledMemoryTools,
      includeCitations: input.includeCitations,
      threadId: input.threadId,
      runId: input.runId
    })
    : [];
  const dreamEvidenceTools = input.workspaceSlug && dreamProfile
    ? createDreamEvidenceTools({ workspaceSlug: input.workspaceSlug, jobId: dreamProfile.jobId })
    : [];
  if (dreamProfile) {
    return { customTools: [...memoryTools, ...dreamEvidenceTools] };
  }
  const cronTools = createSdkCronTools({
    workspaceId: input.workspaceId,
    sessionId: input.threadId
  });
  const automationListTools = createAutomationListTools({
    workspaceId: input.workspaceId,
  });
  const automationTemplateTools = createAutomationTemplateTools({
    workspaceId: input.workspaceId,
  });
  const imTools = createSdkImTools({
    threadId: input.threadId,
    ...(input.filesRoot ? { filesRoot: input.filesRoot } : {})
  });
  const imCliBaseDir = getImCliBaseDir();
  const imCliDeps = { userDataRoot: imCliBaseDir, platform: process.platform, arch: process.arch };
  const imCliTools = [
    ...createSdkImCliTools({ config: dingtalkCliConfig, ...imCliDeps }),
    ...createSdkImCliTools({ config: larkCliConfig, ...imCliDeps }),
    ...createSdkImCliTools({ config: wecomCliConfig, ...imCliDeps }),
  ];
  const readingTools = createSdkReadingTools();
  const uiTools = [createPersonalizeUiTool({ threadId: input.threadId })];
  const routineTools = createRoutineTools({
    workspaceId: input.workspaceId,
  });
  const suggestionTools = createSuggestionTools();
  const imageGenTools = createImageGenTools({
    threadId: input.threadId,
    workspaceSlug: input.workspaceSlug,
    filesRoot: input.filesRoot,
  });
  const cwd = input.cwd ?? process.cwd();
  const computerUseSurface = input.computerUseSurface ?? "mcp";
  const computerUseVisionRouter = createComputerUseVisionRouter({
    currentModelRef: input.modelRef,
    workspaceSlug: input.workspaceSlug,
  });
  const allComputerUseTools = createComputerUseMcpTools({
    workspaceSlug: input.workspaceSlug,
    threadId: input.threadId,
    filesRoot: input.filesRoot,
    runId: input.runId,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitDesktopActionVisualEvent: input.emitDesktopActionVisualEvent,
    routeScreenshot: (path) => computerUseVisionRouter.route(path),
    originalUserInstruction: input.originalUserInstruction,
    sessionRegistry: getComputerUseSessionRegistry(),
  });
  const allNodeReplTools = createNodeReplMcpTools({
    sessionId: input.threadId,
    cwd,
    workspaceSlug: input.workspaceSlug,
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitComputerUseRequest: computerUseSurface === "sky"
      ? createComputerUseRequestBridge({
        tools: allComputerUseTools,
        threadId: input.threadId,
        cwd,
      })
      : undefined,
  });
  const nodeReplTools = computerUseSurface === "sky"
    ? allNodeReplTools.filter((tool) => tool.name === "mcp__node_repl__js")
    : allNodeReplTools;
  // Planning Todo is a trusted capability. A runtime without a sidecar-issued
  // surface context must not even receive the tool definitions.
  const planningTodoTools = input.planningExecutionContext && input.planningExecutionContext.surface !== "subagent"
    ? createPlanningTodoTools({ workspaceId: input.workspaceId, executionContext: input.planningExecutionContext })
    : [];
  const computerUseTools = computerUseSurface === "mcp"
    ? allComputerUseTools
    : [];
  const browserTools = input.threadType === "subagent"
    ? []
    : createBrowserMcpTools({ threadId: input.threadId });
  const customTools = [
    ...memoryTools,
    ...dreamEvidenceTools,
    ...cronTools,
    ...automationListTools,
    ...automationTemplateTools,
    ...imTools,
    ...imCliTools,
    ...createSdkConnectorTools(),
    ...readingTools,
    ...uiTools,
    ...routineTools,
    ...suggestionTools,
    ...imageGenTools,
    ...nodeReplTools,
    ...browserTools,
    ...planningTodoTools,
    ...computerUseTools,
  ];

  // 注入池归属由 ToolRuntime.build 重算；此处只产出自定义工具本身
  return { customTools };
}
