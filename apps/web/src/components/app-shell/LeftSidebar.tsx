import { useAtom, useSetAtom } from 'jotai'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  activeTabIdAtom,
  archiveInitialViewAtom,
  currentWorkspaceIdAtom,
  settingsInitialTabAtom,
  sidebarCollapsedAtom,
  tabsAtom,
  workspacePinnedIdsAtom,
} from '@/atoms'
import { useReleaseThreadState } from '@/hooks/use-release-thread-state'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  getMainWindowGeneration,
  markDesktopRendererReady,
  reportDesktopTrayNavigationConfirmationFailed,
  sidecarCall,
  syncDesktopTrayState,
} from '@/lib/desktop-api'
import type { Tab } from '@/atoms/tab-atoms'
import type { AgentThreadMeta, AgentWorkspace, AgentWorkspaceRemovalImpact, AgentWorkspaceRemoveMode } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { LumeSidebar } from './LumeSidebar'
import { countPlanningTodos, onPlanningTodoChange } from '@/lib/desktop-api/planning-todo'
import {
  buildLumeSidebarViewModel,
  type LumeSidebarFooterActionId,
  type LumeSidebarTopActionId,
  UNASSIGNED_THREADS_WORKSPACE_ID,
} from './lume-sidebar-view-model'
import {
  areAllWorkspacesExpanded,
  reconcileExpandedWorkspaces,
  toggleAllWorkspaces,
  toggleWorkspaceExpansion,
} from './left-sidebar-state'

