export function areAllWorkspacesExpanded(workspaceIds: string[], expandedWorkspaceIds: string[]): boolean {
  if (workspaceIds.length === 0) return false
  const expandedSet = new Set(expandedWorkspaceIds)
  return workspaceIds.every((workspaceId) => expandedSet.has(workspaceId))
}

export function toggleAllWorkspaces(workspaceIds: string[], expandedWorkspaceIds: string[]): string[] {
  return areAllWorkspacesExpanded(workspaceIds, expandedWorkspaceIds) ? [] : [...workspaceIds]
}

export function toggleWorkspaceExpansion(expandedWorkspaceIds: string[], workspaceId: string): string[] {
  const expandedSet = new Set(expandedWorkspaceIds)
  if (expandedSet.has(workspaceId)) {
    expandedSet.delete(workspaceId)
  } else {
    expandedSet.add(workspaceId)
  }
  return [...expandedSet]
}

export function reconcileExpandedWorkspaces(
  workspaceIds: string[],
  expandedWorkspaceIds: string[],
  fallbackWorkspaceId: string | null,
): string[] {
  const availableIds = new Set(workspaceIds)
  const filtered = expandedWorkspaceIds.filter((workspaceId) => availableIds.has(workspaceId))

  if (filtered.length > 0) {
    return filtered
  }

  if (fallbackWorkspaceId && availableIds.has(fallbackWorkspaceId)) {
    return [fallbackWorkspaceId]
  }

  return workspaceIds[0] ? [workspaceIds[0]] : []
}
