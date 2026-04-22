import type { AgentWorkspace } from '@lume/shared'

export async function createWorkspaceFromDraft(
  draftName: string,
  createWorkspace: (input: { name: string }) => Promise<AgentWorkspace>,
): Promise<AgentWorkspace | null> {
  const name = draftName.trim()
  if (!name) return null
  return createWorkspace({ name })
}
