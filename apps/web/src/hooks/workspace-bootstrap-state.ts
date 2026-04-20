import type { AgentWorkspace } from '@lume/shared'

interface BootstrapWorkspacesOptions {
  listWorkspaces: () => Promise<AgentWorkspace[]>
  createWorkspace: (input: { name: string }) => Promise<AgentWorkspace>
  getCurrentWorkspaceId: () => string | null
  setWorkspaces: (workspaces: AgentWorkspace[]) => void
  setCurrentWorkspaceId: (workspaceId: string | null) => void
  isCancelled?: () => boolean
}

export async function bootstrapWorkspaces({
  listWorkspaces,
  createWorkspace,
  getCurrentWorkspaceId,
  setWorkspaces,
  setCurrentWorkspaceId,
  isCancelled,
}: BootstrapWorkspacesOptions): Promise<void> {
  let workspaces = await listWorkspaces()

  if (workspaces.length === 0) {
    workspaces = [await createWorkspace({ name: '默认' })]
  }

  if (isCancelled?.()) return
  setWorkspaces(workspaces)

  const currentWorkspaceId = getCurrentWorkspaceId()
  const hasValidSelection = !!currentWorkspaceId && workspaces.some((workspace) => workspace.id === currentWorkspaceId)

  if (!hasValidSelection && workspaces[0]) {
    setCurrentWorkspaceId(workspaces[0].id)
  }
}
