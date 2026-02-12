import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AgentEvent, AgentMessage, AgentPendingFile, AgentSessionMeta, AgentWorkspace } from "@lume/shared";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  intent?: string;
  displayName?: string;
  parentToolUseId?: string;
  taskId?: string;
  shellId?: string;
  isBackground?: boolean;
  elapsedSeconds?: number;
  result?: string;
  isError?: boolean;
  done: boolean;
}

export interface AgentStreamState {
  running: boolean;
  content: string;
  toolActivities: ToolActivity[];
  model?: string;
  inputTokens?: number;
  contextWindow?: number;
  isCompacting?: boolean;
}

export const agentSessionsAtom = atom<AgentSessionMeta[]>([]);
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([]);
export const agentChannelIdAtom = atomWithStorage<string | null>("lume-agent-channel-id", null);
export const agentModelIdAtom = atomWithStorage<string | null>("lume-agent-model-id", null);
export const agentPendingPromptAtom = atom<{ sessionId: string; message: string } | null>(null);
export const agentPendingFilesAtom = atom<AgentPendingFile[]>([]);
export const workspaceCapabilitiesVersionAtom = atom<number>(0);
export const currentAgentWorkspaceIdAtom = atom<string | null>(null);
export const currentAgentSessionIdAtom = atom<string | null>(null);
export const currentAgentMessagesAtom = atom<AgentMessage[]>([]);
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map());
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map());

export const currentAgentStreamStateAtom = atom<AgentStreamState | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentStreamingStatesAtom).get(currentId) ?? null;
});

export const agentStreamingAtom = atom<boolean>((get) => !!get(currentAgentStreamStateAtom)?.running);

export const agentStreamingContentAtom = atom<string>((get) => get(currentAgentStreamStateAtom)?.content ?? "");

export const agentToolActivitiesAtom = atom<ToolActivity[]>((get) => get(currentAgentStreamStateAtom)?.toolActivities ?? []);

export const agentContextStatusAtom = atom<{
  inputTokens?: number;
  contextWindow?: number;
  isCompacting: boolean;
}>((get) => {
  const state = get(currentAgentStreamStateAtom);
  return {
    inputTokens: state?.inputTokens,
    contextWindow: state?.contextWindow,
    isCompacting: !!state?.isCompacting
  };
});

export const currentAgentSessionAtom = atom<AgentSessionMeta | null>((get) => {
  const sessions = get(agentSessionsAtom);
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return sessions.find((item) => item.id === currentId) ?? null;
});

export const agentRunningSessionIdsAtom = atom<Set<string>>((get) => {
  const states = get(agentStreamingStatesAtom);
  const ids = new Set<string>();
  for (const [id, state] of states) {
    if (state.running) ids.add(id);
  }
  return ids;
});

export const currentAgentErrorAtom = atom<string | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentStreamErrorsAtom).get(currentId) ?? null;
});

export function applyAgentEvent(prev: AgentStreamState, event: AgentEvent): AgentStreamState {
  switch (event.type) {
    case "text_delta":
      return { ...prev, content: prev.content + event.text };
    case "tool_start":
      {
        const exists = prev.toolActivities.find((item) => item.toolUseId === event.toolUseId);
        if (exists) {
          return {
            ...prev,
            toolActivities: prev.toolActivities.map((item) =>
              item.toolUseId === event.toolUseId
                ? {
                    ...item,
                    input: event.input,
                    intent: event.intent ?? item.intent,
                    displayName: event.displayName ?? item.displayName,
                    parentToolUseId: event.parentToolUseId ?? item.parentToolUseId
                  }
                : item
            )
          };
        }
      }
      return {
        ...prev,
        toolActivities: [
          ...prev.toolActivities,
          {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
            intent: event.intent,
            displayName: event.displayName,
            parentToolUseId: event.parentToolUseId,
            done: false
          }
        ]
      };
    case "tool_result":
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, done: true, isError: event.isError, result: event.result }
            : item
        )
      };
    case "task_backgrounded":
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, taskId: event.taskId }
            : item
        )
      };
    case "task_progress":
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, elapsedSeconds: event.elapsedSeconds }
            : item
        )
      };
    case "usage_update":
      return {
        ...prev,
        inputTokens: event.usage.inputTokens,
        contextWindow: event.usage.contextWindow ?? prev.contextWindow
      };
    case "compacting":
      return {
        ...prev,
        isCompacting: true
      };
    case "compact_complete":
      return {
        ...prev,
        isCompacting: false
      };
    case "shell_backgrounded":
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, shellId: event.shellId }
            : item
        )
      };
    case "complete":
    case "error":
      return { ...prev, running: false, isCompacting: false };
    default:
      return prev;
  }
}
