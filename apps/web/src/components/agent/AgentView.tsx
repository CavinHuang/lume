import { createFileTreeRevealRequest, settleFileTreeReveal } from '@/components/right-panel/right-panel-files-state'
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPendingAttachmentsFromFiles } from './editor-attachment-paste'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  agentStreamingStatesFamily,
  agentPendingInteractiveFamily,
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  rightPanelLayoutAtom,
  rightPanelWorkspaceActionAtom,
} from '@/atoms'
import { AgentHeader } from './AgentHeader'
import { AgentMessages } from './AgentMessages'
import { AgentTraceView } from './trace/AgentTraceView'
import { AgentInput, type PendingMessageAttachment } from './AgentInput'
import { PermissionBanner } from './PermissionBanner'
import { AskUserBanner } from './AskUserBanner'
import { DesktopActionBanner } from './DesktopActionBanner'
import { ThreadFileEnvProvider } from './thread-file-env'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { AGENT_IPC_CHANNELS, type AgentMessageAttachmentInput, type DesktopContextTarget, type FileRef, type GuardedFileRefValidationResult } from '@lume/shared'
import {
  createPendingAttachmentsFromSourcePaths,
  isFileDragPayload,
  type DragDropPayload,
} from './agent-file-drop'
import { abortStagedAttachment, sidecarCall } from '@/lib/desktop-api'
import type { OpenThreadFile } from './AgentFileReference'
import { pendingAttachmentRejectionMessage, validatePendingAttachmentBatch } from './pending-attachment-validation'
import { ThreadImageLightbox, type ThreadImageLightboxAttachment } from './ThreadImageLightbox'
interface AgentViewProps {
  threadId: string
  readOnly?: boolean
  messageMetadata?: Record<string, unknown>
  onMessageMetadataConsumed?: () => void
  desktopContextTarget?: DesktopContextTarget
  onSelectDesktopContextTarget?: (target: DesktopContextTarget) => void
  onClearDesktopContextTarget?: () => void
}

function guardedValidationStatus(code: Exclude<GuardedFileRefValidationResult, { ok: true }>['code']) {
  if (code === 'NOT_FOUND') return 'not_found' as const
  if (code === 'OUT_OF_SCOPE') return 'out_of_scope' as const
  if (code === 'BINDING_CHANGED') return 'binding_changed' as const
  if (code === 'KIND_MISMATCH') return 'kind_mismatch' as const
  if (code === 'UNAVAILABLE') return 'unavailable' as const
  return 'io_error' as const
}

