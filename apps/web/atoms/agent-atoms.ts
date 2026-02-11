import { atom } from "jotai";
import type { AgentEvent, AgentMessage, AgentSessionMeta, AgentWorkspace } from "@lume/shared";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  intent?: string;
  displayName?: string;
  parentToolUseId?: string;
  result?: string;
  isError?: boolean;
  done: boolean;
}

export interface AgentStreamState {
  running: boolean;
  content: string;
  toolActivities: ToolActivity[];
  model?: string;
}

export const agentSessionsAtom = atom<AgentSessionMeta[]>([]);
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([]);
export const currentAgentWorkspaceIdAtom = atom<string | null>(null);
export const currentAgentSessionIdAtom = atom<string | null>(null);
export const currentAgentMessagesAtom = atom<AgentMessage[]>([]);
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map());
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map());

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
    case "complete":
    case "error":
      return { ...prev, running: false };
    default:
      return prev;
  }
}