export function deriveRecentTrayThreads(threads: AgentThreadMeta[]) {
  return threads
    .filter((thread) => !thread.parentThreadId && thread.status !== 'archived' && thread.status !== 'trashed')
    .flatMap((thread) => {
      if (typeof thread.id !== 'string' || thread.id.length < 1 || thread.id.length > 128) return []
      return [{
        id: thread.id,
        title: typeof thread.title === 'string' ? thread.title.slice(0, 256) : '',
        updatedAt: typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt) && thread.updatedAt >= 0
          ? thread.updatedAt
          : 0,
      }]
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
}

export async function confirmTrayThreadNavigation({
  threadId,
  generation,
  activeThreadId,
  listThreads,
  syncTrayState,
  timeoutMs = 5_000,
}: {
  threadId: string
  generation: number
  activeThreadId: string | null
  listThreads: () => Promise<AgentThreadMeta[]>
  syncTrayState: typeof syncDesktopTrayState
  timeoutMs?: number
}) {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const authoritative = await Promise.race([
    listThreads(),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('tray navigation confirmation timed out')), timeoutMs)
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
  if (!Array.isArray(authoritative)) throw new Error('invalid authoritative thread list')

  const target = authoritative.find((thread) => (
    thread.id === threadId
    && !thread.parentThreadId
    && thread.status !== 'archived'
    && thread.status !== 'trashed'
  )) ?? null
  const currentThreadId = target?.id
    ?? (authoritative.some((thread) => thread.id === activeThreadId) ? activeThreadId : null)
  await syncTrayState(generation, deriveRecentTrayThreads(authoritative), currentThreadId)
  return { threads: authoritative, target }
}

export function LeftSidebar({ forceCollapsed = false }: { forceCollapsed?: boolean } = {}) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [pinnedIds, setPinnedIds] = useAtom(workspacePinnedIdsAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const releaseThreadState = useReleaseThreadState()
  const setArchiveInitialView = useSetAtom(archiveInitialViewAtom)
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([])
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [desktopGeneration, setDesktopGeneration] = useState<number | null>(null)
  const [planningTodoCount, setPlanningTodoCount] = useState(0)
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    secondaryLabel?: string
    destructive: boolean
    onConfirm: () => void
    onSecondary?: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确认', destructive: false, onConfirm: () => {} })

  const hasUnassignedThreads = threads.some((thread) => thread.workspaceId == null)
  const workspaceIds = hasUnassignedThreads
    ? [...workspaces.map((workspace) => workspace.id), UNASSIGNED_THREADS_WORKSPACE_ID]
    : workspaces.map((workspace) => workspace.id)
  const allExpanded = areAllWorkspacesExpanded(workspaceIds, expandedWorkspaceIds)

  useEffect(() => {
    sidecarCall<AgentThreadMeta[]>('agent:list-threads', {})
      .then((result) => setThreads(Array.isArray(result) ? result : []))
      .catch(console.error)
  }, [setThreads])

  useEffect(() => {
    const refreshTodoCount = () => { if (!currentWorkspaceId) { setPlanningTodoCount(0); return }; void countPlanningTodos(currentWorkspaceId).then((result) => setPlanningTodoCount(result.open)).catch(() => setPlanningTodoCount(0)) }
    refreshTodoCount()
    let unsubscribe: (() => void) | undefined
    void onPlanningTodoChange(() => refreshTodoCount()).then((off) => { unsubscribe = off })
    return () => unsubscribe?.()
  }, [currentWorkspaceId])

  useEffect(() => {
    getMainWindowGeneration()
      .then(({ generation }) => markDesktopRendererReady(generation).then(() => setDesktopGeneration(generation)))
      .catch(() => {})
  }, [])

  const recentTrayThreads = useMemo(() => deriveRecentTrayThreads(threads), [threads])
  const trayStateSignature = JSON.stringify([
    recentTrayThreads.map(({ id, title }) => [id, title]),
    activeTabId,
  ])
  useEffect(() => {
    if (desktopGeneration == null) return
    const currentThreadId = threads.some((thread) => thread.id === activeTabId) ? activeTabId : null
    syncDesktopTrayState(desktopGeneration, recentTrayThreads, currentThreadId).catch(() => {})
  }, [desktopGeneration, trayStateSignature])

  useEffect(() => {
    setExpandedWorkspaceIds((previous) =>
      reconcileExpandedWorkspaces(workspaceIds, previous, currentWorkspaceId),
    )
  }, [currentWorkspaceId, workspaces])

  const model = buildLumeSidebarViewModel({
    workspaces,
    threads,
    currentWorkspaceId,
    activeTabId,
    expandedWorkspaceIds,
    pinnedWorkspaceIds: pinnedIds,
    planningTodoCount,
  })

  const openResolvedThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((tab) => tab.id === thread.id)) {
      setTabs((previous) => [
        ...previous,
        {
          id: thread.id,
          type: 'agent',
          title: thread.title,
          threadId: thread.id,
          // Persistent subagent threads are parent-controlled during the first release.
          ...(thread.parentThreadId ? { readOnly: true } : {}),
        },
      ])
    }
  }

  const openThread = (threadId: string, workspaceId?: string) => {
    if (threadId === '__welcome__') {
      handleNewThread(workspaceId)
      return
    }

    const thread = threads.find((item) => item.id === threadId)
    if (thread) openResolvedThread(thread)
  }

  const handleNewThread = (targetWorkspaceId = currentWorkspaceId ?? undefined) => {
    const workspaceId = targetWorkspaceId ?? null
    if (workspaceId) {
      setCurrentWorkspaceId(workspaceId)
    }
    setTabs((previous) => upsertWelcomeTab(previous, workspaceId))
    setActiveTabId('__welcome__')
  }

  const openSettings = () => {
    const settingsId = '__settings__'
    setActiveTabId(settingsId)

    if (!tabs.find((tab) => tab.id === settingsId)) {
      setTabs((previous) => [...previous, { id: settingsId, type: 'settings', title: '设置' }])
    }
  }

  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { listen?: (channel: string, listener: (payload: { action: string }) => void) => (() => void) | undefined } }).electronAPI
    const off = electronAPI?.listen?.('tray-action', ({ action, threadId, todoId, generation }: { action: string; threadId?: string; todoId?: string; generation?: number }) => {
      if (action === 'open-settings') openSettings()
      else if (action === 'new-thread') handleNewThread()
      else if (action === 'open-todo') openTodos(todoId)
      else if (action === 'open-thread' && threadId && Number.isSafeInteger(generation)) {
        void confirmTrayThreadNavigation({
          threadId,
          generation: generation as number,
          activeThreadId: activeTabId,
          listThreads: () => sidecarCall<AgentThreadMeta[]>('agent:list-threads', {}),
          syncTrayState: syncDesktopTrayState,
        }).then(({ threads: authoritative, target }) => {
          setThreads(authoritative)
          if (target) openResolvedThread(target)
        }).catch((error) => {
          reportDesktopTrayNavigationConfirmationFailed(
            generation as number,
            threadId,
            error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'query_failed',
          ).catch(() => {})
        })
      }
    })
    return () => off?.()
  }, [activeTabId, tabs])

  const openAutomation = () => {
    const automationId = '__automation__'
    setActiveTabId(automationId)

    if (!tabs.find((tab) => tab.id === automationId)) {
      setTabs((previous) => [...previous, { id: automationId, type: 'automation', title: '自动化' }])
    }
  }

  const openSkills = () => {
    const skillsId = '__skills__'
    setActiveTabId(skillsId)

    if (!tabs.find((tab) => tab.id === skillsId)) {
      setTabs((previous) => [...previous, { id: skillsId, type: 'skills', title: '技能 / 插件' }])
    }
  }

  const openLink = () => {
    const linkId = '__link__'
    setActiveTabId(linkId)
    if (!tabs.find((tab) => tab.id === linkId)) {
      setTabs((previous) => [...previous, { id: linkId, type: 'link', title: '连接器' }])
    }
  }

  const openLume = () => {
    const lumeId = '__lume__'
    setActiveTabId(lumeId)

    if (!tabs.find((tab) => tab.id === lumeId)) {
      setTabs((previous) => [...previous, { id: lumeId, type: 'lume', title: 'Lume' }])
    }
  }

  // 打开待办面板；targetTodoId 传入时定位到该待办（TodoView 用 todoId 初始化 selectedTodoId 高亮 + scope='all' 跨工作区命中）。
  const openTodos = (targetTodoId?: string) => {
    const id = '__todos__'
    setActiveTabId(id)
    setTabs((previous) => {
      const exists = previous.find((tab) => tab.id === id)
      const base = { id, type: 'todo' as const, title: '待办', workspaceId: currentWorkspaceId ?? undefined }
      if (!exists) return [...previous, targetTodoId ? { ...base, todoId: targetTodoId } : base]
      return previous.map((tab) =>
        tab.id === id ? { ...tab, ...(targetTodoId ? { todoId: targetTodoId } : { todoId: undefined }) } : tab,
      )
    })
  }

  const openProactive = () => {
    const proactiveId = '__proactive__'
    setActiveTabId(proactiveId)
    if (!tabs.find((tab) => tab.id === proactiveId)) {
      setTabs((previous) => [...previous, { id: proactiveId, type: 'proactive', title: '记忆与洞察' }])
    }
  }

  const togglePin = async (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return

    try {
      await sidecarCall('agent:toggle-pin-thread', { threadId: thread.id })
      setThreads((previous) =>
        previous.map((item) => (item.id === thread.id ? { ...item, pinned: !item.pinned } : item)),
      )
    } catch (error) {
      console.error('[LeftSidebar] 置顶失败:', error)
      toast.error('操作失败')
    }
  }

  const removeThreadFromNavigation = (threadId: string) => {
    setThreads((previous) => previous.filter((item) => item.id !== threadId))
    setTabs((previous) => previous.filter((tab) => tab.id !== threadId))
    if (activeTabId === threadId) {
      setActiveTabId(null)
    }
  }

  const archiveThread = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return

    setConfirmState({
      open: true,
      title: '归档会话',
      description: `确认归档会话「${thread.title}」？你可以在设置 > 归档中恢复。`,
      confirmLabel: '归档',
      destructive: false,
      onConfirm: async () => {
        try {
          await sidecarCall(AGENT_IPC_CHANNELS.ARCHIVE_THREAD, { threadId: thread.id })
          removeThreadFromNavigation(thread.id)
          // 归档后线程只能恢复后再打开，重开时 hydrate 重建，清掉无副作用
          releaseThreadState(thread.id)
          toast.success('已归档')
        } catch (error) {
          console.error('[LeftSidebar] 归档失败:', error)
          toast.error('归档失败')
        }
      },
    })
  }

  const trashThread = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return

    setConfirmState({
      open: true,
      title: '删除会话',
      description: `确认将会话「${thread.title}」移入回收站？你可以在设置 > 归档与回收站中恢复。`,
      confirmLabel: '移入回收站',
      destructive: true,
      onConfirm: async () => {
        try {
          await sidecarCall(AGENT_IPC_CHANNELS.TRASH_THREAD, { threadId: thread.id })
          removeThreadFromNavigation(thread.id)
          releaseThreadState(thread.id)
          toast.success('已移入回收站')
        } catch (error) {
          console.error('[LeftSidebar] 移入回收站失败:', error)
          toast.error('删除失败')
        }
      },
    })
  }

  const renameThread = async (threadId: string, title: string) => {
    const thread = threads.find((item) => item.id === threadId)
    const trimmed = title.trim()

    if (!thread || !trimmed || trimmed === thread.title) return

    try {
      await sidecarCall('agent:update-thread-title', { threadId: thread.id, title: trimmed })
      setThreads((previous) =>
        previous.map((item) => (item.id === thread.id ? { ...item, title: trimmed } : item)),
      )
      setTabs((previous) =>
        previous.map((tab) => (tab.id === thread.id ? { ...tab, title: trimmed } : tab)),
      )
    } catch (error) {
      console.error('[LeftSidebar] 重命名失败:', error)
      toast.error('重命名失败')
    }
  }

  const toggleWorkspacePin = (workspaceId: string) => {
    setPinnedIds((previous) =>
      previous.includes(workspaceId)
        ? previous.filter((id) => id !== workspaceId)
        : [...previous, workspaceId],
    )
  }

  const renameWorkspace = async (workspaceId: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return

    try {
      const updated = await sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, {
        id: workspaceId,
        name: trimmed,
      })
      setWorkspaces((previous) =>
        previous.map((ws) => (ws.id === workspaceId ? updated : ws)),
      )
    } catch (error) {
      console.error('[LeftSidebar] 重命名工作区失败:', error)
      toast.error('重命名失败')
    }
  }

  const deleteWorkspace = (workspaceId: string) => {
    const ws = workspaces.find((w) => w.id === workspaceId)
    if (!ws) return

    const remove = async (mode: AgentWorkspaceRemoveMode) => {
      try {
        await sidecarCall(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id: workspaceId, mode })
        setWorkspaces((previous) => previous.filter((w) => w.id !== workspaceId))
        setCurrentWorkspaceId((current) => current === workspaceId ? null : current)
        if (mode === 'deleteLumeData') {
          // 会话随项目数据进回收站：与单线程删除路径一致，统一释放渲染端状态
          // （keepHistory 会话转为普通会话仍在用，不能清）
          for (const thread of threads.filter((item) => item.workspaceId === workspaceId)) {
            releaseThreadState(thread.id)
          }
        }
        const nextThreads = await sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_THREADS, {})
        setThreads(Array.isArray(nextThreads) ? nextThreads : [])
        toast.success(mode === 'keepHistory' ? '已移除项目，会话已转为普通会话' : '已移除项目并将 Lume 用户数据移入回收站')
      } catch (error) {
        console.error('[LeftSidebar] 移除项目失败:', error)
        toast.error(error instanceof Error ? error.message : '移除项目失败')
      }
    }

    sidecarCall<AgentWorkspaceRemovalImpact>(AGENT_IPC_CHANNELS.GET_WORKSPACE_REMOVAL_IMPACT, { id: workspaceId })
      .then((impact) => {
        const impactText = `${impact.threads} 个会话、${impact.automations} 个自动化、${impact.planningTodos} 个待办、${impact.imAccounts} 个 IM 账号、${impact.imThreadBindings} 个 IM 会话绑定会受影响。真实项目目录不会被删除或修改。`
        setConfirmState({
          open: true,
          title: `移除项目「${ws.name}」？`,
          description: `${impactText} 仅移除项目会保留历史与 Lume 工作目录，并把会话转为普通会话。`,
          confirmLabel: '仅移除项目',
          secondaryLabel: '同时删除 Lume 用户数据',
          destructive: false,
          onConfirm: () => void remove('keepHistory'),
          onSecondary: () => setConfirmState({
            open: true,
            title: '是否删除 Lume 用户数据？',
            description: `${impactText} 会话将进入回收站，项目级记忆、技能和 MCP 等 Lume 内部数据会被移除；真实项目目录仍不会被删除。`,
            confirmLabel: '删除 Lume 用户数据',
            destructive: true,
            onConfirm: () => void remove('deleteLumeData'),
          }),
        })
      })
      .catch((error) => {
        console.error('[LeftSidebar] 获取项目移除影响失败:', error)
        toast.error('无法获取项目引用信息')
      })
  }

  const handleTopAction = (actionId: LumeSidebarTopActionId) => {
    switch (actionId) {
      case 'new-chat':
        handleNewThread()
        return
      case 'lume':
        openLume()
        return
      case 'skills':
        openSkills()
        return
      case 'connectors':
        openLink()
        return
      case 'automations':
        openAutomation()
        return
      case 'todos':
        openTodos()
        return
      case 'proactive':
        openProactive()
        return
    }
  }

  const handleFooterAction = (actionId: LumeSidebarFooterActionId) => {
    if (actionId === 'settings') {
      openSettings()
    }
    if (actionId === 'recycle-bin') {
      setSettingsInitialTab('archive')
      setArchiveInitialView('trash')
      openSettings()
    }
  }

  const handleWorkspaceCreated = (workspace: AgentWorkspace) => {
    setWorkspaces((previous) =>
      previous.some((item) => item.id === workspace.id) ? previous : [...previous, workspace],
    )
    setCurrentWorkspaceId(workspace.id)
    setExpandedWorkspaceIds((previous) =>
      reconcileExpandedWorkspaces([...workspaceIds, workspace.id], [...previous, workspace.id], workspace.id),
    )
  }

  return (
    <>
      <LumeSidebar
        collapsed={collapsed || forceCollapsed}
        allExpanded={allExpanded}
        model={model}
        onSetCollapsed={setCollapsed}
        onTopAction={handleTopAction}
        onFooterAction={handleFooterAction}
        onSelectWorkspace={(workspaceId) => {
          const nextState = applyWorkspaceSelection({
            tabs,
            activeTabId,
            expandedWorkspaceIds,
            currentWorkspaceId,
            workspaceId,
          })
          setCurrentWorkspaceId(nextState.currentWorkspaceId)
          setTabs(nextState.tabs)
          setExpandedWorkspaceIds(nextState.expandedWorkspaceIds)
        }}
        onToggleWorkspace={(workspaceId) => {
          const nextState = applyWorkspaceToggle({
            tabs,
            activeTabId,
            expandedWorkspaceIds,
            currentWorkspaceId,
            workspaceId,
          })
          setCurrentWorkspaceId(nextState.currentWorkspaceId)
          setTabs(nextState.tabs)
          setExpandedWorkspaceIds(nextState.expandedWorkspaceIds)
        }}
        onToggleAllWorkspaces={() => {
          setExpandedWorkspaceIds((previous) => toggleAllWorkspaces(workspaceIds, previous))
        }}
        onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
        onOpenThread={openThread}
        onToggleThreadPin={togglePin}
        onArchiveThread={archiveThread}
        onTrashThread={trashThread}
        onRenameThread={renameThread}
        onToggleWorkspacePin={toggleWorkspacePin}
        onRenameWorkspace={renameWorkspace}
        onDeleteWorkspace={deleteWorkspace}
      />

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={handleWorkspaceCreated}
      />

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((prev) => ({ ...prev, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        secondaryLabel={confirmState.secondaryLabel}
        onConfirm={confirmState.onConfirm}
        onSecondary={confirmState.onSecondary}
      />
    </>
  )
}

export function upsertWelcomeTab(tabs: Tab[], currentWorkspaceId: string | null): Tab[] {
  const workspaceId = currentWorkspaceId ?? undefined
  const existingIndex = tabs.findIndex((tab) => tab.id === '__welcome__')

  if (existingIndex === -1) {
    return [{ id: '__welcome__', type: 'welcome', title: '新会话', workspaceId }, ...tabs]
  }

  const existingTab = tabs[existingIndex]
  if (existingTab.workspaceId === workspaceId) {
    return tabs
  }

  return tabs.map((tab, index) => (index === existingIndex ? { ...tab, workspaceId } : tab))
}

export function retargetWelcomeTabIfActive(
  tabs: Tab[],
  activeTabId: string | null,
  workspaceId: string | null,
): Tab[] {
  if (activeTabId !== '__welcome__') {
    return tabs
  }

  return upsertWelcomeTab(tabs, workspaceId)
}

export function applyWorkspaceSelection({
  tabs,
  activeTabId,
  expandedWorkspaceIds,
  currentWorkspaceId,
  workspaceId,
}: {
  tabs: Tab[]
  activeTabId: string | null
  expandedWorkspaceIds: string[]
  currentWorkspaceId: string | null
  workspaceId: string
}) {
  const nextExpandedWorkspaceIds = expandedWorkspaceIds.includes(workspaceId)
    ? expandedWorkspaceIds
    : [...expandedWorkspaceIds, workspaceId]

  if (workspaceId === UNASSIGNED_THREADS_WORKSPACE_ID) {
    return {
      tabs,
      currentWorkspaceId,
      expandedWorkspaceIds: nextExpandedWorkspaceIds,
    }
  }

  return {
    tabs: retargetWelcomeTabIfActive(tabs, activeTabId, workspaceId),
    currentWorkspaceId: workspaceId,
    expandedWorkspaceIds: nextExpandedWorkspaceIds,
  }
}

export function applyWorkspaceToggle({
  tabs,
  activeTabId,
  expandedWorkspaceIds,
  currentWorkspaceId,
  workspaceId,
}: {
  tabs: Tab[]
  activeTabId: string | null
  expandedWorkspaceIds: string[]
  currentWorkspaceId: string | null
  workspaceId: string
}) {
  if (workspaceId === UNASSIGNED_THREADS_WORKSPACE_ID) {
    return {
      tabs,
      currentWorkspaceId,
      expandedWorkspaceIds: toggleWorkspaceExpansion(expandedWorkspaceIds, workspaceId),
    }
  }

  return {
    tabs: retargetWelcomeTabIfActive(tabs, activeTabId, workspaceId),
    currentWorkspaceId: workspaceId,
    expandedWorkspaceIds: toggleWorkspaceExpansion(expandedWorkspaceIds, workspaceId),
  }
}
