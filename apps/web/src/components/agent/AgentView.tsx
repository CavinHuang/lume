import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { agentStreamingStatesAtom, agentPendingInteractiveAtom, agentSidePanelViewAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, type SidePanelView } from '@/atoms'
import { AgentHeader } from './AgentHeader'
import { AgentMessages } from './AgentMessages'
import { AgentInput, type PendingMessageAttachment } from './AgentInput'
import { PermissionBanner } from './PermissionBanner'
import { AskUserBanner } from './AskUserBanner'
import { PlanApprovalOverlay } from './PlanApprovalOverlay'
import { ErrorBanner } from './ErrorBanner'
import { SidePanel } from './SidePanel'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  createPendingAttachmentsFromSourcePaths,
  isFileDragPayload,
  type DragDropPayload,
} from './agent-file-drop'

interface AgentViewProps {
  threadId: string
}

const SIDE_PANEL_ANIMATION_MS = 220

export function AgentView({ threadId }: AgentViewProps) {
  const streamingState = useAtomValue(agentStreamingStatesAtom)[threadId] ?? 'idle'
  const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)[threadId]
  const pendingToolPermissions = pendingInteractive?.toolPermissions ?? []
  const pendingAskUserQuestions = pendingInteractive?.askUserQuestions ?? []
  const pendingTaskApprovals = pendingInteractive?.taskApprovals ?? []
  const activeTaskApproval = pendingTaskApprovals[0]
  const activeToolPermission = activeTaskApproval ? undefined : pendingToolPermissions[0]
  const activeAskUserQuestion = activeTaskApproval || activeToolPermission ? undefined : pendingAskUserQuestions[0]
  const hasComposerOverlay = Boolean(activeTaskApproval || activeToolPermission || activeAskUserQuestion)
  const [approvalOverlayVisible, setApprovalOverlayVisible] = useState(Boolean(activeTaskApproval))

  const [sidePanelViews, setSidePanelViews] = useAtom(agentSidePanelViewAtom)
  const sidePanelView = sidePanelViews[threadId] ?? null
  const [renderedSidePanelView, setRenderedSidePanelView] = useState<SidePanelView>(sidePanelView)
  const [sidePanelVisible, setSidePanelVisible] = useState(Boolean(sidePanelView))
  const sidePanelCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sidePanelOpenTimerRef = useRef<number | null>(null)

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
  const [pendingAttachments, setPendingAttachments] = useState<PendingMessageAttachment[]>([])
  const [threadFilePreview, setThreadFilePreview] = useState<{ path: string; key: number } | null>(null)
  const [memoryFilePreview, setMemoryFilePreview] = useState<{ path: string; key: number } | null>(null)
  const threadFilePathToPreview = threadFilePreview?.path
  const threadFilePreviewKey = threadFilePreview?.key ?? 0
  const memoryFilePathToPreview = memoryFilePreview?.path
  const memoryFilePreviewKey = memoryFilePreview?.key ?? 0

  const addPendingAttachments = useCallback((attachments: PendingMessageAttachment[]) => {
    if (attachments.length === 0) return
    setPendingAttachments((prev) => [...prev, ...attachments])
  }, [])

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }, [])

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments([])
  }, [])

  const openThreadFilePreview = useCallback((path: string) => {
    setMemoryFilePreview(null)
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

  const openMemoryFilePreview = useCallback((path: string) => {
    setThreadFilePreview(null)
    setMemoryFilePreview((prev) => ({
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
    setMemoryFilePreview(null)
    setPendingAttachments([])
  }, [threadId])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
          if (disposed) return
          const payload = event.payload as DragDropPayload

          if (isFileDragPayload(payload)) {
            setIsDragOver(payload.type === 'enter')
          } else if (payload.type === 'leave') {
            setIsDragOver(false)
          }

          if (payload.type !== 'drop') return
          setIsDragOver(false)
          try {
            const attachments = await createPendingAttachmentsFromSourcePaths(payload.paths)
            if (attachments.length === 0) return
            addPendingAttachments(attachments)
            toast.success(`已添加 ${attachments.length} 个文件`)
          } catch (error) {
            console.error('[AgentView] 桌面文件拖拽读取失败:', error)
            toast.error('文件读取失败')
          }
        })
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [addPendingAttachments, threadId])

  useEffect(() => {
    setApprovalOverlayVisible(Boolean(activeTaskApproval))
  }, [activeTaskApproval?.contractId, threadId])

  useEffect(() => {
    if (sidePanelCloseTimerRef.current !== null) {
      clearTimeout(sidePanelCloseTimerRef.current)
      sidePanelCloseTimerRef.current = null
    }
    if (sidePanelOpenTimerRef.current !== null) {
      cancelAnimationFrame(sidePanelOpenTimerRef.current)
      sidePanelOpenTimerRef.current = null
    }

    if (sidePanelView) {
      setRenderedSidePanelView(sidePanelView)
      setSidePanelVisible(false)
      sidePanelOpenTimerRef.current = requestAnimationFrame(() => {
        sidePanelOpenTimerRef.current = requestAnimationFrame(() => {
          setSidePanelVisible(true)
          sidePanelOpenTimerRef.current = null
        })
      })
      return
    }

    setSidePanelVisible(false)
    sidePanelCloseTimerRef.current = setTimeout(() => {
      setRenderedSidePanelView(null)
      sidePanelCloseTimerRef.current = null
    }, SIDE_PANEL_ANIMATION_MS)
  }, [sidePanelView])

  useEffect(() => () => {
    if (sidePanelCloseTimerRef.current !== null) {
      clearTimeout(sidePanelCloseTimerRef.current)
    }
    if (sidePanelOpenTimerRef.current !== null) {
      cancelAnimationFrame(sidePanelOpenTimerRef.current)
    }
  }, [])

  return (
    <div className="flex-1 flex min-h-0 relative">
      {/* 主列 */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <AgentHeader threadId={threadId} />
        <AgentMessages
          threadId={threadId}
          streaming={streamingState === 'streaming'}
          onOpenThreadFile={openThreadFilePreview}
          onOpenMemorySource={openMemoryFilePreview}
        />
        {streamingState === 'errored' && <ErrorBanner threadId={threadId} />}
        <div className="relative">
          <div
            aria-hidden={hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible)}
            className={cn(
              hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible) && 'pointer-events-none select-none opacity-0',
            )}
          >
            <AgentInput
              threadId={threadId}
              streaming={streamingState === 'streaming'}
              pendingAttachments={pendingAttachments}
              onAddPendingAttachments={addPendingAttachments}
              onRemovePendingAttachment={removePendingAttachment}
              onClearPendingAttachments={clearPendingAttachments}
            />
          </div>
          {activeTaskApproval && (
            <div className="absolute inset-x-0 bottom-0 z-30">
              <PlanApprovalOverlay
                threadId={threadId}
                request={activeTaskApproval}
                onVisibilityChange={setApprovalOverlayVisible}
              />
            </div>
          )}
          {activeToolPermission && (
            <div className="absolute inset-x-0 bottom-0 z-30">
              <PermissionBanner threadId={threadId} request={activeToolPermission} />
            </div>
          )}
          {activeAskUserQuestion && (
            <div className="absolute inset-x-0 bottom-0 z-30">
              <AskUserBanner threadId={threadId} request={activeAskUserQuestion} />
            </div>
          )}
        </div>
      </div>

      {/* 右侧面板 */}
      {renderedSidePanelView && (
        <div className="flex min-h-0 shrink-0">
          <SidePanel
            threadId={threadId}
            view={renderedSidePanelView}
            open={sidePanelVisible}
            workspaceSlug={workspaceSlug}
            threadFilePathToPreview={threadFilePathToPreview}
            threadFilePreviewKey={threadFilePreviewKey}
            memoryFilePathToPreview={memoryFilePathToPreview}
            memoryFilePreviewKey={memoryFilePreviewKey}
          />
        </div>
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
