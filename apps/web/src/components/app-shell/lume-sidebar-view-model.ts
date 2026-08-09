import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'

export type LumeSidebarTopActionId = 'new-chat' | 'lume' | 'skills' | 'connectors' | 'automations' | 'todos' | 'proactive'
export type LumeSidebarFooterActionId = 'recycle-bin' | 'settings'
export const UNASSIGNED_THREADS_WORKSPACE_ID = '__unassigned__'
const UNASSIGNED_THREADS_WORKSPACE_NAME = '普通会话'

export interface BuildLumeSidebarViewModelInput {
  workspaces: AgentWorkspace[]
  threads: AgentThreadMeta[]
  currentWorkspaceId: string | null
  activeTabId: string | null
  expandedWorkspaceIds: string[]
  pinnedWorkspaceIds: string[]
  planningTodoCount?: number
}

export interface LumeSidebarAction<TId extends string> {
  id: TId
  label: string
  icon: string
  kind: 'button'
  shortcut?: string
  badge?: string
  disabled?: boolean
  active?: boolean
}

export type LumeSidebarTopAction = LumeSidebarAction<LumeSidebarTopActionId>
export type LumeSidebarFooterAction = LumeSidebarAction<LumeSidebarFooterActionId>

export interface LumeSidebarThreadItem {
  id: string
  title: string
  active: boolean
  pinned: boolean
  updatedAt: number
  parentThreadId?: string
  depth: number
  isDelegate: boolean
  children?: LumeSidebarThreadItem[]
  workspaceName?: string
}

export interface LumeSidebarWorkspaceItem {
  id: string
  name: string
  count: number
  isCurrent: boolean
  isExpanded: boolean
  pinned: boolean
  threads: LumeSidebarThreadItem[]
}

export interface LumeSidebarCollapsedItem {
  id: string
  label: string
  icon: string
  kind: 'top-action' | 'workspace' | 'footer-action'
  active?: boolean
  disabled?: boolean
  count?: number
  workspaceId?: string
}

export interface LumeSidebarViewModel {
  topActions: LumeSidebarTopAction[]
  workspaces: LumeSidebarWorkspaceItem[]
  footerActions: LumeSidebarFooterAction[]
  collapsedItems: LumeSidebarCollapsedItem[]
}

