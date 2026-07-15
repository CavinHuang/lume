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

  test('keeps ordinary-session selection when projects exist', async () => {
    const selectedIds: Array<string | null> = []

    await bootstrapWorkspaces({
      listWorkspaces: async () => [workspaceA, workspaceB],
      getCurrentWorkspaceId: () => null,
      setWorkspaces: () => {},
      setCurrentWorkspaceId: (workspaceId) => {
        selectedIds.push(workspaceId)
      },
    })

    expect(selectedIds).toEqual([])
  })

  test('falls back to ordinary session when the persisted project no longer exists', async () => {
    const selectedIds: Array<string | null> = []

    await bootstrapWorkspaces({
      listWorkspaces: async () => [workspaceA, workspaceB],
      getCurrentWorkspaceId: () => 'missing-workspace',
      setWorkspaces: () => {},
      setCurrentWorkspaceId: (workspaceId) => selectedIds.push(workspaceId),
    })

    expect(selectedIds).toEqual([null])
  })
})