export function AgentView({
  threadId,
  readOnly,
  messageMetadata,
  onMessageMetadataConsumed,
  desktopContextTarget,
  onSelectDesktopContextTarget,
  onClearDesktopContextTarget,
}: AgentViewProps) {
  const streamingState = useAtomValue(agentStreamingStatesFamily(threadId)) ?? 'idle'
  const pendingInteractive = useAtomValue(agentPendingInteractiveFamily(threadId))
  const pendingToolPermissions = pendingInteractive?.toolPermissions ?? []
  const pendingDesktopActionRequests = pendingInteractive?.desktopActionRequests ?? []
  const pendingAskUserQuestions = pendingInteractive?.askUserQuestions ?? []
  const activeToolPermission = pendingToolPermissions[0]
  const activeDesktopActionRequest = activeToolPermission
    ? undefined
    : pendingDesktopActionRequests[0]
  const activeAskUserQuestion = activeToolPermission || activeDesktopActionRequest
    ? undefined
    : pendingAskUserQuestions[0]
  // 动线 F3:审批卡被 Esc 收起成 pill 后不再遮蔽输入框——「收起去干别的」才成立
  const [permissionCollapsed, setPermissionCollapsed] = useState(false)
  useEffect(() => {
    setPermissionCollapsed(false)
  }, [activeToolPermission?.requestId])
  const hasComposerOverlay = Boolean(
    (activeToolPermission && !permissionCollapsed) || activeDesktopActionRequest || activeAskUserQuestion
  )

  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWsId = useAtomValue(currentWorkspaceIdAtom)
  const dispatchRightPanel = useSetAtom(rightPanelWorkspaceActionAtom)
  const setRightPanelLayout = useSetAtom(rightPanelLayoutAtom)
  const navigationRevisionRef = useRef(0)
  const pendingRevealRequestIdRef = useRef<string | null>(null)
  const workspaceSlug = useMemo(() => {
    const thread = threads.find((t) => t.id === threadId)
    const targetId = thread?.workspaceId ?? currentWsId
    return workspaces.find((w) => w.id === targetId)?.slug
  }, [threads, workspaces, currentWsId, threadId])
  const rightPanelBinding = useMemo(() => {
    const thread = threads.find((item) => item.id === threadId)
    const workspace = workspaces.find((item) => item.id === (thread?.workspaceId ?? currentWsId))
    return {
      workspaceId: thread?.workspaceId ?? currentWsId ?? undefined,
      fileContextId: thread?.fileContextId ?? thread?.id,
      projectBindingKey: workspace?.realpathKey ?? workspace?.projectPath,
    }
  }, [currentWsId, threadId, threads, workspaces])

  // 全局拖拽覆盖层
  const [isDragOver, setIsDragOver] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingMessageAttachment[]>([])
  const pendingAttachmentsRef = useRef<PendingMessageAttachment[]>([])

  const addPendingAttachments = useCallback((attachments: PendingMessageAttachment[]) => {
    if (attachments.length === 0) return
    const result = validatePendingAttachmentBatch(pendingAttachmentsRef.current, attachments)
    if (result.accepted.length > 0) {
      const next = [...pendingAttachmentsRef.current, ...result.accepted]
      pendingAttachmentsRef.current = next
      setPendingAttachments(next)
      toast.success(`已添加 ${result.accepted.length} 个附件`)
    }
    result.rejected.forEach(({ attachment, reason }) => {
      if (attachment.stagedAttachmentId) void abortStagedAttachment(attachment.stagedAttachmentId).catch(() => undefined)
      toast.error(`${attachment.filename}：${pendingAttachmentRejectionMessage(reason)}`)
    })
  }, [])

  // 白板「加入聊天」(ZCode composer tse 监听同型):暂存 PNG 附件进输入框。
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ file: File; handled: boolean }>).detail
      if (!detail || !(detail.file instanceof File)) return
      detail.handled = true
      void createPendingAttachmentsFromFiles([detail.file]).then((attachments) => {
        addPendingAttachments(attachments as PendingMessageAttachment[])
      })
    }
    window.addEventListener('lume:add-whiteboard-to-chat', handler)
    return () => window.removeEventListener('lume:add-whiteboard-to-chat', handler)
  }, [addPendingAttachments])

  const removePendingAttachment = useCallback((id: string) => {
    const removed = pendingAttachmentsRef.current.find((attachment) => attachment.id === id)
    if (removed?.stagedAttachmentId) void abortStagedAttachment(removed.stagedAttachmentId).catch(() => undefined)
    const next = pendingAttachmentsRef.current.filter((attachment) => attachment.id !== id)
    pendingAttachmentsRef.current = next
    setPendingAttachments(next)
  }, [])

  const clearPendingAttachments = useCallback(() => {
    pendingAttachmentsRef.current.forEach((attachment) => {
      if (attachment.stagedAttachmentId) void abortStagedAttachment(attachment.stagedAttachmentId).catch(() => undefined)
    })
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
  }, [])

  const reopenRightPanel = useCallback(() => {
    setRightPanelLayout((prev) => ({
      open: true,
      mode: prev.open && prev.mode === 'expanded' ? 'expanded' : 'normal',
    }))
  }, [setRightPanelLayout])

  const openThreadFilePreview = useCallback<OpenThreadFile>(async (path, signedRef, options) => {
    const navigationRevision = ++navigationRevisionRef.current
    if (pendingRevealRequestIdRef.current) {
      settleFileTreeReveal(pendingRevealRequestIdRef.current, { status: 'superseded' })
      pendingRevealRequestIdRef.current = null
    }

    if (options?.guardedRef) {
      let validation: GuardedFileRefValidationResult
      try {
        validation = await sidecarCall<GuardedFileRefValidationResult>(AGENT_IPC_CHANNELS.VALIDATE_GUARDED_FILE_REF, {
          guardedRef: options.guardedRef,
        })
      } catch {
        return 'io_error'
      }
      if (navigationRevision !== navigationRevisionRef.current) return 'superseded'
      if (!validation.ok) return guardedValidationStatus(validation.code)

      const resolvedRef = validation.entry.ref
      if (!resolvedRef) return 'io_error'
      if (validation.entry.isDirectory) {
        const { request, completion } = createFileTreeRevealRequest(resolvedRef, navigationRevision)
        pendingRevealRequestIdRef.current = request.requestId
        dispatchRightPanel({ type: 'reveal-directory', threadId, request, binding: rightPanelBinding })
        reopenRightPanel()
        const result = await completion
        if (pendingRevealRequestIdRef.current === request.requestId) pendingRevealRequestIdRef.current = null
        if (navigationRevision !== navigationRevisionRef.current) return 'superseded'
        return result.status
      }

      dispatchRightPanel({
        type: 'open-file',
        threadId,
        ref: resolvedRef,
        binding: rightPanelBinding,
        lineSelection: options.lineSelection,
        navigationRevision,
      })
      reopenRightPanel()
      return 'opened'
    }

    if (signedRef) {
      dispatchRightPanel({ type: 'open-file', threadId, ref: signedRef, binding: rightPanelBinding, navigationRevision })
      reopenRightPanel()
      return 'opened'
    }
    try {
      const ref = await sidecarCall<FileRef>(AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF, {
        recordKind: 'thread-attachment', threadId, ...(workspaceSlug ? { workspaceSlug } : {}), legacyRelativePath: path,
      })
      if (navigationRevision !== navigationRevisionRef.current) return 'superseded'
      dispatchRightPanel({ type: 'open-file', threadId, ref, binding: rightPanelBinding, navigationRevision })
      reopenRightPanel()
      return 'opened'
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法打开旧版文件引用')
      return 'unavailable'
    }
  }, [dispatchRightPanel, reopenRightPanel, rightPanelBinding, threadId, workspaceSlug])

  const openMemoryFilePreview = useCallback((path: string, signedRef?: FileRef) => {
    if (signedRef) {
      dispatchRightPanel({ type: 'open-file', threadId, ref: signedRef, binding: rightPanelBinding })
      reopenRightPanel()
      return
    }
    if (!workspaceSlug) return
    void sidecarCall<FileRef>(AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF, {
      recordKind: 'memory-source', workspaceSlug, legacyRelativePath: path,
    }).then((ref) => {
      dispatchRightPanel({ type: 'open-file', threadId, ref, binding: rightPanelBinding })
      reopenRightPanel()
    }).catch((error) => toast.error(error instanceof Error ? error.message : '无法打开旧版记忆引用'))
  }, [dispatchRightPanel, reopenRightPanel, rightPanelBinding, threadId, workspaceSlug])

  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<ThreadImageLightboxAttachment | null>(null)

  // 主列视图：对话 / 执行轨迹（Trace）
  const [mainView, setMainView] = useState<'chat' | 'trace'>('chat')
  const openThreadImagePreview = useCallback((attachment: AgentMessageAttachmentInput) => {
    // 图片附件走全屏 lightbox 预览，而非右侧文件面板（见 #16）
    setImagePreviewAttachment({ threadPath: attachment.threadPath, filename: attachment.filename, fileRef: attachment.fileRef })
  }, [])

  useEffect(() => {
    pendingAttachmentsRef.current.forEach((attachment) => {
      if (attachment.stagedAttachmentId) void abortStagedAttachment(attachment.stagedAttachmentId).catch(() => undefined)
    })
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.stagedAttachmentId) void abortStagedAttachment(attachment.stagedAttachmentId).catch(() => undefined)
      })
      if (pendingRevealRequestIdRef.current) {
        settleFileTreeReveal(pendingRevealRequestIdRef.current, { status: 'superseded' })
        pendingRevealRequestIdRef.current = null
      }
    }
  }, [threadId])

  useEffect(() => {
    if (readOnly) return
    let disposed = false
    let unlisten: (() => void) | undefined

    import('@/lib/desktop-runtime/window')
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
  }, [addPendingAttachments, threadId, readOnly])

  const viewToggle = (
    <div className="flex items-center rounded-md border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-0.5">
      {([['chat', '对话'], ['trace', '轨迹']] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setMainView(value)}
          aria-pressed={mainView === value}
          className={cn(
            'rounded px-2 py-0.5 text-caption transition-colors',
            mainView === value
              ? 'bg-[var(--lume-bg-panel)] font-medium text-[var(--lume-text-primary)] shadow-sm'
              : 'text-[var(--lume-text-muted)] hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* 主列 */}
      <ThreadFileEnvProvider value={{ threadId, workspaceSlug, fileContextId: rightPanelBinding.fileContextId }}>
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <AgentHeader threadId={threadId} readOnly={readOnly} actions={viewToggle} />
          {mainView === 'chat' ? (
            <AgentMessages
              threadId={threadId}
              streaming={streamingState === 'streaming'}
              onOpenThreadFile={openThreadFilePreview}
              onOpenThreadImage={openThreadImagePreview}
              onOpenMemorySource={openMemoryFilePreview}
            />
          ) : (
            <AgentTraceView key={threadId} threadId={threadId} />
          )}
          {!readOnly && (
            <div className="relative">
              <div
                aria-hidden={hasComposerOverlay}
                className={cn(
                  hasComposerOverlay && 'pointer-events-none select-none opacity-0',
                )}
              >
                <AgentInput
                  threadId={threadId}
                  streaming={streamingState === 'streaming'}
                  pendingAttachments={pendingAttachments}
                  onAddPendingAttachments={addPendingAttachments}
                  onRemovePendingAttachment={removePendingAttachment}
                  onClearPendingAttachments={clearPendingAttachments}
                  messageMetadata={messageMetadata}
                  onMessageMetadataConsumed={onMessageMetadataConsumed}
                  desktopContextTarget={desktopContextTarget}
                  onSelectDesktopContextTarget={onSelectDesktopContextTarget}
                  onClearDesktopContextTarget={onClearDesktopContextTarget}
                />
              </div>
              {activeToolPermission && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
                  {/* 三轮 review P3:容器全宽,收起态 pill 两侧透明区不得吞 composer 点击 */}
                  <div className="pointer-events-auto">
                    <PermissionBanner
                      threadId={threadId}
                      request={activeToolPermission}
                      onHiddenChange={setPermissionCollapsed}
                    />
                  </div>
                </div>
              )}
              {activeDesktopActionRequest && (
                <div className="absolute inset-x-0 bottom-0 z-30">
                  <DesktopActionBanner threadId={threadId} request={activeDesktopActionRequest} />
                </div>
              )}
              {activeAskUserQuestion && (
                <div className="absolute inset-x-0 bottom-0 z-30">
                  <AskUserBanner threadId={threadId} request={activeAskUserQuestion} />
                </div>
              )}
            </div>
          )}
        </div>
      </ThreadFileEnvProvider>

      <ThreadImageLightbox
        attachment={imagePreviewAttachment}
        threadId={threadId}
        workspaceSlug={workspaceSlug ?? undefined}
        onClose={() => setImagePreviewAttachment(null)}
      />

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
