import type { AgentSessionMeta } from "@lume/shared";
import { groupConversationsByDate } from "./left-sidebar-conversations";

export function buildChildSessionMap(
  sessions: AgentSessionMeta[],
  currentWorkspaceId: string | null
): Map<string, AgentSessionMeta[]> {
  const map = new Map<string, AgentSessionMeta[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    if (currentWorkspaceId && session.workspaceId !== currentWorkspaceId) continue;
    const items = map.get(session.parentSessionId) ?? [];
    items.push(session);
    map.set(session.parentSessionId, items);
  }
  for (const items of map.values()) {
    items.sort((a, b) => a.createdAt - b.createdAt);
  }
  return map;
}

export function filterRootAgentSessions(
  sessions: AgentSessionMeta[],
  currentWorkspaceId: string | null
): AgentSessionMeta[] {
  return [...sessions]
    .filter((item) => !item.parentSessionId && (!currentWorkspaceId || item.workspaceId === currentWorkspaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function derivePinnedAgentSessions(sessions: AgentSessionMeta[]): AgentSessionMeta[] {
  return sessions.filter((item) => item.pinned);
}

export function deriveAgentGroups(sessions: AgentSessionMeta[]) {
  return groupConversationsByDate(sessions);
}
