import { useState, useCallback, useMemo, useEffect } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { activeTabIdAtom, agentStreamingStatesAtom, agentPendingInteractiveAtom, agentSidePanelViewAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, tabsAtom } from '@/atoms'
import { AgentHeader } from './AgentHeader'
import { AgentMessages } from './AgentMessages'
import { AgentInput } from './AgentInput'
import { PermissionBanner } from './PermissionBanner'
import { AskUserBanner } from './AskUserBanner'
import { TaskApprovalBanner } from './TaskApprovalBanner'
import { ErrorBanner } from './ErrorBanner'
import { SidePanel } from './SidePanel'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { buildThreadPlanFileTab, upsertTab } from '@/components/tabs/file-tabs'

interface AgentViewProps {
  threadId: string
}

export function AgentView({ threadId }: AgentViewProps) {
  const [, setTabs] = useAtom(tabsAtom)
  const [, setActiveTabId] = useAtom(activeTabIdAtom)
  const streamingState = useAtomValue(agentStreamingStatesAtom)[threadId] ?? 'idle'
  const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)[threadId]
  const pendingToolPermissions = pendingInteractive?.toolPermissions ?? []
  const pendingAskUserQuestions = pendingInteractive?.askUserQuestions ?? []
  const pendingTaskApprovals = pendingInteractive?.taskApprovals ?? []

  const [sidePanelViews, setSidePanelViews] = useAtom(agentSidePanelViewAtom)
  const sidePanelView = sidePanelViews[threadId] ?? null

  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWsId = useAtomValue(currentWorkspaceIdAtom)
  const workspaceSlug = useMemo(() => {
    const thread = threads.find((t) => t.id === threadId)
    const targetId = thread?.workspaceId ?? currentWsId
    return workspaces.find((w) => w.id === targetId)?.slug
  }, [threads, workspaces, currentWsId, threadId])

  // 全局拖拽覆盖层
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useState({ current: 0 })[0]
  const pendingPlanFilePath = pendingTaskApprovals.find((request) => request.planFilePath)?.planFilePath
  const [threadFilePreview, setThreadFilePreview] = useState<{ path: string; key: number } | null>(null)
  const threadFilePathToPreview = threadFilePreview?.path ?? pendingPlanFilePath
  const threadFilePreviewKey = threadFilePreview?.key ?? 0

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [dragCounter])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setIsDragOver(false)
    }
  }, [dragCounter])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    try {
      const fileEntries: Array<{ filename: string; data: string }> = []
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1] ?? '')
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        fileEntries.push({ filename: file.name, data })
      }
      await sidecarCall(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
        ...(workspaceSlug ? { workspaceSlug } : {}),
        threadId,
        files: fileEntries
      })
      toast.success(`已添加 ${files.length} 个文件`)
    } catch (error) {
      console.error('[AgentView] 文件拖拽上传失败:', error)
      toast.error('文件上传失败')
    }
  }, [threadId, workspaceSlug, dragCounter])

  const openPlanFile = useCallback((planFilePath: string) => {
    const nextTab = buildThreadPlanFileTab({
      threadId,
      planFilePath,
      ...(workspaceSlug ? { workspaceSlug } : {}),
    })
    setTabs((prev) => upsertTab(prev, nextTab))
    setActiveTabId(nextTab.id)
  }, [setActiveTabId, setTabs, threadId, workspaceSlug])

  const openThreadFilePreview = useCallback((path: string) => {
    setThreadFilePreview((prev) => ({
      path,
      key: (prev?.key ?? 0) + 1,
    }))
    setSidePanelViews((prev) => (
      prev[threadId] === 'files'
        ? prev
        : { ...prev, [threadId]: 'files' }
    ))
  }, [setSidePanelViews, threadId])

  useEffect(() => {
    setThreadFilePreview(null)
  }, [threadId, pendingPlanFilePath])

  useEffect(() => {
    if (!pendingPlanFilePath) return
    setSidePanelViews((prev) => (
      prev[threadId] === 'files'
        ? prev
        : { ...prev, [threadId]: 'files' }
    ))
  }, [pendingPlanFilePath, setSidePanelViews, threadId])

  return (
    <div
      className="flex-1 flex min-h-0 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 主列 */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <AgentHeader threadId={threadId} />
        <AgentMessages
          threadId={threadId}
          streaming={streamingState === 'streaming'}
          onOpenThreadFile={openThreadFilePreview}
        />
        {streamingState === 'errored' && <ErrorBanner threadId={threadId} />}
        {pendingToolPermissions.map((request) => (
          <PermissionBanner key={request.requestId} threadId={threadId} request={request} />
        ))}
        {pendingAskUserQuestions.map((request) => (
          <AskUserBanner key={request.toolUseId} threadId={threadId} request={request} />
        ))}
        {pendingTaskApprovals.map((request) => (
          <TaskApprovalBanner
            key={request.contractId}
            threadId={threadId}
            request={request}
            onOpenPlan={request.planFilePath ? () => openPlanFile(request.planFilePath!) : undefined}
          />
        ))}
        <AgentInput threadId={threadId} streaming={streamingState === 'streaming'} />
      </div>

      {/* 右侧面板 */}
      {sidePanelView && (
        <SidePanel
          threadId={threadId}
          view={sidePanelView}
          workspaceSlug={workspaceSlug}
          threadFilePathToPreview={threadFilePathToPreview}
          threadFilePreviewKey={threadFilePreviewKey}
        />
      )}

      {/* 拖拽覆盖层 */}
      {isDragOver && (
        <div className={cn(
          'absolute inset-0 z-50 flex items-center justify-center',
          'bg-background/80 backdrop-blur-sm',
          'border-2 border-dashed border-primary rounded-xl',
          'pointer-events-none',
        )}>
          <div className="flex flex-col items-center gap-2">
            <Upload className="size-8 text-primary" />
            <p className="text-sm font-medium text-primary">释放以添加文件</p>
          </div>
        </div>
      )}
    </div>
  )
}
