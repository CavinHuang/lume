import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type {
  AgentEvent,
  AgentAskUserQuestionRequest,
  AgentMessage,
  AgentPendingFile,
  AgentRuntimeStatus,
  AgentSessionMeta,
  AgentToolPermissionRequest,
  AgentWorkspace,
  AgentSendInput
} from "@lume/shared";
import {
  isAgentRuntimePhaseActive,
  resolveAgentBusyState
} from "@/lib/agent-runtime-status";
import type {
  AgentStreamState,
  TeammateState,
  ToolActivity
} from "@/lib/agent-streaming";
import {
  applyAgentEvent
} from "@/lib/agent-streaming";
import type {
  TimelineEvent
} from "@/lib/agent-timeline";
import {
  extractTimelineEvents
} from "@/lib/agent-timeline";
import { formatToolStatusLine } from "@/lib/agent-status-line";

export type { AgentStreamState, TeammateState, ToolActivity } from "@/lib/agent-streaming";
export type { TimelineEvent, TimelineTextEvent, TimelineToolResultEvent, TimelineToolStartEvent } from "@/lib/agent-timeline";
export { applyAgentEvent, extractTimelineEvents };

export const agentSessionsAtom = atom<AgentSessionMeta[]>([]);
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([]);
export const agentChannelIdAtom = atomWithStorage<string | null>("lume-agent-channel-id", null);
export const agentModelIdAtom = atomWithStorage<string | null>("lume-agent-model-id", null);
export const agentPermissionModeAtom = atomWithStorage<NonNullable<AgentSendInput["permissionMode"]>>(
  "lume-agent-permission-mode",
  "bypassPermissions"
);
export const agentPendingPromptAtom = atom<{ sessionId: string; message: string } | null>(null);
export const agentPendingFilesAtom = atom<AgentPendingFile[]>([]);
export const workspaceCapabilitiesVersionAtom = atom<number>(0);
export const workspaceFilesVersionAtom = atom<number>(0);
export const currentAgentWorkspaceIdAtom = atom<string | null>(null);
export const currentAgentSessionIdAtom = atom<string | null>(null);
export const currentAgentMessagesAtom = atom<AgentMessage[]>([]);
export const agentMessageVersionsByGroupAtom = atom<Record<string, AgentMessage[]>>({});
export const agentSelectedVersionIndexByGroupAtom = atom<Record<string, number>>({});
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map());
export const agentRuntimeStatusesAtom = atom<Map<string, AgentRuntimeStatus>>(new Map());
export const agentAskUserQuestionRequestsAtom = atom<Map<string, AgentAskUserQuestionRequest>>(new Map());
export const agentToolPermissionRequestsAtom = atom<Map<string, AgentToolPermissionRequest>>(new Map());
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map());

/** 持久化每个 session 最后一次上下文用量，确保非流式状态下也能显示 */
export const agentSessionContextCacheAtom = atom<Map<string, {
  inputTokens?: number;
  totalTokens: number;
  contextWindow?: number;
}>>(new Map());

export const cachedTeammateStatesAtom = atom<Map<string, TeammateState[]>>(new Map());

export const currentAgentStreamStateAtom = atom<AgentStreamState | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentStreamingStatesAtom).get(currentId) ?? null;
});

export const currentAgentRuntimeStatusAtom = atom<AgentRuntimeStatus | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentRuntimeStatusesAtom).get(currentId) ?? null;
});

export const currentAgentAskUserQuestionRequestAtom = atom<AgentAskUserQuestionRequest | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentAskUserQuestionRequestsAtom).get(currentId) ?? null;
});

export const currentAgentToolPermissionRequestAtom = atom<AgentToolPermissionRequest | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
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

export const teammateStatesAtom = atom<TeammateState[]>((get) => get(currentAgentStreamStateAtom)?.teammates ?? []);

export const hasTeammatesAtom = atom<boolean>((get) => get(teammateStatesAtom).length > 0);

export const runningTeammateCountAtom = atom<number>((get) => get(teammateStatesAtom).filter(t => t.status === 'running').length);

export const agentStreamingTimelineEventsAtom = atom<TimelineEvent[]>((get) => {
  const streamState = get(currentAgentStreamStateAtom);
  if (!streamState) return [];
  const events = streamState.events ?? [];
  if (events.length === 0) return [];
  const syntheticMessage: AgentMessage = {
    id: "streaming",
    role: "assistant",
    content: streamState.content,
    createdAt: Date.now(),
    events
  };
  return extractTimelineEvents(syntheticMessage);
});

export const agentContextStatusAtom = atom<{
  totalTokens?: number;
  inputTokens?: number;
  contextWindow?: number;
  isCompacting: boolean;
}>((get) => {
  const state = get(currentAgentStreamStateAtom);
  const currentId = get(currentAgentSessionIdAtom);
  const cache = currentId ? get(agentSessionContextCacheAtom).get(currentId) : undefined;
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

export const currentAgentSessionAtom = atom<AgentSessionMeta | null>((get) => {
  const sessions = get(agentSessionsAtom);
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return sessions.find((item) => item.id === currentId) ?? null;
});

export const agentRunningSessionIdsAtom = atom<Set<string>>((get) => {
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
  const currentId = get(currentAgentSessionIdAtom);
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

  // 4. 子 Agent 正在运行
  const teammates = get(teammateStatesAtom);
  const runningTeammate = teammates.find((t) => t.status === "running");
  if (runningTeammate) {
    const desc = runningTeammate.description;
    return desc.endsWith("...") ? desc : `${desc}...`;
  }

  // 5. 正在推理
  const reasoning = get(agentStreamingReasoningAtom);
  if (reasoning) return "正在思考...";
  const thinkingSeconds = get(agentThinkingSecondsAtom);
  if (thinkingSeconds !== null) return "正在思考...";

  // 6. 默认
  return "正在处理...";
});
