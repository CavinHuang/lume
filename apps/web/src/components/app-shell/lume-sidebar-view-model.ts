import type { AgentRuntimePhase, AgentThreadMeta, AgentWorkspace } from '@lume/shared'

export type LumeSidebarTopActionId = 'new-chat' | 'search' | 'skills' | 'automations'
export type LumeSidebarFooterActionId = 'recycle-bin' | 'settings'

export interface BuildLumeSidebarViewModelInput {
  workspaces: AgentWorkspace[]
  threads: AgentThreadMeta[]
  currentWorkspaceId: string | null
  activeTabId: string | null
  streamingStates: Record<string, AgentRuntimePhase | undefined>
  expandedWorkspaceIds: string[]
}

export interface LumeSidebarAction<TId extends string> {
  id: TId
  label: string
  icon: string
  kind: 'button' | 'search'
  shortcut?: string
  badge?: string
  disabled?: boolean
}

export type LumeSidebarTopAction = LumeSidebarAction<LumeSidebarTopActionId>
export type LumeSidebarFooterAction = LumeSidebarAction<LumeSidebarFooterActionId>

export interface LumeSidebarThreadItem {
  id: string
  title: string
  active: boolean
  pinned: boolean
  isStreaming: boolean
  updatedAt: number
}

export interface LumeSidebarSyntheticThreadRow {
  type: 'synthetic-thread'
  id: '__welcome__'
  label: '新对话'
  active: boolean
}

export interface LumeSidebarThreadGroup {
  type: 'thread-group'
  id: string
  label: string
  items: LumeSidebarThreadItem[]
}

export type LumeSidebarWorkspaceRow = LumeSidebarSyntheticThreadRow | LumeSidebarThreadGroup

export interface LumeSidebarWorkspaceItem {
  id: string
  name: string
  count: number
  isCurrent: boolean
  isExpanded: boolean
  rows: LumeSidebarWorkspaceRow[]
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

interface ThreadGroup {
  label: string
  items: AgentThreadMeta[]
}

const welcomeRow: LumeSidebarSyntheticThreadRow = {
  type: 'synthetic-thread',
  id: '__welcome__',
  label: '新对话',
  active: false,
}

export function buildLumeSidebarViewModel({
  workspaces,
  threads,
  currentWorkspaceId,
  activeTabId,
  streamingStates,
  expandedWorkspaceIds,
}: BuildLumeSidebarViewModelInput): LumeSidebarViewModel {
  const selectedWorkspaceId = currentWorkspaceId ?? workspaces[0]?.id ?? null
  const expandedSet = new Set(expandedWorkspaceIds)

  const topActions: LumeSidebarTopAction[] = [
    { id: 'new-chat', label: '新建聊天', icon: 'square-pen', kind: 'button', shortcut: 'Ctrl N' },
    { id: 'search', label: '搜索', icon: 'search', kind: 'search', shortcut: 'Ctrl K' },
    { id: 'skills', label: '技能', icon: 'box', kind: 'button' },
    { id: 'automations', label: '自动化', icon: 'clock', kind: 'button', badge: '即将推出', disabled: true },
  ]

  const footerActions: LumeSidebarFooterAction[] = [
    { id: 'recycle-bin', label: '回收站', icon: 'trash', kind: 'button' },
    { id: 'settings', label: '设置', icon: 'settings', kind: 'button' },
  ]

  const workspaceItems = workspaces.map((workspace) => {
    const workspaceThreads = sortThreadsByUpdatedAt(
      threads.filter((thread) => getThreadWorkspaceId(thread, selectedWorkspaceId) === workspace.id),
    )
    const threadGroups = groupThreadsByDate(workspaceThreads).map<LumeSidebarThreadGroup>((group) => ({
      type: 'thread-group',
      id: `${workspace.id}:${group.label}`,
      label: group.label,
      items: group.items.map((thread) => ({
        id: thread.id,
        title: thread.title,
        active: activeTabId === thread.id,
        pinned: !!thread.pinned,
        isStreaming: streamingStates[thread.id] === 'streaming',
        updatedAt: thread.updatedAt,
      })),
    }))

    const rows: LumeSidebarWorkspaceRow[] =
      workspace.id === selectedWorkspaceId
        ? [{ ...welcomeRow, active: activeTabId === '__welcome__' }, ...threadGroups]
        : threadGroups

    return {
      id: workspace.id,
      name: workspace.name,
      count: workspaceThreads.length,
      isCurrent: workspace.id === selectedWorkspaceId,
      isExpanded: expandedSet.has(workspace.id),
      rows,
    }
  })

  const collapsedItems: LumeSidebarCollapsedItem[] = [
    ...topActions.map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.icon,
      kind: 'top-action' as const,
      disabled: action.disabled,
      active: action.id === 'new-chat' ? activeTabId === '__welcome__' : false,
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

function getThreadWorkspaceId(thread: AgentThreadMeta, currentWorkspaceId: string | null): string | null {
  return thread.workspaceId ?? currentWorkspaceId
}

function sortThreadsByUpdatedAt(threads: AgentThreadMeta[]): AgentThreadMeta[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt)
}

function groupThreadsByDate(threads: AgentThreadMeta[]): ThreadGroup[] {
  const pinned = threads.filter((thread) => thread.pinned)
  const unpinned = threads.filter((thread) => !thread.pinned)
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const startOfYesterday = startOfToday - 86_400_000
  const today: AgentThreadMeta[] = []
  const yesterday: AgentThreadMeta[] = []
  const earlier: AgentThreadMeta[] = []

  for (const thread of unpinned) {
    if (thread.updatedAt >= startOfToday) {
      today.push(thread)
      continue
    }

    if (thread.updatedAt >= startOfYesterday) {
      yesterday.push(thread)
      continue
    }

    earlier.push(thread)
  }

  return [
    ...(pinned.length > 0 ? [{ label: '置顶', items: pinned }] : []),
    ...(today.length > 0 ? [{ label: '今天', items: today }] : []),
    ...(yesterday.length > 0 ? [{ label: '昨天', items: yesterday }] : []),
    ...(earlier.length > 0 ? [{ label: '更早', items: earlier }] : []),
  ]
}
