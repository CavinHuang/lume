import type { AgentWorkspace } from '@lume/shared'

export async function createWorkspaceFromDraft(
  projectPath: string | null | undefined,
  createWorkspace: (input: { projectPath: string }) => Promise<AgentWorkspace>,
): Promise<AgentWorkspace | null> {
  const trimmedPath = projectPath?.trim()
  if (!trimmedPath) return null
  return createWorkspace({ projectPath: trimmedPath })
}
