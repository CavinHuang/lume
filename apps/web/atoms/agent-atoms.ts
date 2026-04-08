import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type {
  AgentAskUserQuestionRequest,
  AgentMessage,
  AgentPendingFile,
  AgentRuntimeStatus,
  AgentThreadMeta,
  AgentToolPermissionRequest,
  AgentWorkspace,
  AgentSendInput,
  ThinkingLevel
} from "@lume/shared";
import {
  isAgentRuntimePhaseActive,
  resolveAgentBusyState
} from "@/lib/agent-runtime-status";
import type {
  AgentStreamState,
  ToolActivity
} from "@/lib/agent-streaming";
import { formatToolStatusLine } from "@/lib/agent-status-line";

export type { AgentStreamState, ToolActivity } from "@/lib/agent-streaming";

export const agentThreadsAtom = atom<AgentThreadMeta[]>([]);
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([]);
export const agentChannelIdAtom = atomWithStorage<string | null>("lume-agent-channel-id", null);
export const agentModelIdAtom = atomWithStorage<string | null>("lume-agent-model-id", null);
export const agentPermissionModeAtom = atomWithStorage<NonNullable<AgentSendInput["permissionMode"]>>(
  "lume-agent-permission-mode",
  "bypassPermissions"
);
export const agentThinkingLevelAtom = atomWithStorage<ThinkingLevel>("lume-agent-thinking-level", "medium");
export const agentPendingPromptAtom = atom<{ threadId: string; message: string } | null>(null);
export const agentPendingFilesAtom = atom<AgentPendingFile[]>([]);
export const workspaceCapabilitiesVersionAtom = atom<number>(0);
export const workspaceFilesVersionAtom = atom<number>(0);

/** thread 级附加目录：threadId -> string[] */
export const agentAttachedDirectoriesMapAtom = atom<Map<string, string[]>>(new Map());
/** 工作区级附加目录：workspaceSlug -> string[] */
export const workspaceAttachedDirectoriesMapAtom = atom<Map<string, string[]>>(new Map());

export const currentAgentWorkspaceIdAtom = atom<string | null>(null);
export const currentAgentThreadIdAtom = atom<string | null>(null);
export const currentAgentThreadMessagesAtom = atom<AgentMessage[]>([]);
export const agentMessageVersionsByGroupAtom = atom<Record<string, AgentMessage[]>>({});
export const agentSelectedVersionIndexByGroupAtom = atom<Record<string, number>>({});
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map());
export const agentRuntimeStatusesAtom = atom<Map<string, AgentRuntimeStatus>>(new Map());
export const agentAskUserQuestionRequestsAtom = atom<Map<string, AgentAskUserQuestionRequest>>(new Map());
export const agentToolPermissionRequestsAtom = atom<Map<string, AgentToolPermissionRequest>>(new Map());
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map());

/** 持久化每个 thread 最后一次上下文用量，确保非流式状态下也能显示 */
export const agentThreadContextCacheAtom = atom<Map<string, {
  inputTokens?: number;
  totalTokens: number;
  contextWindow?: number;
}>>(new Map());


export const currentAgentStreamStateAtom = atom<AgentStreamState | null>((get) => {
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return get(agentStreamingStatesAtom).get(currentId) ?? null;
});

export const currentAgentRuntimeStatusAtom = atom<AgentRuntimeStatus | null>((get) => {
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return get(agentRuntimeStatusesAtom).get(currentId) ?? null;
});

export const currentAgentAskUserQuestionRequestAtom = atom<AgentAskUserQuestionRequest | null>((get) => {
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return get(agentAskUserQuestionRequestsAtom).get(currentId) ?? null;
});

export const currentAgentToolPermissionRequestAtom = atom<AgentToolPermissionRequest | null>((get) => {
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return get(agentToolPermissionRequestsAtom).get(currentId) ?? null;
});

export const agentStreamingAtom = atom<boolean>((get) => {
  const status = get(currentAgentRuntimeStatusAtom);
  const localRunning = !!get(currentAgentStreamStateAtom)?.running;
  return resolveAgentBusyState(status, localRunning);
});

export const agentStreamingContentAtom = atom<string>((get) => get(currentAgentStreamStateAtom)?.content ?? "");
export const agentStreamingReasoningAtom = atom<string>((get) => get(currentAgentStreamStateAtom)?.reasoning ?? "");

export const agentToolActivitiesAtom = atom<ToolActivity[]>((get) => get(currentAgentStreamStateAtom)?.toolActivities ?? []);


/** 当前流式回合的 turnId */
export const agentCurrentTurnIdAtom = atom<string | undefined>((get) => get(currentAgentStreamStateAtom)?.currentTurnId);
/** 已完成的 turn 数量 */
export const agentTurnCountAtom = atom<number>((get) => get(currentAgentStreamStateAtom)?.turnCount ?? 0);