export function buildLumeSidebarViewModel({
  workspaces,
  threads,
  currentWorkspaceId,
  activeTabId,
  expandedWorkspaceIds,
  pinnedWorkspaceIds,
  planningTodoCount = 0,
}: BuildLumeSidebarViewModelInput): LumeSidebarViewModel {
  const selectedWorkspaceId = currentWorkspaceId
  const expandedSet = new Set(expandedWorkspaceIds)
  const pinnedSet = new Set(pinnedWorkspaceIds)

  const topActions: LumeSidebarTopAction[] = [
    { id: 'new-chat', label: '新建聊天', icon: 'square-pen', kind: 'button', shortcut: 'Ctrl N' },
    { id: 'lume', label: 'Lume', icon: 'bot', kind: 'button', active: activeTabId === '__lume__' },
    { id: 'skills', label: '技能 / 插件', icon: 'box', kind: 'button', active: activeTabId === '__skills__' },
    { id: 'connectors', label: '连接器', icon: 'plug', kind: 'button', active: activeTabId === '__link__' },
    {
      id: 'automations',
      label: '自动化',
      icon: 'clock',
      kind: 'button',
      badge: '即将推出',
      disabled: false,
      active: activeTabId === '__automation__',
    },
    { id: 'todos', label: '待办', icon: 'list-todo', kind: 'button', active: activeTabId === '__todos__', ...(planningTodoCount > 0 ? { badge: String(planningTodoCount) } : {}) },
    { id: 'proactive', label: '主动', icon: 'sparkles', kind: 'button', active: activeTabId === '__proactive__' },
  ]

  const footerActions: LumeSidebarFooterAction[] = [
    { id: 'recycle-bin', label: '回收站', icon: 'trash', kind: 'button' },
    { id: 'settings', label: '设置', icon: 'settings', kind: 'button' },
  ]

  const workspaceItems: LumeSidebarWorkspaceItem[] = workspaces.map((workspace) => {
    const workspaceThreads = sortThreadsByUpdatedAt(
      threads.filter((thread) => getThreadWorkspaceId(thread) === workspace.id),
    )
    const allThreads = buildThreadTree(workspaceThreads, activeTabId, workspace.name)

    return {
      id: workspace.id,
      name: workspace.name,
      count: workspaceThreads.length,
      isCurrent: workspace.id === selectedWorkspaceId,
      isExpanded: expandedSet.has(workspace.id),
      pinned: pinnedSet.has(workspace.id),
      threads: allThreads,
    }
  })
  const unassignedThreads = sortThreadsByUpdatedAt(
    threads.filter((thread) => getThreadWorkspaceId(thread) === null),
  )

  if (unassignedThreads.length > 0) {
    workspaceItems.push({
      id: UNASSIGNED_THREADS_WORKSPACE_ID,
      name: UNASSIGNED_THREADS_WORKSPACE_NAME,
      count: unassignedThreads.length,
      isCurrent: currentWorkspaceId === null,
      isExpanded: expandedSet.has(UNASSIGNED_THREADS_WORKSPACE_ID),
      pinned: false,
      threads: buildThreadTree(unassignedThreads, activeTabId, UNASSIGNED_THREADS_WORKSPACE_NAME),
    })
  }

  workspaceItems.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))

  const collapsedItems: LumeSidebarCollapsedItem[] = [
    ...topActions.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      kind: 'top-action' as const,
      disabled: action.disabled,
      active: action.id === 'new-chat' ? activeTabId === '__welcome__' : !!action.active,
    })),
    ...workspaceItems.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      label: workspace.name,
      icon: 'folder',
      kind: 'workspace' as const,
      workspaceId: workspace.id,
      count: workspace.count,
      active: workspace.isCurrent,
    })),
    ...footerActions.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      kind: 'footer-action' as const,
      disabled: action.disabled,
      active: action.id === 'settings' ? activeTabId === '__settings__' : false,
    })),
  ]

  return {
    topActions,
    workspaces: workspaceItems,
    footerActions,
    collapsedItems,
  }
}

function getThreadWorkspaceId(thread: AgentThreadMeta): string | null {
  return thread.workspaceId ?? null
}

function sortThreadsByUpdatedAt(threads: AgentThreadMeta[]): AgentThreadMeta[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt)
}

function buildThreadItemFromMeta(
  thread: AgentThreadMeta,
  activeTabId: string | null,
  depth: number,
  workspaceName: string,
): LumeSidebarThreadItem {
  return {
    id: thread.id,
    title: thread.title,
    active: activeTabId === thread.id,
    pinned: !!thread.pinned,
    updatedAt: thread.updatedAt,
    parentThreadId: thread.parentThreadId,
    depth,
    isDelegate: depth > 0,
    workspaceName,
  }
}

function buildThreadTree(
  threads: AgentThreadMeta[],
  activeTabId: string | null,
  workspaceName: string,
): LumeSidebarThreadItem[] {
  const ids = new Set(threads.map((thread) => thread.id))
  const childrenByParent = new Map<string, AgentThreadMeta[]>()
  const roots: AgentThreadMeta[] = []
  for (const thread of threads) {
    if (thread.parentThreadId && ids.has(thread.parentThreadId)) {
      const siblings = childrenByParent.get(thread.parentThreadId) ?? []
      siblings.push(thread)
      childrenByParent.set(thread.parentThreadId, siblings)
    } else {
      roots.push(thread)
    }
  }
  const build = (thread: AgentThreadMeta, depth: number): LumeSidebarThreadItem => {
    const kids = (childrenByParent.get(thread.id) ?? []).map((child) => build(child, depth + 1))
    return {
      ...buildThreadItemFromMeta(thread, activeTabId, depth, workspaceName),
      ...(kids.length ? { children: kids } : {}),
    }
  }
  return roots.map((thread) => build(thread, 0))
}
