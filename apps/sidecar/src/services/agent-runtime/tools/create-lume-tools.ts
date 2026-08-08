import type { SDKMessage, ToolDefinition } from "@lume/agent-sdk";
import type { AgentAskUserQuestionRequest, AgentBrowserAuthRequest, AgentDesktopActionRequest, AgentToolPermissionRequest, DesktopActionVisualRuntimeEvent } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { MemoryToolPolicy } from "../../memory-v2/policy";
import { createSdkMemoryTools } from "./memory/create-memory-tools";
import { createSdkCronTools } from "./cron/create-cron-tools";
import { createAutomationListTools } from "./cron/automation-list-tools";
import { createAutomationTemplateTools } from "./cron/automation-template-tools";
import { createSdkImTools } from "./im/create-im-tools";
import { createSdkImCliTools } from "./im-cli/create-im-cli-tools";
import { dingtalkCliConfig } from "./im-cli/providers/dingtalk";
import { larkCliConfig } from "./im-cli/providers/feishu";
import { wecomCliConfig } from "./im-cli/providers/wecom";
import { getImCliBaseDir } from "../../infra/config-paths";
import { resolveEnabledMemoryToolNames } from "./tool-policy-matcher";
import { createSdkReadingTools } from "./reading/create-reading-tools";
import { createPersonalizeUiTool } from "./ui/create-personalize-ui-tool";
import { createSdkOfficeTools } from "./office/create-office-tools";
import { createRoutineTools } from "./routine/create-routine-tools";
import { createImageGenTools } from "./image-gen/create-image-gen-tools";
import { createNodeReplMcpTools } from "./node-repl/create-node-repl-tools";
import { createComputerUseMcpTools } from "./computer-use/create-computer-use-tools";
import { createComputerUseVisionRouter } from "./computer-use/computer-use-vision-router";
import { getComputerUseSessionRegistry } from "./computer-use/computer-use-session";
import type { ResolvedComputerUseSurface } from "./computer-use/computer-use-surface";
import { createComputerUseRequestBridge } from "./node-repl/node-repl-computer-use-bridge";
import { getAgentThreadMeta } from "../../agent/agent-thread-manager";
import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { hasCodingIntent } from "../../agent/capability-routing";
import { createWikiProposalTool, createWikiReadTools } from "./wiki/create-wiki-tools";
import { resolveTrustedWikiRuntimeProfile } from "../../wiki/runtime-profile";
import type { TrustedWikiRuntimeProfile } from "../../wiki/runtime-profile";
import { createPlanningTodoTools } from "./planning/create-planning-todo-tools";
import { createSuggestionTools } from "./suggest/create-suggestion-tools";
import type { ExecutionSurfaceContext } from "../../planning/planning-execution-context";
import { createLinkTools } from "./link/create-link-tools";

const BASE_RUNTIME_TOOL_NAMES = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ls"];
const AUTOMATION_TOOL_NAMES = [
  "automation_read",
  "automation_set",
  "automation_query"
];

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
  messageMetadata?: Record<string, unknown>;
  originalUserInstruction?: string;
  computerUseSurface?: ResolvedComputerUseSurface;
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  automationExecution?: boolean;
  wikiProposalEnabled?: boolean;
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
  availableToolNames: string[];
}

export function createOrdinaryWikiTools(input: {
  profile?: TrustedWikiRuntimeProfile;
  proposalEnabled?: boolean;
  creatorThreadId?: string;
}): ToolDefinition[] {
  if (!input.profile || input.profile.explicit) return [];
  return [
    ...createWikiReadTools(input.profile.scope),
    createWikiProposalTool(input.profile.scope, {
      creatorThreadId: input.creatorThreadId,
      creatorProfile: "ordinary-agent",
      securityGateAvailable: input.proposalEnabled === true,
    }),
  ];
}

export function createWikiToolsForTrustedProfile(input: {
  profile?: TrustedWikiRuntimeProfile;
  proposalEnabled?: boolean;
  creatorThreadId?: string;
}): ToolDefinition[] {
  if (!input.profile) return [];
  if (!input.profile.explicit) return createOrdinaryWikiTools(input);
  return [
    ...createWikiReadTools(input.profile.scope),
    createWikiProposalTool(input.profile.scope, {
      creatorThreadId: input.creatorThreadId,
      creatorProfile: "ask-wiki",
      securityGateAvailable: input.proposalEnabled === true,
    }),
  ];
}

