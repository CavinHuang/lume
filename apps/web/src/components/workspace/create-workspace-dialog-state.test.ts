import { describe, expect, mock, test } from 'bun:test'
import type { AgentWorkspace } from '@lume/shared'
import { createWorkspaceFromDraft } from './create-workspace-dialog-state'

const workspace: AgentWorkspace = {
  id: 'workspace-1',
  name: '产品工作区',
  slug: 'workspace-1',
  createdAt: 1,
  updatedAt: 1,
}

describe('createWorkspaceFromDraft', () => {
  test('does not call the backend for an empty project path', async () => {
    const createWorkspace = mock(async () => workspace)

    const result = await createWorkspaceFromDraft('   ', createWorkspace)

    expect(result).toBeNull()
    expect(createWorkspace).not.toHaveBeenCalled()
  })

  test('trims the project path before creating a workspace', async () => {
    const createWorkspace = mock(async ({ projectPath }: { projectPath: string }) => ({
      ...workspace,
      id: 'workspace-2',
      slug: 'workspace-2',
      name: projectPath,
    }))

    const result = await createWorkspaceFromDraft('  新工作区  ', createWorkspace)

    expect(createWorkspace).toHaveBeenCalledWith({ projectPath: '新工作区' })
    expect(result).toEqual({
      ...workspace,
      id: 'workspace-2',
      slug: 'workspace-2',
      name: '新工作区',
    })
  })
})
