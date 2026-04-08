import type { AgentThreadMeta } from "@lume/shared";
import { groupConversationsByDate } from "./left-sidebar-conversations";

export function buildChildThreadMap(
  sessions: AgentThreadMeta[],
  currentWorkspaceId: string | null
): Map<string, AgentThreadMeta[]> {
  const map = new Map<string, AgentThreadMeta[]>();
  for (const session of sessions) {
    if (!session.parentThreadId) continue;
    if (currentWorkspaceId && session.workspaceId !== currentWorkspaceId) continue;
    const items = map.get(session.parentThreadId) ?? [];
    items.push(session);
    map.set(session.parentThreadId, items);
  }
  for (const items of map.values()) {
    items.sort((a, b) => a.createdAt - b.createdAt);
  }
  return map;
}

export function filterRootAgentThreads(
  sessions: AgentThreadMeta[],
  currentWorkspaceId: string | null
): AgentThreadMeta[] {
  return [...sessions]
    .filter((item) => !item.parentThreadId && (!currentWorkspaceId || item.workspaceId === currentWorkspaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function derivePinnedAgentThreads(sessions: AgentThreadMeta[]): AgentThreadMeta[] {
  return sessions.filter((item) => item.pinned);
}

export function deriveAgentGroups(sessions: AgentThreadMeta[]) {
  return groupConversationsByDate(sessions);
}