export const agentContextStatusAtom = atom<{
  totalTokens?: number;
  inputTokens?: number;
  contextWindow?: number;
  isCompacting: boolean;
}>((get) => {
  const state = get(currentAgentStreamStateAtom);
  const currentId = get(currentAgentThreadIdAtom);
  const cache = currentId ? get(agentThreadContextCacheAtom).get(currentId) : undefined;
  return {
    totalTokens: state?.totalTokens ?? cache?.totalTokens,
    inputTokens: state?.inputTokens ?? cache?.inputTokens,
    contextWindow: state?.contextWindow ?? cache?.contextWindow,
    isCompacting: !!state?.isCompacting
  };
});

export const agentIsCompactingAtom = atom<boolean>((get) => {
  const status = get(currentAgentRuntimeStatusAtom);
  if (status) {
    return status.phase === "compacting";
  }
  return get(agentContextStatusAtom).isCompacting;
});

export const agentThinkingSecondsAtom = atom<number | null>((get) => {
  const state = get(currentAgentStreamStateAtom);
  if (!state?.streamStartedAt || !state.firstOutputAt) return null;
  const seconds = (state.firstOutputAt - state.streamStartedAt) / 1000;
  return seconds >= 1 ? seconds : null;
});

export const currentAgentThreadAtom = atom<AgentThreadMeta | null>((get) => {
  const threads = get(agentThreadsAtom);
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return threads.find((item) => item.id === currentId) ?? null;
});

interface ToolPolicyRecord {
  allow?: unknown[];
  deny?: unknown[];
}

function isToolPolicyRecord(value: unknown): value is ToolPolicyRecord {
  return typeof value === "object" && value !== null;
}

function getStringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}

export const currentAgentCapabilityRouteHintAtom = atom<{
  preferred: string;
  reason?: string;
  softPolicyActive?: boolean;
} | null>((get) => {
  const messages = get(currentAgentThreadMessagesAtom);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const metadata = message.metadata;
    const preferred = getStringField(metadata, "preferredCapabilityRoute");
    if (!preferred) continue;
    const reason = getStringField(metadata, "capabilityRoutingReason");
    const toolPolicy = metadata?.toolPolicy;
    let softPolicyActive = false;
    if (isToolPolicyRecord(toolPolicy)) {
      const allow = Array.isArray(toolPolicy.allow) ? toolPolicy.allow : [];
      const deny = Array.isArray(toolPolicy.deny) ? toolPolicy.deny : [];
      softPolicyActive = allow.length > 0 || deny.length > 0;
    }
    return { preferred, reason, softPolicyActive };
  }
  return null;
});

export const agentRunningThreadIdsAtom = atom<Set<string>>((get) => {
  const ids = new Set<string>();
  const runtimeStatuses = get(agentRuntimeStatusesAtom);
  for (const [id, status] of runtimeStatuses) {
    if (isAgentRuntimePhaseActive(status.phase)) {
      ids.add(id);
    }
  }
  if (runtimeStatuses.size > 0) {
    return ids;
  }
  const states = get(agentStreamingStatesAtom);
  for (const [id, state] of states) {
    if (state.running) {
      ids.add(id);
    }
  }
  return ids;
});

export const currentAgentErrorAtom = atom<string | null>((get) => {
  const currentId = get(currentAgentThreadIdAtom);
  if (!currentId) return null;
  return get(agentStreamErrorsAtom).get(currentId) ?? null;
});

/**
 * 派生 atom：根据当前 Agent 流式状态自动生成一行状态描述文字。
 *
 * 优先级逻辑：
 * - 压缩中 → 最高优先
 * - 有内容正在输出 → "正在生成回复..."（内容已出现后，不再显示工具/思考状态）
 * - 有工具正在执行 → 显示工具描述（仅在内容尚未输出时）
 * - 子 Agent 运行中 → 显示子 Agent 描述
 * - 正在推理 → "正在思考..."
 * - 默认 → "正在处理..."
 */
export const agentStatusLineAtom = atom<string | null>((get) => {
  const streaming = get(agentStreamingAtom);
  if (!streaming) return null;

  // 1. 上下文压缩中（始终最高优先级）
  const isCompacting = get(agentIsCompactingAtom);
  if (isCompacting) return "正在压缩上下文...";

  // 2. 有内容正在输出 → 不再需要状态行提示
  const content = get(agentStreamingContentAtom);
  if (content) return null;

  // 3. 有正在执行的工具 → 取最后一个未完成的工具生成描述
  const toolActivities = get(agentToolActivitiesAtom);
  let runningTool: ToolActivity | undefined;
  for (let i = toolActivities.length - 1; i >= 0; i--) {
    if (!toolActivities[i]!.done) { runningTool = toolActivities[i]; break; }
  }
  if (runningTool) {
    const desc =
      runningTool.progressDescription ||
      formatToolStatusLine(runningTool.toolName, runningTool.intent);
    return desc.endsWith("...") ? desc : `${desc}...`;
  }

  // 4. 正在推理
  const reasoning = get(agentStreamingReasoningAtom);
  if (reasoning) return "正在思考...";
  const thinkingSeconds = get(agentThinkingSecondsAtom);
  if (thinkingSeconds !== null) return "正在思考...";

  // 5. 默认
  return "正在处理...";
});
