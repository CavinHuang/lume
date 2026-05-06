import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  agentStreamingStatesAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
  activeTabIdAtom,
  commandPaletteOpenAtom,
  currentWorkspaceIdAtom,
  sidebarCollapsedAtom,
  tabsAtom,
  workspacePinnedIdsAtom,
} from '@/atoms'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { sidecarCall } from '@/lib/desktop-api'
import type { Tab } from '@/atoms/tab-atoms'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { LumeSidebar } from './LumeSidebar'
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

export function LeftSidebar() {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [pinnedIds, setPinnedIds] = useAtom(workspacePinnedIdsAtom)
  const setOpenCommandPalette = useSetAtom(commandPaletteOpenAtom)
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([])
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    destructive: boolean
    onConfirm: () => void
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
    setExpandedWorkspaceIds((previous) =>
      reconcileExpandedWorkspaces(workspaceIds, previous, currentWorkspaceId),
    )
  }, [currentWorkspaceId, workspaces])

  const model = buildLumeSidebarViewModel({
    workspaces,
    threads,
    currentWorkspaceId,
    activeTabId,
    streamingStates,
    expandedWorkspaceIds,
    pinnedWorkspaceIds: pinnedIds,
  })

  const openThread = (threadId: string, workspaceId?: string) => {
    if (threadId === '__welcome__') {
      handleNewThread(workspaceId)
      return
    }

    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return

    setActiveTabId(thread.id)
    if (!tabs.find((tab) => tab.id === thread.id)) {
      setTabs((previous) => [
        ...previous,
        { id: thread.id, type: 'agent', title: thread.title, threadId: thread.id },
      ])
    }
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
      setTabs((previous) => [...previous, { id: skillsId, type: 'skills', title: '技能' }])
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

  const deleteThread = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return

    setConfirmState({
      open: true,
      title: '删除会话',
      description: `确认删除会话「${thread.title}」？此操作不可撤销。`,
      confirmLabel: '删除',
      destructive: true,
      onConfirm: async () => {
        try {
          await sidecarCall('agent:delete-thread', { threadId: thread.id })
          setThreads((previous) => previous.filter((item) => item.id !== thread.id))
          setTabs((previous) => previous.filter((tab) => tab.id !== thread.id))
          if (activeTabId === thread.id) {
            setActiveTabId(null)
          }
          toast.success('已删除')
        } catch (error) {
          console.error('[LeftSidebar] 删除失败:', error)
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

    setConfirmState({
      open: true,
      title: '删除工作区',
      description: `确认删除工作区「${ws.name}」？其下所有会话也将被删除，此操作不可撤销。`,
      confirmLabel: '删除',
      destructive: true,
      onConfirm: async () => {
        try {
          await sidecarCall(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id: workspaceId })
          setWorkspaces((previous) => previous.filter((w) => w.id !== workspaceId))
          if (currentWorkspaceId === workspaceId) {
            setCurrentWorkspaceId(workspaces.find((w) => w.id !== workspaceId)?.id ?? null)
          }
          toast.success('已删除')
        } catch (error) {
          console.error('[LeftSidebar] 删除工作区失败:', error)
          toast.error('删除失败')
        }
      },
    })
  }

  const handleTopAction = (actionId: LumeSidebarTopActionId) => {
    switch (actionId) {
      case 'new-chat':
        handleNewThread()
        return
      case 'search':
        setOpenCommandPalette(true)
        return
      case 'skills':
        openSkills()
        return
      case 'automations':
        openAutomation()
        return
    }
  }

  const handleFooterAction = (actionId: LumeSidebarFooterActionId) => {
    if (actionId === 'settings') {
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
        collapsed={collapsed}
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
        onDeleteThread={deleteThread}
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
        onConfirm={confirmState.onConfirm}
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
