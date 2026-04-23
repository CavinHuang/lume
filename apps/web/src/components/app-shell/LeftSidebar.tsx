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
} from '@/atoms'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { sidecarCall } from '@/lib/desktop-api'
import type { Tab } from '@/atoms/tab-atoms'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'
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
  const setOpenCommandPalette = useSetAtom(commandPaletteOpenAtom)
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([])
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)

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
  })

  const openThread = (threadId: string) => {
    if (threadId === '__welcome__') {
      handleNewThread()
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

  const handleNewThread = () => {
    setTabs((previous) => upsertWelcomeTab(previous, currentWorkspaceId))
    setActiveTabId('__welcome__')
  }

  const openSettings = () => {
    const settingsId = '__settings__'
    setActiveTabId(settingsId)

    if (!tabs.find((tab) => tab.id === settingsId)) {
      setTabs((previous) => [...previous, { id: settingsId, type: 'settings', title: '设置' }])
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

  const deleteThread = async (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    if (!confirm(`确认删除会话「${thread.title}」？`)) return

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

  const handleTopAction = (actionId: LumeSidebarTopActionId) => {
    switch (actionId) {
      case 'new-chat':
        handleNewThread()
        return
      case 'search':
        setOpenCommandPalette(true)
        return
      case 'skills':
        return
      case 'automations':
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
          if (workspaceId === UNASSIGNED_THREADS_WORKSPACE_ID) {
            return
          }

          setCurrentWorkspaceId(workspaceId)
        }}
        onToggleWorkspace={(workspaceId) => {
          setExpandedWorkspaceIds((previous) => {
            if (
              currentWorkspaceId === workspaceId ||
              workspaceId === UNASSIGNED_THREADS_WORKSPACE_ID
            ) {
              return toggleWorkspaceExpansion(previous, workspaceId)
            }

            return previous.includes(workspaceId) ? previous : [...previous, workspaceId]
          })
        }}
        onToggleAllWorkspaces={() => {
          setExpandedWorkspaceIds((previous) => toggleAllWorkspaces(workspaceIds, previous))
        }}
        onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
        onOpenThread={openThread}
        onToggleThreadPin={togglePin}
        onDeleteThread={deleteThread}
        onRenameThread={renameThread}
      />

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={handleWorkspaceCreated}
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
