import { describe, expect, test } from 'bun:test'
import {
  areAllWorkspacesExpanded,
  reconcileExpandedWorkspaces,
  toggleAllWorkspaces,
  toggleWorkspaceExpansion,
} from './left-sidebar-state'

describe('left sidebar workspace expansion state', () => {
  test('toggleAllWorkspaces expands every workspace when not all are open', () => {
    expect(toggleAllWorkspaces(['a', 'b', 'c'], ['a'])).toEqual(['a', 'b', 'c'])
  })

  test('toggleAllWorkspaces collapses every workspace when all are open', () => {
    expect(toggleAllWorkspaces(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([])
  })

  test('toggleWorkspaceExpansion removes an open workspace without touching the rest', () => {
    expect(toggleWorkspaceExpansion(['a', 'b'], 'b')).toEqual(['a'])
  })

  test('reconcileExpandedWorkspaces falls back to the current workspace when nothing remains expanded', () => {
    expect(reconcileExpandedWorkspaces(['a', 'b'], [], 'b')).toEqual(['b'])
  })

  test('areAllWorkspacesExpanded only returns true when every workspace is open', () => {
    expect(areAllWorkspacesExpanded(['a', 'b'], ['a'])).toBe(false)
    expect(areAllWorkspacesExpanded(['a', 'b'], ['a', 'b'])).toBe(true)
  })
})
