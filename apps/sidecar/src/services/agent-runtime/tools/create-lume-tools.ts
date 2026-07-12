import type { SDKMessage, ToolDefinition } from "@lume/agent-sdk";
import type { AgentAskUserQuestionRequest, AgentBrowserAuthRequest, AgentDesktopActionRequest, AgentToolPermissionRequest, DesktopActionVisualRuntimeEvent } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { MemoryToolPolicy } from "../../memory-v2/policy";
import { createSdkMemoryTools } from "./memory/create-memory-tools";
import { createSdkCronTools } from "./cron/create-cron-tools";
import { createAutomationListTools } from "./cron/automation-list-tools";
import { createAutomationTemplateTools } from "./cron/automation-template-tools";
import { createSdkImTools } from "./im/create-im-tools";
import { resolveEnabledMemoryToolNames } from "./tool-policy-matcher";
import { createSdkReadingTools } from "./reading/create-reading-tools";
import { createPersonalizeUiTool } from "./ui/create-personalize-ui-tool";
import { createSdkOfficeTools } from "./office/create-office-tools";
import { createRoutineTools } from "./routine/create-routine-tools";
import { createImageGenTools } from "./image-gen/create-image-gen-tools";
import { createNodeReplMcpTools } from "./node-repl/create-node-repl-tools";
import { createComputerUseMcpTools } from "./computer-use/create-computer-use-tools";

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
  workspaceId?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  workspaceSlug?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  automationExecution?: boolean;
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

export function desktopWindowBindingFromMessageMetadata(
  messageMetadata: Record<string, unknown> | undefined,
): { windowId: string; appId?: string; appName?: string; windowTitle?: string } | undefined {
  const window = recordValue(messageMetadata?.desktopWindow);
  const app = recordValue(messageMetadata?.desktopApp);
  const windowId = stringValue(window.id);
  if (!windowId) return undefined;
  const appId = stringValue(app.id);
  const appName = stringValue(app.name);
  const windowTitle = stringValue(window.title);
  return {
    windowId,
    ...(appId ? { appId } : {}),
    ...(appName ? { appName } : {}),
    ...(windowTitle ? { windowTitle } : {}),
  };
}

export function createLumeRuntimeTools(input: CreateLumeRuntimeToolsInput): CreateLumeRuntimeToolsOutput {
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
  const readingTools = createSdkReadingTools();
  const uiTools = [createPersonalizeUiTool({ threadId: input.threadId })];
  const officeTools = createSdkOfficeTools();
  const routineTools = createRoutineTools({
    workspaceId: input.workspaceId,
  });
  const imageGenTools = createImageGenTools({
    threadId: input.threadId,
    workspaceSlug: input.workspaceSlug,
  });
  const nodeReplTools = createNodeReplMcpTools({
    sessionId: input.threadId,
    cwd: input.cwd ?? process.cwd(),
    workspaceSlug: input.workspaceSlug,
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
  });
  const boundDesktopWindow = desktopWindowBindingFromMessageMetadata(input.messageMetadata);
  const computerUseTools = createComputerUseMcpTools({
    threadId: input.threadId,
    runId: input.runId,
    ...(typeof input.messageMetadata?.desktopContextSnapshotId === "string"
      ? { boundDesktopContextSnapshotId: input.messageMetadata.desktopContextSnapshotId }
      : {}),
    ...(boundDesktopWindow ? { boundDesktopWindow } : {}),
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitDesktopActionVisualEvent: input.emitDesktopActionVisualEvent,
  });
  const customTools = [
    ...memoryTools,
    ...cronTools,
    ...automationListTools,
    ...automationTemplateTools,
    ...imTools,
    ...readingTools,
    ...uiTools,
    ...officeTools,
    ...routineTools,
    ...imageGenTools,
    ...nodeReplTools,
    ...computerUseTools,
  ];
  const customToolNames = customTools.map((tool) => tool.name);

  return {
    customTools,
    availableToolNames: [
      ...BASE_RUNTIME_TOOL_NAMES,
      ...AUTOMATION_TOOL_NAMES,
      ...customToolNames
    ]
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
