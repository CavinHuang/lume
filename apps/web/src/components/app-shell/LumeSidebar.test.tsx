import { describe, expect, mock, test } from 'bun:test'
import { act, Children, isValidElement, type ReactNode, type ReactElement } from 'react'
import type { AgentWorkspace } from '@lume/shared'
import { LumeSidebar } from './LumeSidebar'
import { buildLumeSidebarViewModel } from './lume-sidebar-view-model'

function createWorkspace(overrides: Partial<AgentWorkspace> = {}): AgentWorkspace {
  return {
    id: 'workspace-1',
    name: '品牌工作区',
    slug: 'brand-workspace',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function collectText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (!isValidElement(node)) {
    return Children.toArray(node).map(collectText).join('')
  }

  return collectText(node.props.children)
}

function findButtonByLabel(node: ReactNode, label: string): ReactElement<{ disabled?: boolean; onClick?: () => void }> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) {
      continue
    }

    if (child.type === 'button' && collectText(child).includes(label)) {
      return child as ReactElement<{ disabled?: boolean; onClick?: () => void }>
    }

    const match = findButtonByLabel(child.props.children, label)
    if (match) {
      return match
    }
  }

  return null
}

describe('LumeSidebar', () => {
  test('disables recycle bin while still dispatching live footer actions', () => {
    const onFooterAction = mock()
    const model = buildLumeSidebarViewModel({
      workspaces: [createWorkspace()],
      threads: [],
      currentWorkspaceId: 'workspace-1',
      activeTabId: null,
      expandedWorkspaceIds: ['workspace-1'],
    })

    const tree = LumeSidebar({
      collapsed: false,
      allExpanded: true,
      model,
      onSetCollapsed: () => {},
      onTopAction: () => {},
      onFooterAction,
      onSelectWorkspace: () => {},
      onToggleWorkspace: () => {},
      onToggleAllWorkspaces: () => {},
      onCreateWorkspace: () => {},
      onOpenThread: () => {},
      onToggleThreadPin: () => {},
      onDeleteThread: () => {},
      onRenameThread: () => {},
    })
    const recycleBinButton = findButtonByLabel(tree, '回收站')
    const settingsButton = findButtonByLabel(tree, '设置')

    expect(recycleBinButton).not.toBeNull()
    expect(settingsButton).not.toBeNull()
    expect(recycleBinButton?.props.disabled).toBe(true)

    act(() => {
      settingsButton?.props.onClick?.()
    })

    expect(onFooterAction).toHaveBeenCalledWith('settings')
    expect(onFooterAction).toHaveBeenCalledTimes(1)
  })
})
