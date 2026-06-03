import type { AgentRuntimePhase, AgentThreadMeta, AgentWorkspace } from '@lume/shared'

export type LumeSidebarTopActionId = 'new-chat' | 'search' | 'reading' | 'skills' | 'automations'
export type LumeSidebarFooterActionId = 'recycle-bin' | 'settings'
export const UNASSIGNED_THREADS_WORKSPACE_ID = '__unassigned__'
const UNASSIGNED_THREADS_WORKSPACE_NAME = '未分配'
const IM_PROVIDER_LABELS: Record<string, string> = {
  weixin: '微信',
  feishu: '飞书',
  telegram: 'Telegram',
  email: '邮件',
}
const IM_PROVIDER_ORDER = ['weixin', 'feishu', 'telegram', 'email']

export interface BuildLumeSidebarViewModelInput {
  workspaces: AgentWorkspace[]
  threads: AgentThreadMeta[]
  currentWorkspaceId: string | null
  activeTabId: string | null
  streamingStates: Record<string, AgentRuntimePhase | undefined>
  expandedWorkspaceIds: string[]
  pinnedWorkspaceIds: string[]
}

export interface LumeSidebarAction<TId extends string> {
  id: TId
  label: string
  icon: string
  kind: 'button' | 'search'
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
  isStreaming: boolean
  updatedAt: number
}

export interface LumeSidebarSyntheticThreadRow {
  type: 'synthetic-thread'
  id: '__welcome__'
  workspaceId: string
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
  pinned: boolean
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

function buildWelcomeRow(workspaceId: string, active: boolean): LumeSidebarSyntheticThreadRow {
  return {
    type: 'synthetic-thread',
    id: '__welcome__',
    workspaceId,
    label: '新对话',
    active,
  }
}

export function buildLumeSidebarViewModel({
  workspaces,
  threads,
  currentWorkspaceId,
  activeTabId,
  streamingStates,
  expandedWorkspaceIds,
  pinnedWorkspaceIds,
}: BuildLumeSidebarViewModelInput): LumeSidebarViewModel {
  const selectedWorkspaceId = currentWorkspaceId ?? workspaces[0]?.id ?? null
  const expandedSet = new Set(expandedWorkspaceIds)
  const pinnedSet = new Set(pinnedWorkspaceIds)

  const topActions: LumeSidebarTopAction[] = [
    { id: 'new-chat', label: '新建聊天', icon: 'square-pen', kind: 'button', shortcut: 'Ctrl N' },
    { id: 'search', label: '搜索', icon: 'search', kind: 'search', shortcut: 'Ctrl K' },
    { id: 'reading', label: '一起读书', icon: 'book-open', kind: 'button', active: activeTabId === '__reading__' },
    { id: 'skills', label: '技能', icon: 'box', kind: 'button', active: activeTabId === '__skills__' },
    {
      id: 'automations',
      label: '自动化',
      icon: 'clock',
      kind: 'button',
      badge: '即将推出',
      disabled: false,
      active: activeTabId === '__automation__',
    },
  ]

  const footerActions: LumeSidebarFooterAction[] = [
    { id: 'recycle-bin', label: '回收站', icon: 'trash', kind: 'button' },
    { id: 'settings', label: '设置', icon: 'settings', kind: 'button' },
  ]

  const workspaceItems = workspaces.map((workspace) => {
    const workspaceThreads = sortThreadsByUpdatedAt(
      threads.filter((thread) => getThreadWorkspaceId(thread) === workspace.id),
    )
    const threadGroups = buildThreadGroupRows(workspace.id, workspaceThreads, activeTabId, streamingStates)

    const rows: LumeSidebarWorkspaceRow[] = [
      buildWelcomeRow(workspace.id, workspace.id === selectedWorkspaceId && activeTabId === '__welcome__'),
      ...threadGroups,
    ]

    return {
      id: workspace.id,
      name: workspace.name,
      count: workspaceThreads.length,
      isCurrent: workspace.id === selectedWorkspaceId,
      isExpanded: expandedSet.has(workspace.id),
      pinned: pinnedSet.has(workspace.id),
      rows,
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
      isCurrent: false,
      isExpanded: expandedSet.has(UNASSIGNED_THREADS_WORKSPACE_ID),
      pinned: false,
      rows: buildThreadGroupRows(
        UNASSIGNED_THREADS_WORKSPACE_ID,
        unassignedThreads,
        activeTabId,
        streamingStates,
      ),
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

function buildThreadGroupRows(
  scopeId: string,
  threads: AgentThreadMeta[],
  activeTabId: string | null,
  streamingStates: Record<string, AgentRuntimePhase | undefined>,
): LumeSidebarThreadGroup[] {
  const imGroups = groupThreadsByImProvider(threads).map<LumeSidebarThreadGroup>((group) => ({
    type: 'thread-group',
    id: `${scopeId}:im:${group.provider}`,
    label: group.label,
    items: group.items.map((thread) => buildThreadItem(thread, activeTabId, streamingStates)),
  }))
  const regularThreads = threads.filter((thread) => !getThreadImProvider(thread))
  const dateGroups = groupThreadsByDate(regularThreads).map<LumeSidebarThreadGroup>((group) => ({
    type: 'thread-group',
    id: `${scopeId}:${group.label}`,
    label: group.label,
    items: group.items.map((thread) => buildThreadItem(thread, activeTabId, streamingStates)),
  }))

  return [...imGroups, ...dateGroups]
}

function buildThreadItem(
  thread: AgentThreadMeta,
  activeTabId: string | null,
  streamingStates: Record<string, AgentRuntimePhase | undefined>,
): LumeSidebarThreadItem {
  return {
    id: thread.id,
    title: thread.title,
    active: activeTabId === thread.id,
    pinned: !!thread.pinned,
    isStreaming: streamingStates[thread.id] === 'streaming',
    updatedAt: thread.updatedAt,
  }
}

function getThreadImProvider(thread: AgentThreadMeta): string | null {
  const source = thread.source
  return source?.type === 'im' && typeof source.provider === 'string' && source.provider.trim()
    ? source.provider.trim()
    : null
}

function groupThreadsByImProvider(threads: AgentThreadMeta[]): Array<ThreadGroup & { provider: string }> {
  const byProvider = new Map<string, AgentThreadMeta[]>()
  for (const thread of threads) {
    const provider = getThreadImProvider(thread)
    if (!provider) continue
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), thread])
  }

  return [...byProvider.entries()]
    .sort(([left], [right]) => compareImProviders(left, right))
    .map(([provider, items]) => ({
      provider,
      label: IM_PROVIDER_LABELS[provider] ?? provider,
      items: sortThreadsByUpdatedAt(items),
    }))
}

function compareImProviders(left: string, right: string): number {
  const leftIndex = IM_PROVIDER_ORDER.indexOf(left)
  const rightIndex = IM_PROVIDER_ORDER.indexOf(right)
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
  }
  return left.localeCompare(right)
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