export function createLumeRuntimeTools(input: CreateLumeRuntimeToolsInput): CreateLumeRuntimeToolsOutput {
  const threadMeta = getAgentThreadMeta(input.threadId);
  const wikiProfile = resolveTrustedWikiRuntimeProfile({
    threadMeta,
    workspaceId: input.workspaceId,
    workspaceExists: Boolean(input.workspaceId && getAgentWorkspace(input.workspaceId)),
    threadType: input.threadType,
    chatType: input.chatType
  });
  if (wikiProfile?.explicit) {
    const customTools = createWikiToolsForTrustedProfile({
      profile: wikiProfile,
      proposalEnabled: input.wikiProposalEnabled,
      creatorThreadId: input.threadId,
    });
    return { customTools, availableToolNames: customTools.map((tool) => tool.name) };
  }
  const enabledMemoryToolNames = resolveEnabledMemoryToolNames(input.memoryToolPolicy);
  const enabledMemoryTools = new Set(enabledMemoryToolNames);
  const memoryTools = input.workspaceSlug
    ? createSdkMemoryTools({
      workspaceSlug: input.workspaceSlug,
      enabledTools: enabledMemoryTools,
      includeCitations: input.includeCitations
    })
    : [];
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
    threadId: input.threadId
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
  const officeTools = createSdkOfficeTools();
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
  const nodeReplTools = shouldExposeNodeReplTools(input)
    ? computerUseSurface === "sky"
      ? allNodeReplTools.filter((tool) => tool.name === "mcp__node_repl__js")
      : allNodeReplTools
    : [];
  const ordinaryWikiTools = createOrdinaryWikiTools({
    profile: wikiProfile,
    proposalEnabled: input.wikiProposalEnabled,
    creatorThreadId: input.threadId,
  });
  // Planning Todo is a trusted capability. A runtime without a sidecar-issued
  // surface context must not even receive the tool definitions.
  const planningTodoTools = input.planningExecutionContext && input.planningExecutionContext.surface !== "subagent"
    ? createPlanningTodoTools({ workspaceId: input.workspaceId, executionContext: input.planningExecutionContext })
    : [];
  const computerUseTools = computerUseSurface === "mcp" && shouldExposeComputerUseTools(input)
    ? allComputerUseTools
    : [];
  const linkTools = createLinkTools({
    threadId: input.threadId,
    runId: input.runId,
    emitToolPermissionRequest: input.emitToolPermissionRequest,
  });
  const customTools = [
    ...memoryTools,
    ...cronTools,
    ...automationListTools,
    ...automationTemplateTools,
    ...imTools,
    ...imCliTools,
    ...readingTools,
    ...uiTools,
    ...officeTools,
    ...routineTools,
    ...suggestionTools,
    ...imageGenTools,
    ...nodeReplTools,
    ...ordinaryWikiTools,
    ...planningTodoTools,
    ...computerUseTools,
  ];
  // Coding/raw-tools runs keep the SDK repository tools plus the explicitly
  // governed Link surface; unrelated product integrations stay hidden.
  const directToolRoute = isDirectRepositoryToolRoute(input);
  const visibleCustomTools = directToolRoute ? linkTools : [...customTools, ...linkTools];
  const customToolNames = visibleCustomTools.map((tool) => tool.name);

  return {
    customTools: visibleCustomTools,
    availableToolNames: [
      ...BASE_RUNTIME_TOOL_NAMES,
      ...(directToolRoute ? [] : AUTOMATION_TOOL_NAMES),
      ...customToolNames
    ]
  };
}

function isDirectRepositoryToolRoute(input: CreateLumeRuntimeToolsInput): boolean {
  const preferredRoute = typeof input.messageMetadata?.preferredCapabilityRoute === "string"
    ? input.messageMetadata.preferredCapabilityRoute
    : undefined;
  return preferredRoute === "coding"
    || preferredRoute === "raw-tools"
    || hasCodingIntent(input.originalUserInstruction);
}

function shouldExposeNodeReplTools(input: CreateLumeRuntimeToolsInput): boolean {
  const preferredRoute = typeof input.messageMetadata?.preferredCapabilityRoute === "string"
    ? input.messageMetadata.preferredCapabilityRoute
    : undefined;
  if (preferredRoute === "coding" || preferredRoute === "raw-tools" || hasCodingIntent(input.originalUserInstruction)) return false;
  if (input.computerUseSurface === "sky") return true;

  const instruction = [
    input.originalUserInstruction,
    typeof input.messageMetadata?.preferredCapabilityRoute === "string"
      ? input.messageMetadata.preferredCapabilityRoute
      : undefined,
  ].filter(Boolean).join(" ").toLowerCase();

  return [
    "node_repl",
    "node repl",
    "playwright",
    "puppeteer",
    "browser automation",
    "chrome automation",
    "网页自动化",
    "浏览器自动化",
    "用 js 操作网页",
    "用 javascript 操作网页",
  ].some((marker) => instruction.includes(marker));
}

function shouldExposeComputerUseTools(input: CreateLumeRuntimeToolsInput): boolean {
  const preferredRoute = typeof input.messageMetadata?.preferredCapabilityRoute === "string"
    ? input.messageMetadata.preferredCapabilityRoute
    : undefined;
  if (preferredRoute === "coding" || preferredRoute === "raw-tools" || hasCodingIntent(input.originalUserInstruction)) return false;
  if (preferredRoute === "browser") return true;

  const instruction = (input.originalUserInstruction ?? "").trim().toLowerCase();
  return [
    "computer use",
    "computer_use",
    "desktop automation",
    "桌面自动化",
    "操作当前页面",
    "操作浏览器",
    "控制浏览器",
    "控制窗口",
    "切换窗口",
    "启动应用",
    "点击当前页面",
    "截图当前页面",
  ].some((marker) => instruction.includes(marker));
}
