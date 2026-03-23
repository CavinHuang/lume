export interface AgentWorkspaceLike {
  id: string;
  slug: string;
}

export function resolveAgentSessionWorkspace(
  workspaces: AgentWorkspaceLike[],
  selectedWorkspaceId: string | null | undefined,
  sessionWorkspaceId: string | null | undefined
): AgentWorkspaceLike | null {
  const preferredWorkspaceId = sessionWorkspaceId ?? selectedWorkspaceId ?? null;
  if (preferredWorkspaceId) {
    const hit = workspaces.find((item) => item.id === preferredWorkspaceId);
    if (hit) return hit;
  }

  if (selectedWorkspaceId && selectedWorkspaceId !== preferredWorkspaceId) {
    const hit = workspaces.find((item) => item.id === selectedWorkspaceId);
    if (hit) return hit;
  }

  return null;
}
