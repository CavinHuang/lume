import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@lume/shared'
import { bootstrapWorkspaces } from './workspace-bootstrap-state'

const workspaceA: AgentWorkspace = {
  id: 'workspace-a',
  name: 'Workspace A',
  slug: 'workspace-a',
  createdAt: 1,
  updatedAt: 1,
}

const workspaceB: AgentWorkspace = {
  id: 'workspace-b',
  name: 'Workspace B',
  slug: 'workspace-b',
  createdAt: 2,
  updatedAt: 2,
}

describe('bootstrapWorkspaces', () => {
  test('keeps a valid hydrated workspace selection that appears before async loading completes', async () => {
    let currentWorkspaceId: string | null = null
    const selectedIds: Array<string | null> = []
    const workspaceSets: AgentWorkspace[][] = []

    await bootstrapWorkspaces({
      listWorkspaces: async () => {
        currentWorkspaceId = workspaceB.id
        return [workspaceA, workspaceB]
      },
      createWorkspace: async () => {
        throw new Error('should not create workspace')
      },
      getCurrentWorkspaceId: () => currentWorkspaceId,
      setWorkspaces: (workspaces) => {
        workspaceSets.push(workspaces)
      },
      setCurrentWorkspaceId: (workspaceId) => {
        selectedIds.push(workspaceId)
        currentWorkspaceId = workspaceId
      },
    })

    expect(workspaceSets).toEqual([[workspaceA, workspaceB]])
    expect(selectedIds).toEqual([])
    expect(currentWorkspaceId).toBe(workspaceB.id)
  })

  test('falls back to the first workspace when the current selection is invalid', async () => {
    const selectedIds: Array<string | null> = []

    await bootstrapWorkspaces({
      listWorkspaces: async () => [workspaceA, workspaceB],
      createWorkspace: async () => {
        throw new Error('should not create workspace')
      },
      getCurrentWorkspaceId: () => 'missing-workspace',
      setWorkspaces: () => {},
      setCurrentWorkspaceId: (workspaceId) => {
        selectedIds.push(workspaceId)
      },
    })

    expect(selectedIds).toEqual([workspaceA.id])
  })
})
