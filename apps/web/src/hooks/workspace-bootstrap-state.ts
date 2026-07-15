import type { AgentWorkspace } from '@lume/shared'

interface BootstrapWorkspacesOptions {
  listWorkspaces: () => Promise<AgentWorkspace[]>
  getCurrentWorkspaceId: () => string | null
  setWorkspaces: (workspaces: AgentWorkspace[]) => void
  setCurrentWorkspaceId: (workspaceId: string | null) => void
  isCancelled?: () => boolean
}

export async function bootstrapWorkspaces({
  listWorkspaces,
  getCurrentWorkspaceId,
  setWorkspaces,
  setCurrentWorkspaceId,
  isCancelled,
}: BootstrapWorkspacesOptions): Promise<void> {
  const workspaces = await listWorkspaces()

  if (isCancelled?.()) return
  setWorkspaces(workspaces)

  const currentWorkspaceId = getCurrentWorkspaceId()
  if (currentWorkspaceId && !workspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    setCurrentWorkspaceId(null)
  }
}
