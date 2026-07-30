import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ClipboardEvent, type HTMLAttributes, type ReactNode } from 'react'
import { BookOpen, Bot, Brain, Check, ChevronDown, ChevronRight, Clock, Copy, Database, Download, Edit3, ExternalLink, FileText, Gauge, GitFork, Globe, History, ListChecks, ListCollapse, Loader2, Maximize2, MessageSquareText, Minimize2, Package, Sparkles, Terminal, TriangleAlert, Workflow, Wrench, X } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { MermaidBlock, useSmoothStream } from '@lume/ui'
import { DiffAwareMarkdownPre } from '@/components/markdown/DiffAwareMarkdownPre'
import { ToolResultRenderer } from './tool-result-renderers'
import { cn } from '@/lib/utils'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeTabIdAtom, agentThreadsAtom, capabilityDetailTargetAtom, codingReviewPanelActionAtom, generalSettingsAtom, tabsAtom } from '@/atoms'
import { codingReviewFileKey } from '@/atoms/right-panel-atoms'
import type { MemoryContextUsedViewEvent, PlanPreviewView, RuntimeAssistantBlock, RuntimeAssistantTokenUsageView, RuntimeMessageView, RuntimeToolCallView, TaskProgressViewEvent } from './runtime-message-view'
import type { RuntimeCodingFileChange, RuntimeCodingReport } from '@lume/shared'
import { groupAssistantBlocksForMinimal, groupAssistantBlocksForStandard } from './minimal-assistant-grouping'
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { agentSend, getThreadMessageVersions, openExternal, revokeFilePreviewScope, sidecarCall, saveTextFileDialog, openInSystem, writeClipboardImage, writeClipboardText } from '@/lib/desktop-api'
import { parseMessageThreadFileReference, stripFileReferenceProtocolFromMarkdown } from './thread-file-links'
import { MessageFileReferenceBindingProvider, useMessageFileReferenceBinding, useMessageFileReferenceProtocolVersion } from './thread-file-env'
import { AGENT_IPC_CHANNELS, getAgentRole, parseAfterglowBlocks, stripAfterglowLines, type AgentCapabilityReferenceView, type AgentMessage, type AgentMessageAttachmentInput, type AgentRoleDefinition, type AgentThreadMeta, type AgentUserMessagePart, type FileRef } from '@lume/shared'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import { AGENT_ROLE_ASSETS } from '@/components/settings/agents-settings-state'
import { toast } from 'sonner'
import { AgentAttachmentGrid, isImageAttachment } from './AgentAttachmentGrid'
import { createThreadImagePreviewScope } from './thread-image-preview'
import { getMermaidCodeFromPreNode, isMermaidPreStreaming } from './markdown-mermaid'
import { getInfographicCodeFromPreNode, isInfographicPreStreaming } from './markdown-infographic'
import { InfographicBlock } from './InfographicBlock'
import { mermaidSvgToPngDataUrl } from '@/lib/mermaid-image'
import {
  buildExpressionActionSendInput,
  deriveExpressionActions,
  type ExpressionAction,
  type ExpressionActionId,
} from './expression-actions'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { AgentFileReference, type OpenThreadFile } from './AgentFileReference'
import { collectAssistantSources, type AssistantSourceReference } from './source-references'
import { prefetchSessionCodingDiffs, requestSessionCodingDiff } from '@/components/right-panel/coding-diff-cache'
const MARKDOWN_STREAM_MIN_DELAY_MS = 50

interface RuntimeEventContentBlockProps {
  message: RuntimeMessageView
  animate?: boolean
  streaming?: boolean
  showAssistantAvatar?: boolean
  canEditUserMessage?: boolean
  showExpressionActions?: boolean
  threadId: string
  onOpenThreadFile?: OpenThreadFile
  onOpenThreadImage?: (attachment: AgentMessageAttachmentInput) => void
  onOpenMemorySource?: (path: string, fileRef?: FileRef) => void
  onUserResizeStart?: () => void
}

/**
 * memo 比较函数：靠 message 引用稳定（2b 增量投影 + 2c reconcile/stabilize 引用稳定化）
 * 让未变历史消息跳过 re-render。引用不同即视为变化（re-render）——不再用 JSON.stringify
 * 兜底内容比较（2c 移除）。
 *
 * - 标量 props（streaming/animate/showAssistantAvatar/threadId）直接比较；
 * - onOpen* / onUserResizeStart 回调由父级 useCallback 保证引用稳定，不参与比较；
 * - message 用引用比较（===）。
 */
export function areRuntimeEventContentBlockPropsEqual(
  prev: RuntimeEventContentBlockProps,
  next: RuntimeEventContentBlockProps,
): boolean {
  if (prev.streaming !== next.streaming) return false
  if (prev.animate !== next.animate) return false
  if (prev.showAssistantAvatar !== next.showAssistantAvatar) return false
  if (prev.canEditUserMessage !== next.canEditUserMessage) return false
  if (prev.showExpressionActions !== next.showExpressionActions) return false
  if (prev.threadId !== next.threadId) return false
  return prev.message === next.message
}

export interface CopyFeedbackState {
  resetTimeoutId: ReturnType<typeof setTimeout> | null
}

interface CopyFeedbackDeps {
  setCopied: (next: boolean) => void
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  delayMs?: number
}

export function showTemporaryCopiedFeedback(
  state: CopyFeedbackState,
  { setCopied, setTimer, clearTimer, delayMs = 3000 }: CopyFeedbackDeps,
): void {
  setCopied(true)
  if (state.resetTimeoutId !== null) {
    clearTimer(state.resetTimeoutId)
  }
  state.resetTimeoutId = setTimer(() => {
    state.resetTimeoutId = null
    setCopied(false)
  }, delayMs)
}

export function getCopyTextWithoutAfterglow(container: Node & ParentNode): string {
  const clone = container.cloneNode(true) as Node & ParentNode
  clone.querySelectorAll('[data-afterglow]').forEach((node) => node.remove())
  clone.querySelectorAll<HTMLElement>('[data-file-reference-copy-text]').forEach((node) => {
    node.textContent = node.dataset.fileReferenceCopyText ?? node.textContent
  })
  return (clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export function getAssistantCopyText(text: string): string {
  return stripFileReferenceProtocolFromMarkdown(stripAfterglowLines(text))
}

export const RuntimeEventContentBlock = memo(function RuntimeEventContentBlock({
  message,
  animate,
  streaming,
  showAssistantAvatar = true,
  canEditUserMessage = false,
  showExpressionActions = false,
  threadId,
  onOpenThreadFile,
  onOpenThreadImage,
  onOpenMemorySource,
  onUserResizeStart,
}: RuntimeEventContentBlockProps) {
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''
  const generalSettings = useAtomValue(generalSettingsAtom)
  const useLeftAlignedMessageList = generalSettings.agentMessageListDisplayMode === 'left_aligned'
  const showMessageAvatar = generalSettings.agentMessageAvatarMode === 'visible'

  if (message.type === 'user') {
    return (
      <UserMessageBlock
        message={message}
        threadId={threadId}
        className={cls}
        leftAligned={useLeftAlignedMessageList}
        showAvatar={showMessageAvatar}
        canEdit={canEditUserMessage}
        onOpenThreadFile={onOpenThreadFile}
        onOpenThreadImage={onOpenThreadImage}
      />
    )
  }

  if (message.type === 'system') {
    return <SystemMessageBlock message={message} className={cls} />
  }

  const latestTaskProgressBlock = findLatestTaskProgressBlock(message.blocks)
  // message.blocks 引用由 stabilizeRuntimeMessages 稳定化（内容未变 → 同引用），
  // memo 化两次 filter 的结果，让下游 MinimalAssistantContent 的分组 useMemo 命中、
  // segments 引用稳定（否则每帧新数组 → 分组重算 → 段 blocks 新引用）。
  const contentBlocks = useMemo(
    () => message.blocks.filter((block) => block.type !== 'task_progress'),
    [message.blocks],
  )
  const useMinimalMode = useAtomValue(generalSettingsAtom).agentMessageDisplayMode === 'minimal'
  const minimalBlocks = useMemo(
    () => contentBlocks.filter((block) => block.type !== 'memory_context_used'),
    [contentBlocks],
  )
  const sourceCollection = useMemo(() => collectAssistantSources(contentBlocks), [contentBlocks])
  const activeStreamingTextBlockId = streaming === true && message.status === 'streaming'
    ? findActiveStreamingTextBlockId(message.blocks)
    : null
  const activitySignature = contentBlocks
    .map((block) => {
      if (block.type === 'text') return `text:${block.text}`
      if (block.type === 'thinking') return `thinking:${block.text}`
      if (block.type === 'tool_call') return `tool:${block.toolCall.id}:${block.toolCall.status}`
      if (block.type === 'plan_preview') return `plan:${block.preview.contractId}:${block.preview.markdown}`
      return ''
    })
    .join('|')
  const showIdleStatus = useDelayedAssistantIdleStatus(
    streaming === true && message.status === 'streaming' && !latestTaskProgressBlock,
    activitySignature,
  )
  const expressionActions = useMemo(
    () => showExpressionActions
      ? deriveExpressionActions(message.text, message.status === 'streaming')
      : [],
    [message.status, message.text, showExpressionActions],
  )

  return (
    <MessageFileReferenceBindingProvider value={message.fileReferenceBinding} consumerThreadId={threadId} protocolVersion={message.fileReferenceProtocolVersion}>
    <div className={cn('group/agent-message flex w-full max-w-[920px] min-w-0 gap-4', cls)}>
      {showAssistantAvatar && showMessageAvatar && (
        <div
          data-agent-message-avatar="true"
          className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--lume-accent)_24%,var(--lume-border-subtle))] bg-[var(--lume-bg-elevated)] text-[var(--lume-accent)] shadow-[0_10px_24px_-20px_hsl(var(--lume-shadow-panel)/0.72)]"
        >
          <Sparkles size={21} strokeWidth={1.8} fill="currentColor" fillOpacity={0.1} />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-4 pt-2">
        {useMinimalMode ? (
          <MinimalAssistantContent
            blocks={minimalBlocks}
            threadId={threadId}
            isStreamingMessage={streaming === true && message.status === 'streaming'}
            activeStreamingTextBlockId={activeStreamingTextBlockId}
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        ) : (
          <StandardAssistantContent
            blocks={minimalBlocks}
            threadId={threadId}
            activeStreamingTextBlockId={activeStreamingTextBlockId}
            isStreamingMessage={streaming === true && message.status === 'streaming'}
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        )}
        {message.codingReport && (
          <CodingRunReportCard report={message.codingReport} assistantMessageId={message.messageId} threadId={threadId} onOpenThreadFile={onOpenThreadFile} />
        )}
        {latestTaskProgressBlock && (
          <TaskProgressStatusLine event={latestTaskProgressBlock.event} />
        )}
        {showIdleStatus && <ShimmerStatusLine text="正在思考" />}
        {message.error && (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive/80">
            {message.error}
          </p>
        )}
        {expressionActions.length > 0 && (
          <ExpressionActionBar
            actions={expressionActions}
            messageId={message.messageId}
            threadId={threadId}
          />
        )}
        <AssistantMessageFooter
          threadId={threadId}
          messageId={message.messageId}
          text={message.text}
          isStreaming={message.status === 'streaming'}
          tokenCount={message.tokenCount}
          tokenCountSource={message.tokenCountSource}
          tokenUsage={message.tokenUsage}
          completedAt={message.completedAt}
          memoryEvents={contentBlocks
            .filter((b): b is Extract<typeof b, { type: 'memory_context_used' }> => b.type === 'memory_context_used')
            .map(b => b.event)}
          sources={sourceCollection.sources}
          sourcesTruncated={sourceCollection.truncated}
          onOpenMemorySource={onOpenMemorySource}
        />
        {message.imDelivery && <ImDeliveryStatusLine delivery={message.imDelivery} />}
      </div>
    </div>
    </MessageFileReferenceBindingProvider>
  )
}, areRuntimeEventContentBlockPropsEqual)

function ExpressionActionIcon({ id }: { id: ExpressionActionId }) {
  if (id === 'diagram') return <Workflow size={14} strokeWidth={1.9} />
  if (id === 'condense') return <ListCollapse size={14} strokeWidth={1.9} />
  return <ListChecks size={14} strokeWidth={1.9} />
}

export function ExpressionActionBar({
  actions,
  messageId,
  threadId,
}: {
  actions: ExpressionAction[]
  messageId?: string
  threadId: string
}) {
  const [sendingActionId, setSendingActionId] = useState<ExpressionActionId | null>(null)

  const sendAction = async (action: ExpressionAction) => {
    if (sendingActionId !== null) return
    setSendingActionId(action.id)
    try {
      await agentSend(buildExpressionActionSendInput(threadId, messageId, action))
    } catch (error) {
      console.error('[ExpressionActionBar] 发送表达转换指令失败:', error)
      toast.error('发送失败，请重试')
    } finally {
      setSendingActionId(null)
    }
  }

  return (
    <div
      data-expression-actions="true"
      className="flex flex-wrap items-center gap-2 pt-1"
      aria-label="换种表达"
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="outline"
          type="button"
          disabled={sendingActionId !== null}
          onClick={() => void sendAction(action)}
          className="h-7 rounded-full border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2.5 text-[12px] font-medium text-[var(--lume-text-secondary)] shadow-none hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)]"
        >
          {sendingActionId === action.id
            ? <Loader2 size={14} className="animate-spin" strokeWidth={1.9} />
            : <ExpressionActionIcon id={action.id} />}
          <span>{action.label}</span>
        </Button>
      ))}
    </div>
  )
}

function findActiveStreamingTextBlockId(blocks: RuntimeAssistantBlock[]): string | null {
  const lastBlock = blocks.at(-1)
  return lastBlock?.type === 'text' ? lastBlock.id : null
}

function ImDeliveryStatusLine({
  delivery,
}: {
  delivery: NonNullable<Extract<RuntimeMessageView, { type: 'assistant' }>['imDelivery']>
}) {
  const failed = delivery.status === 'failed'
  const pending = delivery.status === 'pending'
  const text = pending
    ? '正在发送到微信'
    : failed
      ? '发送微信失败'
      : '已发送到微信'
  return (
    <div
      className={cn(
        'flex min-h-5 items-center gap-1.5 text-[12px] leading-5 text-[var(--lume-text-muted)]',
        failed && 'text-destructive/75',
      )}
      title={delivery.error}
    >
      {pending
        ? <Loader2 size={13} className="animate-spin" strokeWidth={2} />
        : failed
          ? <X size={13} strokeWidth={2} />
          : <Check size={13} strokeWidth={2} />}
      <span>{text}</span>
    </div>
  )
}

function SystemMessageBlock({
  message,
  className,
}: {
  message: Extract<RuntimeMessageView, { type: 'system' }>
  className?: string
}) {
  if (message.variant === 'context_compaction') {
    return <ContextCompactionDivider message={message} className={className} />
  }
  return null
}

function ContextCompactionDivider({
  message,
  className,
}: {
  message: Extract<RuntimeMessageView, { type: 'system'; variant: 'context_compaction' }>
  className?: string
}) {
  const active = message.status === 'active'
  const [expanded, setExpanded] = useState(false)
  const hasSummary = message.status === 'completed' && Boolean(message.summary)
  return (
    <div className={cn('flex w-full flex-col gap-1', className)}>
      <div className="flex w-full items-center gap-4 px-6 py-1 text-[15px] font-semibold leading-6 text-[var(--lume-text-muted)]">
        <span className="h-px min-w-8 flex-1 bg-[var(--lume-border-subtle)]" />
        <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
          {active
            ? <Loader2 size={17} className="animate-spin text-[var(--lume-text-muted)]" strokeWidth={2} />
            : <History size={17} className="text-[var(--lume-text-muted)]" strokeWidth={2} />}
          {message.text}
          {hasSummary && (
            <Button
                variant="ghost"
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-1 text-[12px] font-medium text-[var(--lume-text-muted)] underline-offset-2 hover:text-[var(--lume-accent)] hover:underline"
            >
              {expanded ? '收起总结' : '查看总结'}
            </Button>
          )}
        </span>
        <span className="h-px min-w-8 flex-1 bg-[var(--lume-border-subtle)]" />
      </div>
      {hasSummary && expanded && (
        <div className="mx-auto max-h-60 w-full max-w-3xl overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--lume-bg-elevated)] px-4 py-3 text-[13px] font-normal leading-6 text-[var(--lume-text-secondary)]">
          {message.summary}
        </div>
      )}
    </div>
  )
}

function UserMessageBlock({
  message,
  threadId,
  className,
  canEdit,
  leftAligned,
  showAvatar,
  onOpenThreadFile,
  onOpenThreadImage,
}: {
  message: Extract<RuntimeMessageView, { type: 'user' }>
  threadId: string
  className: string
  canEdit: boolean
  leftAligned: boolean
  showAvatar: boolean
  onOpenThreadFile?: OpenThreadFile
  onOpenThreadImage?: (attachment: AgentMessageAttachmentInput) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<AgentMessage[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const editEnabled = canEdit && Boolean(message.messageId)
  const canShowVersions = Boolean(message.versionGroupId && (message.versionCount ?? 0) > 1)
  const agentInvocation = parseAgentRoleInstructionMessage(message.text)
  const visibleMessageText = agentInvocation?.task || message.text
  const imageSrcById = useThreadImageAttachmentSrcs(threadId, message.attachments)

  const loadVersions = async () => {
    if (!message.versionGroupId) return
    setVersionsOpen((value) => !value)
    if (versions.length > 0 || versionsLoading) return
    setVersionsLoading(true)
    try {
      const result = await getThreadMessageVersions({ threadId, versionGroupId: message.versionGroupId })
      setVersions(result.messages)
    } catch (error) {
      console.error('[RuntimeEventContentBlock] 加载消息版本失败:', error)
    } finally {
      setVersionsLoading(false)
    }
  }

  const submitEdit = async () => {
    const nextText = draft.trim()
    if (!message.messageId || !nextText || nextText === message.text) {
      setEditing(false)
      setDraft(message.text)
      return
    }
    setSubmitting(true)
    try {
      await agentSend({
        threadId,
        userMessage: nextText,
        editFromMessageId: message.messageId,
      })
      setEditing(false)
    } catch (error) {
      console.error('[RuntimeEventContentBlock] 编辑消息后重新发送失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={cn(
      'group/user-message flex w-full max-w-[920px] gap-3',
      leftAligned ? 'justify-start' : 'ml-auto justify-end gap-2',
      className,
    )}>
      {leftAligned && showAvatar && (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--lume-accent)] text-[15px] font-semibold text-[var(--lume-accent-foreground)] shadow-[0_12px_24px_-18px_hsl(var(--lume-shadow-panel)/0.72)]">
          L
        </div>
      )}
      <div className={cn(
        'flex min-w-0 flex-col gap-1.5',
        leftAligned ? 'max-w-[760px] items-start' : 'max-w-[560px] items-end',
      )}>
        {message.attachments && message.attachments.length > 0 && (
          <AgentAttachmentGrid
            attachments={message.attachments}
            align={leftAligned ? 'left' : 'right'}
            imageSrcById={imageSrcById}
            onOpenFile={(attachment) => onOpenThreadFile?.(attachment.threadPath, attachment.fileRef)}
            onOpenImage={(attachment) => onOpenThreadImage?.(attachment)}
          />
        )}
        {message.commentAttachments && message.commentAttachments.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', leftAligned ? 'justify-start' : 'justify-end')}>
            {message.commentAttachments.map((comment) => (
              <span
                key={comment.id}
                className="inline-flex max-w-[520px] items-center gap-1.5 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-2 py-1 text-[12px] font-normal text-[var(--lume-text-secondary)]"
                title={comment.body}
              >
                <MessageSquareText size={12} className="shrink-0 text-[var(--lume-accent)]" />
                <span className="truncate">{comment.position.path}:L{comment.position.startLine ?? comment.position.line}{(comment.position.startLine ?? comment.position.line) !== comment.position.line ? `–L${comment.position.line}` : ''} · {comment.body}</span>
              </span>
            ))}
          </div>
        )}
        <div className={cn(
          'text-[15px] font-medium leading-[22px] text-[var(--lume-text-primary)]',
          leftAligned
            ? 'px-0 py-0'
            : 'rounded-[12px] rounded-tr-[10px] bg-[var(--lume-accent-soft)] px-3 py-2 shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)]',
        )}>
          {editing ? (
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-20 w-[min(520px,70vw)] resize-y rounded-lg border border-[var(--lume-border-strong)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_82%,transparent)] px-2 py-1.5 text-[14px] leading-6 text-[var(--lume-text-primary)] outline-none focus:border-[var(--lume-accent)]"
              autoFocus
            />
          ) : (
            <UserAgentRoleInvocationContent
              text={message.text}
              messageParts={message.messageParts}
              capabilityReferences={message.capabilityReferences}
            />
          )}
        </div>
        <div className="pointer-events-none flex -translate-y-1 items-center gap-1 text-[var(--lume-text-muted)] opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/user-message:pointer-events-auto group-hover/user-message:translate-y-0 group-hover/user-message:opacity-100 group-focus-within/user-message:pointer-events-auto group-focus-within/user-message:translate-y-0 group-focus-within/user-message:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none">
          {canShowVersions && (
            <Button
                variant="ghost"
              type="button"
              onClick={() => void loadVersions()}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)]"
              title="查看历史版本"
            >
              <History size={13} />
              v{message.versionIndex}/{message.versionCount}
            </Button>
          )}
          <CopyMessageButton
            text={visibleMessageText}
            className="rounded-md p-1 transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)] data-[state=copied]:text-[var(--lume-success)]"
            iconSize={14}
          />
          {editing ? (
            <>
              <Button
                variant="ghost"
                type="button"
                disabled={submitting}
                onClick={() => void submitEdit()}
                className="rounded-md p-1 transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-success)_12%,transparent)] hover:text-[var(--lume-success)] disabled:opacity-50"
                title="保存并重新发送"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={submitting}
                onClick={() => {
                  setEditing(false)
                  setDraft(message.text)
                }}
                className="rounded-md p-1 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                title="取消"
              >
                <X size={14} />
              </Button>
            </>
          ) : (
            <Button
                variant="ghost"
              type="button"
              disabled={!editEnabled}
              onClick={() => {
                setDraft(message.text)
                setEditing(true)
              }}
              className="rounded-md p-1 transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              title={editEnabled ? '编辑并重新发送' : canEdit ? '旧消息暂不支持编辑' : '仅支持编辑最后一条消息'}
            >
              <Edit3 size={14} />
            </Button>
          )}
        </div>
        {versionsOpen && (
          <div className="w-[min(520px,70vw)] rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 text-left shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)]">
            {versionsLoading ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--lume-text-muted)]">
                <Loader2 size={13} className="animate-spin" />
                加载版本...
              </div>
            ) : (
              <div className="space-y-1">
                {versions.map((version) => (
                  <div key={version.id} className="rounded-lg bg-[var(--lume-accent-soft)] px-2 py-1.5">
                    <div className="mb-1 text-[11px] font-medium text-[var(--lume-accent)]">版本 {version.versionIndex}</div>
                    <div className="whitespace-pre-wrap text-[12px] leading-5 text-[var(--lume-text-secondary)]">{version.content}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {!leftAligned && (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--lume-accent)] text-[15px] font-semibold text-[var(--lume-accent-foreground)] shadow-[0_12px_24px_-18px_hsl(var(--lume-shadow-panel)/0.72)]">
          L
        </div>
      )}
    </div>
  )
}

export interface AgentRoleInstructionMessage {
  role: AgentRoleDefinition
  task: string
}

export function parseAgentRoleInstructionMessage(text: string): AgentRoleInstructionMessage | null {
  const match = text.match(/^请调用 Agent 工具，并将 subagent_type 设置为 "([^"]+)" 来处理这个任务：\s*([\s\S]*)$/u)
  if (!match) return null

  const role = getAgentRole(match[1] ?? '')
  if (!role) return null

  return {
    role,
    task: (match[2] ?? '').trim(),
  }
}

function useThreadImageAttachmentSrcs(
  threadId: string,
  attachments: AgentMessageAttachmentInput[] | undefined,
  workspaceSlug?: string,
): Record<string, string | undefined> {
  const [srcById, setSrcById] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    const imageAttachments = (attachments ?? []).filter(isImageAttachment)
    if (imageAttachments.length === 0) {
      setSrcById({})
      return
    }

    let cancelled = false
    const scopeTokens = new Set<string>()
    setSrcById({})
    void Promise.all(imageAttachments.map(async (attachment) => {
      try {
        const scope = await createThreadImagePreviewScope(attachment, {
          threadId,
          ...(workspaceSlug ? { workspaceSlug } : {}),
        })
        if (cancelled) {
          void revokeFilePreviewScope(scope.token).catch(() => undefined)
          return [attachment.id, undefined] as const
        }
        scopeTokens.add(scope.token)
        return [attachment.id, scope.url] as const
      } catch (error) {
        console.error('[RuntimeEventContentBlock] 加载附件图片失败:', error)
        return [attachment.id, undefined] as const
      }
    })).then((entries) => {
      if (cancelled) return
      setSrcById(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
      for (const token of scopeTokens) {
        void revokeFilePreviewScope(token).catch(() => undefined)
      }
    }
  }, [attachments, threadId, workspaceSlug])

  return srcById
}

export function UserAgentRoleInvocationContent({
  text,
  messageParts,
  capabilityReferences,
}: {
  text: string
  messageParts?: AgentUserMessagePart[]
  capabilityReferences?: AgentCapabilityReferenceView[]
}) {
  if (messageParts?.some((part) => part.type === 'capability_ref')) {
    return <CapabilityMessageText text={text} messageParts={messageParts} capabilityReferences={capabilityReferences} />
  }
  const invocation = parseAgentRoleInstructionMessage(text)

  if (!invocation) {
    return <CapabilityMessageText text={text} />
  }

  return (
    <div data-agent-role-message={invocation.role.id} className="min-w-0 space-y-2">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--lume-accent)_24%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_76%,var(--lume-accent-soft))] px-2 py-1 shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)]">
        <img
          src={AGENT_ROLE_ASSETS.roles[invocation.role.id]}
          alt=""
          className="size-6 shrink-0 rounded-full object-cover ring-1 ring-[color:color-mix(in_oklab,var(--lume-accent)_22%,transparent)]"
        />
        <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-[var(--lume-text-primary)]">
          {invocation.role.displayName}
        </span>
        <span className="shrink-0 text-[12px] font-medium leading-5 text-[var(--lume-text-secondary)]">
          {invocation.role.title}
        </span>
      </div>
      {invocation.task && (
        <CapabilityMessageText
          text={invocation.task}
          className="text-[15px] leading-[22px] text-[var(--lume-text-primary)]"
        />
      )}
    </div>
  )
}

function CapabilityMessageText({
  text,
  messageParts,
  capabilityReferences,
  className,
}: {
  text: string
  messageParts?: AgentUserMessagePart[]
  capabilityReferences?: AgentCapabilityReferenceView[]
  className?: string
}) {
  const setCapabilityDetailTarget = useSetAtom(capabilityDetailTargetAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const referencesByUri = new Map(capabilityReferences?.map((item) => [item.uri, item]) ?? [])
  const parts = messageParts ?? [{ type: 'text' as const, text }]
  const openCapabilityDetail = (reference: AgentCapabilityReferenceView | undefined, uri: string) => {
    if (!reference?.callable) {
      toast.info('此能力当前不可用')
      return
    }
    setCapabilityDetailTarget({ uri, kind: reference.kind })
    setTabs((current) => current.some((tab) => tab.id === '__skills__')
      ? current
      : [...current, { id: '__skills__', type: 'skills', title: '技能 / 插件' }])
    setActiveTabId('__skills__')
  }
  return (
    <div
      className={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', className)}
      onCopy={copyCapabilitySelection}
    >
      {parts.map((part, index) => {
        if (part.type === 'text') return part.text ? <span key={index}>{part.text}</span> : null
        const reference = referencesByUri.get(part.uri)
        const isPlugin = reference?.kind === 'plugin'
        return (
          <Button
            type="button"
            variant="ghost"
            key={part.occurrenceId}
            title={part.uri}
            data-capability-uri={part.uri}
            data-capability-callable={reference?.callable ?? false}
            onClick={() => openCapabilityDetail(reference, part.uri)}
            className={cn(
              'mx-0.5 inline-flex h-auto max-w-[260px] items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-[13px] font-medium',
              reference?.callable === false
                ? 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] text-[var(--lume-text-muted)]'
                : 'border-[color:color-mix(in_oklab,var(--lume-accent)_20%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]',
            )}
          >
            {isPlugin && reference?.icon?.url ? (
              <CapabilityPluginIcon src={reference.icon.url} />
            ) : isPlugin ? (
              <Package size={12} className="shrink-0" />
            ) : (
              <BookOpen size={12} className="shrink-0" />
            )}
            <span className="truncate">{reference?.displayName ?? part.uri}</span>
          </Button>
        )
      })}
    </div>
  )
}

function copyCapabilitySelection(event: ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!selection || !range || selection.isCollapsed) return
  let text = selection.toString()
  let changed = false
  for (const chip of event.currentTarget.querySelectorAll<HTMLElement>('[data-capability-uri]')) {
    if (!range.intersectsNode(chip)) continue
    const uri = chip.dataset.capabilityUri
    const label = chip.textContent
    if (!uri || !label || !text.includes(label)) continue
    text = text.replace(label, uri)
    changed = true
  }
  if (!changed) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
}

function CapabilityPluginIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Package size={12} className="shrink-0" />
  return <img src={src} alt="" className="size-3.5 shrink-0 rounded object-contain" onError={() => setFailed(true)} />
}

export function formatMessageAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${Math.round(kb / 1024)} MB`
}

const RuntimeEventAssistantBlockItem = memo(function RuntimeEventAssistantBlockItem({
  block,
  threadId,
  onOpenThreadFile,
  isStreaming,
  isActiveThinking,
  onUserResizeStart,
}: {
  block: RuntimeAssistantBlock
  threadId: string
  onOpenThreadFile?: OpenThreadFile
  isStreaming: boolean
  isActiveThinking: boolean
  onUserResizeStart?: () => void
}) {
  if (block.type === 'text') {
    return <SmoothText text={block.text} isStreaming={isStreaming} onOpenThreadFile={onOpenThreadFile} />
  }

  if (block.type === 'thinking') {
    return <RuntimeEventThinkingBlock text={block.text} active={isActiveThinking} />
  }

  if (block.type === 'plan_preview') {
    return <PlanPreviewCard preview={block.preview} onOpenThreadFile={onOpenThreadFile} />
  }

  if (block.type === 'task_progress') {
    return null
  }

  if (block.type === 'memory_context_used') {
    return null
  }

  if (block.type === 'todo_update') {
    return null
  }

  if (block.type === 'advisor_review') {
    const tone = block.event.severity === 'blocker'
      ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
      : block.event.severity === 'concern'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    return (
      <div className={cn('my-2 rounded-lg border px-3 py-2 text-sm', tone)}>
        <div className="flex items-center gap-2 font-medium">
          <Sparkles className="size-4" />
          <span>Advisor · {block.event.severity}</span>
        </div>
        <div className="mt-1">{block.event.summary}</div>
        {block.event.details ? <div className="mt-1 whitespace-pre-wrap opacity-85">{block.event.details}</div> : null}
      </div>
    )
  }

  if (block.toolCall.toolName === 'AskUserQuestion') {
    return <AskUserQuestionBlock toolCall={block.toolCall} />
  }

  return (
    <RuntimeEventToolCallBlock
      toolCall={block.toolCall}
      threadId={threadId}
      onUserResizeStart={onUserResizeStart}
    />
  )
})

type MinimalProcessGroupProps = {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onUserResizeStart?: () => void
}

/**
 * memo 比较函数：blocks 逐元素引用比较（未变 block 引用在投影层已稳定，
 * 见 runtime-event-message-projection 流式 block 引用稳定测试）。
 * 让"已完成 process 段"在活跃段流式追加或计时重渲染时跳过 re-render，
 * 消除简洁模式下多段同时重渲染导致的列表抖动与高度跳变。
 * - 标量 props（isStreamingMessage/threadId）直接比较；
 * - onUserResizeStart 由父级 useCallback 保证引用稳定，不参与比较。
 */
function areMinimalProcessGroupPropsEqual(
  prev: MinimalProcessGroupProps,
  next: MinimalProcessGroupProps,
): boolean {
  if (prev.isStreamingMessage !== next.isStreamingMessage) return false
  if (prev.threadId !== next.threadId) return false
  const prevBlocks = prev.blocks
  const nextBlocks = next.blocks
  if (prevBlocks === nextBlocks) return true
  if (prevBlocks.length !== nextBlocks.length) return false
  for (let i = 0; i < prevBlocks.length; i += 1) {
    if (prevBlocks[i] !== nextBlocks[i]) return false
  }
  return true
}

/**
 * 运行态总用时数字：自维护 setInterval(1000)，每秒只重渲染本 span，
 * 不连带重渲染整个 MinimalProcessGroup（design 7.3：运行态 ⏱ 每秒跳动是有意行为，保留）。
 * - baseMs：过程组内已完成 toolCall 的累计用时（非 Agent + Agent）；
 * - startedAt：当前 running tool 起始时间；缺失时 elapsedMs=0（退化为只显示 baseMs，保留原行为）。
 * tabular-nums 防宽度抖动；text 为空（total≤0 的瞬态）return null。
 */
const RunningDurationClock = memo(function RunningDurationClock({
  baseMs,
  startedAt,
}: {
  baseMs: number
  startedAt?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // interval 只挂一次；startedAt/baseMs 变化由 props 流入，render body 用最新值重算。
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsedMs = startedAt ? Math.max(0, now - Date.parse(startedAt)) : 0
  const text = formatRunningDuration(baseMs + elapsedMs)
  if (!text) return null
  return (
    <span data-running-clock className="inline-flex items-center gap-1 tabular-nums">
      <Clock size={12} />
      {text}
    </span>
  )
})

const MinimalProcessGroup = memo(function MinimalProcessGroup({
  blocks,
  threadId,
  isStreamingMessage,
  onUserResizeStart,
}: MinimalProcessGroupProps) {
  const [expanded, setExpanded] = useState(false)

  // 派生计算 memo：blocks 引用由 stabilizeRuntimeMessages + 项 A contentBlocks memo 稳定化，
  // blocks 不变时跳过重算。项 B 移除 now/计时后派生不再依赖时间，可干净 memo。
  const derived = useMemo(() => {
    const toolCalls = blocks
      .filter((b): b is Extract<RuntimeAssistantBlock, { type: 'tool_call' }> => b.type === 'tool_call')
      .map((b) => b.toolCall)
    const subagentCount = toolCalls.filter((tc) => tc.toolName === 'Agent').length
    const nonAgentCount = toolCalls.length - subagentCount
    const failedCount = toolCalls.filter((tc) => tc.status === 'failed').length
    const completedCount = toolCalls.filter((tc) => tc.status === 'completed').length
    // 仅展示第一个运行中的工具：agent 绝大多数情况顺序执行工具；并发多工具时其余的进度不单独展示。
    const runningTool = toolCalls.find((tc) => tc.status === 'running') ?? null
    const todoBlock = blocks.find((b): b is Extract<RuntimeAssistantBlock, { type: 'todo_update' }> => b.type === 'todo_update')
    const nonAgentDurationMs = toolCalls
      .filter((tc) => tc.toolName !== 'Agent')
      .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
    const subagentDurationMs = toolCalls
      .filter((tc) => tc.toolName === 'Agent')
      .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
    const thinkingCount = blocks.filter((b) => b.type === 'thinking').length
    return {
      toolCalls,
      subagentCount,
      nonAgentCount,
      failedCount,
      completedCount,
      runningTool,
      todoActiveForm: todoBlock?.data.currentActiveForm ?? null,
      nonAgentDurationMs,
      subagentDurationMs,
      thinkingCount,
    }
  }, [blocks])

  const hasRunning = isStreamingMessage && Boolean(derived.runningTool)

  // 折叠行摘要：图标 + 文本单元，用 · 分隔（不再使用 emoji）
  const summaryUnits: ReactNode[] = []
  if (hasRunning && derived.runningTool) {
    // 运行中：当前动作 + 已完成步数 + 总已用时
    summaryUnits.push(
      <span key="run" className="inline-flex items-center gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-[var(--lume-accent)]" />
        {derived.todoActiveForm ?? `正在执行 ${derived.runningTool.toolName}`}
      </span>,
    )
    summaryUnits.push(
      <span key="done">
        已完成 {derived.completedCount} 步{derived.failedCount > 0 ? ` · ${derived.failedCount} 失败` : ''}
      </span>,
    )
    // 运行态总用时跳动隔离到 RunningDurationClock：每秒只重渲染该数字，不连带重渲染整个 group。
    // 等价原 if(elapsed) 守卫——有已完成 tool 耗时或 running tool 起始时间才显示（不依赖 now）。
    const runningBaseMs = derived.nonAgentDurationMs + derived.subagentDurationMs
    if (runningBaseMs > 0 || derived.runningTool.startedAt) {
      summaryUnits.push(
        <RunningDurationClock key="dur" baseMs={runningBaseMs} startedAt={derived.runningTool.startedAt} />,
      )
    }
  } else {
    // 完成态：按分类（思考次数 / 工具调用数+时长 / 子代理数+时长 / 失败），按需省略。
    // 完成态时长定格：!hasRunning 下原 toolDurationMs/subagentTotalMs 分别退化为
    // nonAgentDurationMs/subagentDurationMs（runningElapsedMs 恒 0），直接用。
    if (derived.thinkingCount > 0) {
      summaryUnits.push(
        <span key="think" className="inline-flex items-center gap-1">
          <Brain size={12} />
          思考 {derived.thinkingCount} 次
        </span>,
      )
    }
    if (derived.nonAgentCount > 0) {
      const d = formatCompletedDuration(derived.nonAgentDurationMs)
      summaryUnits.push(
        <span key="ops" className="inline-flex items-center gap-1 tabular-nums">
          <Wrench size={12} />
          {derived.nonAgentCount} 个工具调用{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (derived.subagentCount > 0) {
      const d = formatCompletedDuration(derived.subagentDurationMs)
      summaryUnits.push(
        <span key="sub" className="inline-flex items-center gap-1 tabular-nums">
          <Bot size={12} />
          {derived.subagentCount} 子代理{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (derived.failedCount > 0) {
      summaryUnits.push(
        <span key="fail" className="inline-flex items-center gap-1 text-destructive/70">
          <TriangleAlert size={12} />
          {derived.failedCount} 失败
        </span>,
      )
    }
  }

  const summaryNodes: ReactNode[] = []
  summaryUnits.forEach((unit, index) => {
    if (index > 0) {
      summaryNodes.push(<span key={`sep-${index}`} className="text-foreground/25">·</span>)
    }
    summaryNodes.push(unit)
  })

  return (
    <div>
      <Button
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-auto items-center gap-1.5 p-0 font-normal text-[11.5px] text-foreground/40 transition-colors hover:bg-transparent hover:text-foreground/60"
      >
        {summaryNodes}
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} />
      </Button>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 pl-1">
          {blocks.map((block) => {
            if (block.type === 'thinking') {
              return <MinimalThinkingRow key={block.id} text={block.text} />
            }
            if (block.type === 'tool_call') {
              if (block.toolCall.toolName === 'Agent') {
                return (
                  <MinimalSubagentRow
                    key={block.id}
                    toolCall={block.toolCall}
                    threadId={threadId}
                    onUserResizeStart={onUserResizeStart}
                  />
                )
              }
              return <MinimalToolCallRow key={block.id} toolCall={block.toolCall} />
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}, areMinimalProcessGroupPropsEqual)

const MinimalToolCallRow = memo(function MinimalToolCallRow({ toolCall }: { toolCall: RuntimeToolCallView }) {
  const [open, setOpen] = useState(false)
  const input = asRecord(toolCall.input)
  const isRunning = toolCall.status === 'running'
  const resultOpen = !isRunning && open
  const shouldRenderResult = useDeferredUnmount(resultOpen)

  let resultData: unknown = toolCall.output
  if (typeof toolCall.output === 'string') {
    try {
      resultData = JSON.parse(toolCall.output)
    } catch {
      resultData = toolCall.output
    }
  }

  const Icon = toolCall.toolName === 'Bash' ? Terminal : Wrench

  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        disabled={isRunning}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60 disabled:hover:text-foreground/40"
      >
        <Icon size={12} className="shrink-0" />
        <span className="shrink-0 font-mono font-medium">{toolCall.toolName}</span>
        {toolCall.riskLevel && <span className={cn('shrink-0', riskLevelClassName(toolCall.riskLevel))}>{riskLevelLabel(toolCall.riskLevel)}</span>}
        <span className="min-w-0 flex-1 truncate">{summarizeInput(input)}</span>
        {toolCall.status === 'failed' && <TriangleAlert size={11} className="shrink-0 text-destructive/70" />}
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="shrink-0 tabular-nums">{formatDurationLabel(toolCall.durationMs)}</span>
        )}
        {isRunning ? (
          <Loader2 size={11} className="shrink-0 animate-spin" />
        ) : (
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        )}
      </Button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="mb-1 mt-1 max-h-[min(40vh,360px)] overflow-y-auto rounded-md bg-foreground/[0.03] p-2">
            <ToolExecutionDetails toolCall={toolCall} />
            <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
})

const MinimalThinkingRow = memo(function MinimalThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <Brain size={12} className="shrink-0" />
        <span className="flex-1">思考过程</span>
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </Button>
      <AnimatedCollapsiblePanel open={open}>
        <p className="mb-1 mt-1 whitespace-pre-wrap rounded-md bg-foreground/[0.03] p-2 text-[11.5px] leading-relaxed text-foreground/50">
          {text}
        </p>
      </AnimatedCollapsiblePanel>
    </div>
  )
})

const MinimalSubagentRow = memo(function MinimalSubagentRow({
  toolCall,
  threadId,
  onUserResizeStart,
}: {
  toolCall: RuntimeToolCallView
  threadId: string
  onUserResizeStart?: () => void
}) {
  const [open, setOpen] = useState(false)
  const input = asRecord(toolCall.input)
  const label = asString(input.description ?? input.prompt) ?? '子代理'
  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <Bot size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="shrink-0 tabular-nums">{formatDurationLabel(toolCall.durationMs)}</span>
        )}
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </Button>
      <AnimatedCollapsiblePanel open={open}>
        <div className="mb-1 mt-1">
          <SubagentInlinePanel
            threadId={threadId}
            toolUseId={toolCall.id}
            runId={toolCall.subagentRunId}
            status={toolCall.subagentStatus}
            description={asString(input.description ?? input.prompt)}
            agentType={asString(input.subagent_type)}
            prompt={asString(input.prompt)}
            onUserResizeStart={onUserResizeStart}
          />
        </div>
      </AnimatedCollapsiblePanel>
    </div>
  )
})

function StandardAssistantContent({
  blocks,
  threadId,
  activeStreamingTextBlockId,
  isStreamingMessage,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  activeStreamingTextBlockId: string | null
  isStreamingMessage: boolean
  onOpenThreadFile?: OpenThreadFile
  onUserResizeStart?: () => void
}) {
  const segments = useMemo(() => groupAssistantBlocksForStandard(blocks), [blocks])
  const lastBlockId = blocks.at(-1)?.id

  return segments.map((segment) => {
    if (segment.kind === 'image_tools') {
      return <ImageGenerationGroup key={`images:${segment.blocks[0]?.id ?? 'empty'}`} blocks={segment.blocks} />
    }
    if (segment.kind === 'ask_user_question') {
      return <AskUserQuestionBlock key={segment.block.id} toolCall={segment.block.toolCall} />
    }
    if (segment.kind === 'wiki_proposal') {
      return <WikiProposalBlock key={segment.block.id} block={segment.block} />
    }
    const block = segment.block
    return (
      <RuntimeEventAssistantBlockItem
        key={block.id}
        block={block}
        threadId={threadId}
        onOpenThreadFile={onOpenThreadFile}
        onUserResizeStart={onUserResizeStart}
        isStreaming={block.type === 'text' && block.id === activeStreamingTextBlockId}
        isActiveThinking={block.type === 'thinking' && isStreamingMessage && block.id === lastBlockId}
      />
    )
  })
}

function ImageGenerationGroup({
  blocks,
}: {
  blocks: Array<Extract<RuntimeAssistantBlock, { type: 'tool_call' }>>
}) {
  return (
    <div
      data-image-generation-group={blocks.length}
      className="flex w-full snap-x snap-mandatory gap-3 overflow-x-auto pb-1"
      aria-label="生成的图片"
    >
      {blocks.map((block) => {
        const { toolCall } = block
        const input = asRecord(toolCall.input)
        if (toolCall.status === 'running') {
          return (
            <div
              key={block.id}
              data-image-generation-loading="true"
              className="lume-image-generation-loading aspect-square w-[min(21.5vw,216px)] min-w-[190px] shrink-0 snap-start overflow-hidden rounded-[20px]"
              role="status"
              aria-label="正在生成图片"
            >
              <span className="sr-only">正在生成图片</span>
            </div>
          )
        }
        if (toolCall.status === 'failed') {
          return (
            <div
              key={block.id}
              className="flex aspect-square w-[min(21.5vw,216px)] min-w-[190px] shrink-0 snap-start items-center justify-center rounded-[20px] bg-foreground/[0.04] text-[12px] text-destructive/70"
            >
              图片生成失败
            </div>
          )
        }
        return (
          <div key={block.id} data-image-generation-result="true" className="shrink-0 snap-start">
            <ToolResultRenderer
              toolName={toolCall.toolName}
              input={input}
              result={parseToolCallOutput(toolCall.output)}
              imagePresentation="gallery"
            />
          </div>
        )
      })}
    </div>
  )
}

function WikiProposalBlock({
  block,
}: {
  block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }>
}) {
  return (
    <div data-wiki-proposal-result="true" className="w-full max-w-[460px]">
      <ToolResultRenderer
        toolName={block.toolCall.toolName}
        input={asRecord(block.toolCall.input)}
        result={parseToolCallOutput(block.toolCall.output)}
      />
    </div>
  )
}

function parseToolCallOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function CodingRunReportCard({
  report,
  assistantMessageId,
  threadId,
  onOpenThreadFile,
}: {
  report: RuntimeCodingReport
  assistantMessageId?: string
  threadId: string
  onOpenThreadFile?: OpenThreadFile
}) {
  const codingReviewPanelAction = useSetAtom(codingReviewPanelActionAtom)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [showAllChanges, setShowAllChanges] = useState(false)
  const [liveChangeSet, setLiveChangeSet] = useState(report.changeSet)
  const hasRisk = report.status === 'failed' || Boolean(report.baselineFailure) || report.externalChangedFiles.length > 0

  useEffect(() => {
    setLiveChangeSet(report.changeSet)
  }, [report.changeSet?.generatedAt])

  useEffect(() => {
    if (report.changeSet || report.changedFiles.length === 0) return
    let cancelled = false
    void sidecarCall<RuntimeCodingReport['changeSet']>(AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET, {
      threadId,
      paths: report.changedFiles,
    }).then((refreshed) => {
      if (!cancelled && refreshed) setLiveChangeSet(refreshed)
    }).catch(() => {
      // Historical reports may no longer have an accessible workspace.
    })
    return () => {
      cancelled = true
    }
  }, [report.changeSet, report.changedFiles, threadId])

  const currentChangeSet = liveChangeSet ?? report.changeSet
  const changes: RuntimeCodingFileChange[] = currentChangeSet
    ? currentChangeSet.files
    : report.fileChanges?.length
      ? report.fileChanges
      : report.changedFiles.map((path) => ({ path }))
  const activeChanges = changes
  const visibleChanges = showAllChanges ? activeChanges : activeChanges.slice(0, 3)
  const hiddenChangeCount = Math.max(0, activeChanges.length - visibleChanges.length)
  const addedLines = liveChangeSet ? liveChangeSet.totalAddedLines : report.totalAddedLines ?? changes.reduce((sum, change) => sum + (change.addedLines ?? 0), 0)
  const removedLines = liveChangeSet ? liveChangeSet.totalRemovedLines : report.totalRemovedLines ?? changes.reduce((sum, change) => sum + (change.removedLines ?? 0), 0)
  // The compact Coding card always reserves the diff counter row. Older
  // reports may not have per-file stats, but hiding the counters makes the
  // result look incomplete and differs from the Review panel.
  const hasLineStats = changes.length > 0
  const firstReviewChange = activeChanges[0]
  const canReviewDiff = activeChanges.length > 0 && (currentChangeSet !== undefined || report.fileChanges !== undefined)
  const reviewPathsKey = activeChanges.map(codingReviewFileKey).join('\u0000')

  useEffect(() => {
    codingReviewPanelAction({
      type: 'update',
      threadId,
      patch: {
        phase: report.phase,
        verificationRecords: report.verificationRecords,
        recommendedVerificationCommands: report.recommendedVerificationCommands,
        gitActions: report.gitActions,
        review: report.review,
      },
    })
  }, [codingReviewPanelAction, report.gitActions, report.phase, report.recommendedVerificationCommands, report.review, report.verificationRecords, threadId])
  const prefetchReviewDiffs = (limit = activeChanges.length) => {
    if (!report.runId) return
    void prefetchSessionCodingDiffs(
      threadId,
      report.runId,
      activeChanges.slice(0, limit).map((change) => ({ path: change.path, rootId: change.rootId })),
    )
  }

  useEffect(() => {
    const element = cardRef.current
    if (!element || !report.runId || !canReviewDiff || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      prefetchReviewDiffs(3)
      observer.disconnect()
    }, { rootMargin: '240px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [canReviewDiff, report.runId, reviewPathsKey, threadId])

  if (report.status === 'not_required' && !report.workspaceChanged && !report.pendingBackground) return null

  const openReview = async (change: RuntimeCodingFileChange, expand = true) => {
    if (!canReviewDiff) {
      if (onOpenThreadFile) await onOpenThreadFile(change.path)
      else toast.info('当前工作区没有可读取的 Coding diff')
      return
    }
    codingReviewPanelAction({
      type: 'open',
      threadId,
      changes: activeChanges,
      selectedPath: expand ? change.path : '',
      selectedRootId: expand ? change.rootId : undefined,
      runId: report.runId,
      turnId: report.turnId,
      assistantMessageId: report.assistantMessageId ?? assistantMessageId,
      phase: report.phase,
      verificationRecords: report.verificationRecords,
      recommendedVerificationCommands: report.recommendedVerificationCommands,
      gitActions: report.gitActions,
      review: report.review,
    })
  }

  return (
    <div ref={cardRef} onPointerEnter={() => prefetchReviewDiffs()} className={cn(
      'coding-summary-card w-full max-w-[640px] overflow-hidden rounded-[12px] border bg-[var(--lume-bg-elevated)] shadow-[0_8px_28px_-22px_hsl(var(--lume-shadow-panel)/0.8)]',
      report.status === 'failed' ? 'border-destructive/30' : 'border-[var(--lume-border-subtle)]',
    )}>
      <div className="coding-summary-header flex items-start gap-3 px-4 py-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-foreground/[0.08] text-[var(--lume-text-secondary)]">
          <Edit3 size={20} strokeWidth={1.8} />
        </div>
        <div className="coding-summary-title min-w-0 flex-1">
          <div className="truncate whitespace-nowrap text-[16px] font-semibold leading-5 text-[var(--lume-text-primary)]">
            {report.workspaceChanged && changes.length > 0 ? `已编辑 ${changes.length} 个文件` : '编码任务执行完成'}
          </div>
          {hasLineStats && (
            <div className="mt-1 whitespace-nowrap text-[13px] leading-4">
              <span className="text-emerald-500">+{addedLines}</span>
              <span className="ml-1 text-red-500">-{removedLines}</span>
            </div>
          )}
        </div>
        <div className="coding-summary-actions flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={!firstReviewChange || (!canReviewDiff && !onOpenThreadFile)}
            title={canReviewDiff ? '在右侧面板查看变更' : '当前仅支持打开文件预览'}
            className="h-8 px-3 text-[12px]"
            onPointerEnter={() => prefetchReviewDiffs()}
            onFocus={() => prefetchReviewDiffs()}
            onClick={() => firstReviewChange && void openReview(firstReviewChange, false)}
          >
            审核
          </Button>
        </div>
      </div>
      {visibleChanges.length > 0 && (
        <div className="border-t border-[var(--lume-border-subtle)] bg-foreground/[0.025] px-4 py-1">
          {visibleChanges.map((change) => (
            <div
              key={codingReviewFileKey(change)}
              className="flex min-h-9 w-full items-center gap-2 rounded-none text-[13px] text-[var(--lume-text-secondary)]"
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-9 min-w-0 flex-1 justify-start rounded-none px-0 text-left text-[13px] font-normal text-[var(--lume-text-secondary)] hover:bg-transparent hover:text-[var(--lume-text-primary)]"
                onPointerEnter={() => report.runId && void requestSessionCodingDiff(threadId, report.runId, change.path, change.rootId).catch(() => undefined)}
                onFocus={() => report.runId && void requestSessionCodingDiff(threadId, report.runId, change.path, change.rootId).catch(() => undefined)}
                onClick={() => void openReview(change)}
              >
                <span className="min-w-0 truncate">{change.path}</span>
              </Button>
              <span className="shrink-0 tabular-nums">
                <span className="text-emerald-500">+{change.addedLines ?? 0}</span>
                <span className="ml-2 text-red-500">-{change.removedLines ?? 0}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {hiddenChangeCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-1 rounded-none border-t border-[var(--lume-border-subtle)] px-4 text-[13px] font-medium text-[var(--lume-text-secondary)] hover:bg-transparent hover:text-[var(--lume-text-primary)]"
          onClick={() => setShowAllChanges(true)}
        >
          <span>再显示 {hiddenChangeCount} 个文件</span>
          <ChevronDown size={16} />
        </Button>
      )}
      {hasRisk && (
        <div className="flex items-start gap-1.5 border-t border-[var(--lume-border-subtle)] px-4 py-2.5 text-[12px] text-amber-700 dark:text-amber-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{report.baselineFailure ? `验证命令失败：${report.baselineFailure.command}` : report.externalChangedFiles.length > 0 ? `检测到外部改动：${formatFileList(report.externalChangedFiles)}` : report.message ?? '编码任务未通过验证'}</span>
        </div>
      )}
      {report.pendingBackground && (
        <div className="border-t border-[var(--lume-border-subtle)] px-4 py-2.5 text-[12px] text-amber-700 dark:text-amber-300">后台命令仍在运行，不影响继续对话；可稍后查看或停止任务。</div>
      )}
    </div>
  )
}

function formatFileList(files: string[]): string {
  if (files.length <= 4) return files.join('、')
  return `${files.slice(0, 4).join('、')} 等 ${files.length} 个文件`
}

function ToolExecutionDetails({ toolCall }: { toolCall: RuntimeToolCallView }) {
  const execution = toolCall.execution
  const resultRef = toolCall.resultRef ?? execution?.resultRef
  const errorText = toolCall.status === 'failed' ? formatToolErrorOutput(toolCall.output) : ''
  if (!execution && !resultRef && !errorText) return null

  const terminationLabel = execution?.terminationReason === 'completed'
    ? '正常结束'
    : execution?.terminationReason === 'nonzero'
      ? '非零退出'
      : execution?.terminationReason === 'timeout'
        ? '超时'
      : execution?.terminationReason === 'aborted'
          ? '已中止'
          : execution?.terminationReason === 'output_limit'
            ? '输出超限'
          : execution?.terminationReason === 'spawn_error'
            ? '启动失败'
            : null

  return (
    <div className="mb-2 space-y-1 rounded-md bg-foreground/[0.03] px-2.5 py-2 text-[11px] text-foreground/55">
      {errorText && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-destructive/[0.06] p-2 font-mono text-[11px] leading-5 text-destructive">{errorText}</pre>}
      {execution?.command && <div className="break-all"><span className="mr-1 text-foreground/40">命令</span><code>{execution.command}</code></div>}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {terminationLabel && <span>结果：{terminationLabel}</span>}
        {typeof execution?.exitCode === 'number' && <span>退出码：{execution.exitCode}</span>}
        {execution?.shell && <span>Shell：{execution.shell === 'powershell' ? 'PowerShell' : 'Bash'}</span>}
        {typeof execution?.durationMs === 'number' && <span>耗时：{formatDurationLabel(execution.durationMs)}</span>}
      </div>
      {execution?.stderrPreview && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] text-amber-600 dark:text-amber-300">stderr: {execution.stderrPreview}</pre>}
      {resultRef && <div className="break-all"><span className="mr-1 text-foreground/40">结果文件</span>{resultRef.path}</div>}
    </div>
  )
}

function formatToolErrorOutput(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 8_000)
  if (!output || typeof output !== 'object') return String(output ?? '')
  try { return JSON.stringify(output, null, 2).slice(0, 8_000) } catch { return String(output) }
}

function MinimalAssistantContent({
  blocks,
  threadId,
  isStreamingMessage,
  activeStreamingTextBlockId,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  activeStreamingTextBlockId: string | null
  onOpenThreadFile?: OpenThreadFile
  onUserResizeStart?: () => void
}) {
  const segments = useMemo(() => groupAssistantBlocksForMinimal(blocks), [blocks])

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === 'image_tools') {
          return <ImageGenerationGroup key={`images:${segment.blocks[0]?.id ?? 'empty'}`} blocks={segment.blocks} />
        }
        if (segment.kind === 'ask_user_question') {
          return <AskUserQuestionBlock key={segment.block.id} toolCall={segment.block.toolCall} />
        }
        if (segment.kind === 'wiki_proposal') {
          return <WikiProposalBlock key={segment.block.id} block={segment.block} />
        }
        if (segment.kind === 'inline') {
          const block = segment.block
          if (block.type === 'text') {
            return (
              <SmoothText
                key={block.id}
                text={block.text}
                isStreaming={block.id === activeStreamingTextBlockId}
                onOpenThreadFile={onOpenThreadFile}
              />
            )
          }
          if (block.type === 'plan_preview') {
            return <PlanPreviewCard key={block.id} preview={block.preview} onOpenThreadFile={onOpenThreadFile} />
          }
          return null
        }
        return (
          <MinimalProcessGroup
            key={`process:${segment.blocks[0]?.id ?? 'empty'}`}
            blocks={segment.blocks}
            threadId={threadId}
            isStreamingMessage={isStreamingMessage}
            onUserResizeStart={onUserResizeStart}
          />
        )
      })}
    </>
  )
}

export function normalizeMemoryCitationPath(citation: string): string | null {
  const withoutLines = citation.replace(/#L\d+(?:-L?\d+)?$/i, '')
  const schemeMatch = withoutLines.match(/^[a-z]+:[a-z-]+:(\/.+)$/i)
  const path = schemeMatch?.[1] ?? (withoutLines.startsWith('/') ? withoutLines : '')
  return path.trim() || null
}

type MemoryCitationItem = Extract<RuntimeAssistantBlock, { type: 'memory_context_used' }>['event']['items'][number]
type MemoryCitationGroupKey = 'claims' | 'workspace_core' | 'global_preferences' | 'conversation_history' | 'maybe_stale' | 'relevant'

export function groupMemoryCitationItems(items: MemoryCitationItem[]): Array<{
  key: MemoryCitationGroupKey
  label: string
  items: MemoryCitationItem[]
}> {
  const groups: Record<MemoryCitationGroupKey, MemoryCitationItem[]> = {
    claims: [],
    workspace_core: [],
    global_preferences: [],
    conversation_history: [],
    maybe_stale: [],
    relevant: [],
  }

  for (const item of items) {
    groups[getMemoryCitationGroupKey(item)].push(item)
  }

  return [
    { key: 'claims' as const, label: '结构化事实', items: groups.claims },
    { key: 'workspace_core' as const, label: '工作区核心', items: groups.workspace_core },
    { key: 'global_preferences' as const, label: '全局偏好', items: groups.global_preferences },
    { key: 'conversation_history' as const, label: '历史连续性', items: groups.conversation_history },
    { key: 'maybe_stale' as const, label: '可能过期', items: groups.maybe_stale },
    { key: 'relevant' as const, label: '相关记忆', items: groups.relevant },
  ].filter((group) => group.items.length > 0)
}

function getMemoryCitationGroupKey(item: MemoryCitationItem): MemoryCitationGroupKey {
  if (item.status === 'suspected_stale') return 'maybe_stale'
  if (item.claim) return 'claims'
  if (isConversationHistoryCitation(item)) return 'conversation_history'
  if (item.scope === 'global' && item.kind === 'preference') return 'global_preferences'
  if (item.scope === 'workspace' && isWorkspaceCoreCitation(item)) return 'workspace_core'
  return 'relevant'
}

function isConversationHistoryCitation(item: MemoryCitationItem): boolean {
  return item.reason === 'recent daily memory'
    || item.reason === 'recent run memory'
    || /:(?:daily|run):/i.test(item.citation)
}

function isWorkspaceCoreCitation(item: MemoryCitationItem): boolean {
  return item.reason.includes('memory brief')
    || /workspace:memory:/i.test(item.citation)
    || /\/memory\/MEMORY\.md(?:#|$)/i.test(item.citation)
}

export function compactMemoryCitationLabel(citation: string): string {
  const withoutLines = citation.replace(/#L\d+(?:-L?\d+)?$/i, '')
  const withoutScheme = withoutLines.replace(/^[a-z]+:[a-z-]+:/i, '')
  return withoutScheme.split('/').filter(Boolean).at(-1) ?? withoutScheme
}

function findLatestTaskProgressBlock(blocks: RuntimeAssistantBlock[]): Extract<RuntimeAssistantBlock, { type: 'task_progress' }> | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === 'task_progress') return block
  }
  return undefined
}

export function getTaskProgressStatusText(event: TaskProgressViewEvent): string {
  const current = event.currentTaskId
    ? event.tasks.find((task) => task.id === event.currentTaskId)
    : event.tasks.find((task) => task.status === 'running')
  const title = current?.title || current?.description || current?.id
  if (event.status === 'completed') return '任务已完成'
  if (event.status === 'failed') return title ? `执行失败：${title}` : '任务执行失败'
  if (title) return `正在执行：${title}`
  return event.message?.trim() || '正在执行任务'
}

function TaskProgressStatusLine({ event }: { event: TaskProgressViewEvent }) {
  return <ShimmerStatusLine text={getTaskProgressStatusText(event)} />
}

function ShimmerStatusLine({ text }: { text: string }) {
  return (
    <div className="flex min-h-5 items-center text-[13px] font-medium leading-5 text-[var(--lume-text-muted)]">
      <span className="lume-shimmer-text truncate">{text}</span>
    </div>
  )
}

function useDelayedAssistantIdleStatus(active: boolean, activitySignature: string): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(false)
    if (!active) return

    const timeoutId = window.setTimeout(() => {
      setVisible(true)
    }, 3000)
    return () => window.clearTimeout(timeoutId)
  }, [active, activitySignature])

  return visible
}

const RuntimeEventThinkingBlock = memo(function RuntimeEventThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [collapsed, setCollapsed] = useState(!active)

  useEffect(() => {
    if (active) {
      setCollapsed(false)
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCollapsed(true)
    }, 650)
    return () => window.clearTimeout(timeoutId)
  }, [active])

  return (
    <div className="border-l-2 border-dashed border-foreground/20 pl-3">
      <Button
                variant="ghost"
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex items-center gap-1 text-[12px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <ChevronRight size={12} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        思考过程
      </Button>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--lume-text-muted)]">{text}</p>
        </div>
      </div>
    </div>
  )
})

function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
  )
}

const MARKDOWN_INCOMPLETE_COMPONENTS = {
  link: 'incomplete-link',
  image: 'incomplete-image',
  table: 'incomplete-table',
} as const

const AfterglowLine = memo(function AfterglowLine({ text }: { text: string }) {
  return (
    <p
      className="my-1.5 select-none text-[13px] italic leading-6 text-[color:color-mix(in_oklab,var(--lume-text-muted)_70%,transparent)]"
      aria-hidden="true"
      data-afterglow="true"
      data-afterglow-text={`⟡ ${text}`}
    >
      <span className="opacity-70">⟡</span>
      <span className="ml-1.5">{text}</span>
    </p>
  )
})

const SmoothText = memo(function SmoothText({
  text,
  isStreaming,
  onOpenThreadFile,
}: {
  text: string
  isStreaming: boolean
  onOpenThreadFile?: OpenThreadFile
}) {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming,
    minDelay: MARKDOWN_STREAM_MIN_DELAY_MS,
  })
  const isDark = useIsDark()
  const markdownStreaming = useMemo(() => ({
    hasNextChunk: isStreaming,
    enableAnimation: isStreaming,
    tail: isStreaming,
    incompleteMarkdownComponentMap: MARKDOWN_INCOMPLETE_COMPONENTS,
  }), [isStreaming])
  const markdownComponents = useMemo(() => ({
    pre: (props: MarkdownPreProps) => <MarkdownPre {...props} />,
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
    a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} onOpenThreadFile={onOpenThreadFile} />,
    'incomplete-link': IncompleteLink,
    'incomplete-image': IncompleteImage,
    'incomplete-table': IncompleteTable,
  }), [onOpenThreadFile])
  const afterglowBlocks = useMemo(
    () => displayedContent.includes('⟡') ? parseAfterglowBlocks(displayedContent) : null,
    [displayedContent],
  )
  const handleCopy = useMemo(() => (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const fragment = selection.getRangeAt(0).cloneContents()
    const text = getCopyTextWithoutAfterglow(fragment)
    if (!text) return
    event.preventDefault()
    void writeClipboardText(text).catch((error) => {
      console.error('[SmoothText] 复制选区失败:', error)
      toast.error('复制失败')
    })
  }, [])
  const renderMarkdown = (content: string, key?: string) => (
    <XMarkdown
      key={key}
      className="agent-message-markdown x-markdown text-[15px] leading-7 text-[var(--lume-text-primary)]"
      rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      streaming={markdownStreaming}
      components={markdownComponents}
    >
      {content}
    </XMarkdown>
  )

  return (
    <div className="min-w-0 w-full" onCopy={handleCopy}>
      {afterglowBlocks === null
        ? renderMarkdown(displayedContent)
        : (() => {
            const afterglowItems = afterglowBlocks.filter((b): b is Extract<typeof b, { type: 'afterglow' }> => b.type === 'afterglow')
            return (
              <>
                {afterglowBlocks.map((block, index) =>
                  block.type === 'afterglow'
                    ? null
                    : block.text.trim()
                      ? renderMarkdown(block.text, `markdown:${index}`)
                      : null,
                )}
                {afterglowItems.map((block, index) => (
                  <AfterglowLine key={`afterglow:${index}`} text={block.text} />
                ))}
              </>
            )
          })()}
    </div>
  )
})

export function PlanPreviewCard({
  preview,
  onOpenThreadFile,
}: {
  preview: PlanPreviewView
  onOpenThreadFile?: OpenThreadFile
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const feedbackStateRef = useRef<CopyFeedbackState>({ resetTimeoutId: null })
  const canOpenFile = Boolean(preview.planFilePath && onOpenThreadFile)

  useEffect(() => () => {
    if (feedbackStateRef.current.resetTimeoutId !== null) {
      window.clearTimeout(feedbackStateRef.current.resetTimeoutId)
      feedbackStateRef.current.resetTimeoutId = null
    }
  }, [])

  const handleCopy = async () => {
    try {
      await writeClipboardText(getAssistantCopyText(preview.markdown))
      showTemporaryCopiedFeedback(feedbackStateRef.current, {
        setCopied,
        setTimer: window.setTimeout,
        clearTimer: window.clearTimeout,
      })
    } catch (error) {
      console.error('[PlanPreviewCard] 复制计划失败:', error)
    }
  }

  return (
    <article
      data-plan-preview-card="true"
      data-state={expanded ? 'expanded' : 'collapsed'}
      className="w-full max-w-[920px] overflow-hidden rounded-[18px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-5 py-5 shadow-[0_18px_50px_-36px_hsl(var(--lume-shadow-panel)/0.62)]"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-5 text-[var(--lume-text-primary)]">计划</div>
          <h3 className="mt-6 text-[28px] font-semibold leading-[1.18] tracking-normal text-[var(--lume-text-primary)]">
            {preview.title}
          </h3>
          {preview.summary && (
            <p className="mt-3 text-[15px] leading-7 text-[var(--lume-text-secondary)]">{preview.summary}</p>
          )}
          {preview.planFilePath && (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--lume-text-muted)]">
              <FileText size={13} className="shrink-0" />
              <span className="truncate font-mono">{preview.planFilePath}</span>
              {preview.planVerified ? <span className="shrink-0 text-[var(--lume-success)]">已验证</span> : null}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[var(--lume-text-muted)]">
          <Button
                variant="ghost"
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
            title={copied ? '已复制' : '复制 Markdown'}
            aria-label="复制计划"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            <span>复制计划</span>
          </Button>
          {preview.planFilePath && (
            <Button
                variant="ghost"
              type="button"
              onClick={() => {
                if (preview.planFilePath) onOpenThreadFile?.(preview.planFilePath)
              }}
              disabled={!canOpenFile}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              title={preview.planFilePath}
            >
              <FileText size={15} />
              <span>打开计划文件</span>
            </Button>
          )}
          <Button
                variant="ghost"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
            aria-label={expanded ? '收起计划' : '展开计划'}
          >
            <ChevronDown size={16} className={cn('transition-transform', expanded && 'rotate-180')} />
            <span>{expanded ? '收起计划' : '展开计划'}</span>
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="relative mt-6">
          <PlanPreviewMarkdown markdown={preview.markdown} onOpenThreadFile={onOpenThreadFile} />
        </div>
      )}
    </article>
  )
}

const PlanPreviewMarkdown = memo(function PlanPreviewMarkdown({
  markdown,
  onOpenThreadFile,
}: {
  markdown: string
  onOpenThreadFile?: OpenThreadFile
}) {
  const isDark = useIsDark()
  const components = useMemo(() => ({
    pre: (props: MarkdownPreProps) => <MarkdownPre {...props} />,
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
    a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} onOpenThreadFile={onOpenThreadFile} />,
  }), [onOpenThreadFile])

  return (
    <XMarkdown
      className="agent-message-markdown x-markdown text-[15px] leading-7 text-[var(--lume-text-primary)]"
      rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      components={components}
    >
      {markdown}
    </XMarkdown>
  )
})

type MarkdownCodeProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode
  class?: string
  block?: boolean
  lang?: string
  domNode?: unknown
  streamStatus?: unknown
}

type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode
}

type MarkdownPreProps = HTMLAttributes<HTMLPreElement> & {
  children?: ReactNode
  domNode?: unknown
  streamStatus?: unknown
}

async function copyMermaidToClipboard(code: string): Promise<void> {
  try {
    await writeClipboardText(code)
  } catch (error) {
    console.error('[MarkdownPre] 复制 Mermaid 源码失败:', error)
    toast.error('复制失败')
    throw error
  }
}

async function copyMermaidImageToClipboard(svg: string): Promise<void> {
  try {
    await writeClipboardImage({ dataUrl: await mermaidSvgToPngDataUrl(svg) })
  } catch (error) {
    console.error('[MarkdownPre] 复制 Mermaid 图片失败:', error)
    toast.error('复制图片失败')
    throw error
  }
}

export function MarkdownPre({
  children,
  domNode,
  streamStatus,
  ...rest
}: MarkdownPreProps) {
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null)
  const [mermaidOriginalSize, setMermaidOriginalSize] = useState(false)
  const mermaidCode = getMermaidCodeFromPreNode(domNode)
  if (mermaidCode !== null) {
    if (streamStatus === 'loading' || isMermaidPreStreaming(domNode)) {
      return <pre {...rest}>{children}</pre>
    }
    const closeMermaidPreview = () => {
      setMermaidPreviewSvg(null)
      setMermaidOriginalSize(false)
    }
    const mermaidPreviewSrc = mermaidPreviewSvg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mermaidPreviewSvg)}`
      : undefined

    return (
      <>
        <MermaidBlock
          code={mermaidCode}
          onCopy={copyMermaidToClipboard}
          onCopyImage={copyMermaidImageToClipboard}
          onPreview={setMermaidPreviewSvg}
        />
        <Dialog open={Boolean(mermaidPreviewSvg)} onOpenChange={(open) => { if (!open) closeMermaidPreview() }}>
          <DialogContent
            showCloseButton={false}
            className="inset-0 left-0 top-0 z-[151] block h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-auto rounded-none bg-black/92 p-4 ring-0 sm:max-w-none"
            onClick={closeMermaidPreview}
          >
            <DialogTitle className="sr-only">预览 Mermaid 图表</DialogTitle>
            <div className="fixed right-4 top-4 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
                onClick={() => setMermaidOriginalSize((value) => !value)}
              >
                {mermaidOriginalSize ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                {mermaidOriginalSize ? '适应窗口' : '原始尺寸'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
                onClick={closeMermaidPreview}
                aria-label="关闭 Mermaid 预览"
              >
                <X size={18} />
              </Button>
            </div>
            {mermaidPreviewSrc && (
              <div className={mermaidOriginalSize ? 'min-h-full min-w-full' : 'flex h-full w-full items-center justify-center'}>
                <img
                  src={mermaidPreviewSrc}
                  alt="Mermaid 图表"
                  className={mermaidOriginalSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={() => setMermaidOriginalSize((value) => !value)}
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const infographicCode = getInfographicCodeFromPreNode(domNode)
  if (infographicCode !== null) {
    return (
      <InfographicBlock
        code={infographicCode}
        streaming={streamStatus === 'loading' || isInfographicPreStreaming(domNode)}
      />
    )
  }

  return <DiffAwareMarkdownPre streamStatus={streamStatus}>{children}</DiffAwareMarkdownPre>
}

export function MarkdownCode({
  children,
  block,
  lang: _lang,
  domNode: _domNode,
  streamStatus: _streamStatus,
  onOpenThreadFile,
  ...rest
}: MarkdownCodeProps & { onOpenThreadFile?: OpenThreadFile }) {
  const binding = useMessageFileReferenceBinding()
  const protocolVersion = useMessageFileReferenceProtocolVersion()
  const text = flattenText(children)
  const reference = !block ? parseMessageThreadFileReference(text, {
    bindingPresent: Boolean(binding),
    protocolVersion,
  }) : null

  if (reference && onOpenThreadFile) {
    return <AgentFileReference reference={reference} binding={binding} onOpen={onOpenThreadFile} />
  }

  const codeProps = normalizeMarkdownCodeProps(rest as Record<string, unknown>) as HTMLAttributes<HTMLElement>
  return <code {...codeProps}>{children}</code>
}

export function MarkdownAnchor({
  href,
  children,
  onOpenThreadFile,
  ...rest
}: MarkdownAnchorProps & { onOpenThreadFile?: OpenThreadFile }) {
  const binding = useMessageFileReferenceBinding()
  const protocolVersion = useMessageFileReferenceProtocolVersion()
  const reference = typeof href === 'string' && (href.startsWith('@project/') || href.startsWith('@session/'))
    ? parseMessageThreadFileReference(href, { bindingPresent: Boolean(binding), protocolVersion, markdownHref: true })
    : null
  if (reference && onOpenThreadFile) {
    return <AgentFileReference reference={reference} binding={binding} onOpen={onOpenThreadFile} />
  }
  return <a {...rest} href={href}>{children}</a>
}

export function normalizeMarkdownCodeProps(props: Record<string, unknown>): Record<string, unknown> {
  const {
    class: rawClassName,
    className,
    ...rest
  } = props
  const normalizedClassName = cn(
    typeof rawClassName === 'string' ? rawClassName : undefined,
    typeof className === 'string' ? className : undefined,
  )
  return {
    ...rest,
    ...(normalizedClassName ? { className: normalizedClassName } : {}),
  }
}

function flattenText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(flattenText).join('')
  return ''
}

function IncompleteLink() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted/30 px-2 py-0.5 text-[13px] text-muted-foreground/50 animate-pulse">
      <span className="inline-block h-3 w-16 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteImage() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-muted/30 px-2 py-1 text-[12px] text-muted-foreground/40 animate-pulse">
      <span className="inline-block size-4 rounded bg-muted/50" />
      <span className="inline-block h-3 w-12 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteTable() {
  return (
    <div className="my-1 overflow-hidden rounded border border-border/20 animate-pulse">
      <div className="flex gap-px bg-muted/20">
        <span className="h-4 flex-1 bg-muted/30" />
        <span className="h-4 flex-1 bg-muted/30" />
        <span className="h-4 flex-1 bg-muted/30" />
      </div>
      <div className="flex gap-px bg-muted/10">
        <span className="h-4 flex-1 bg-muted/20" />
        <span className="h-4 flex-1 bg-muted/20" />
        <span className="h-4 flex-1 bg-muted/20" />
      </div>
    </div>
  )
}

const RuntimeEventToolCallBlock = memo(function RuntimeEventToolCallBlock({
  toolCall,
  threadId,
  onUserResizeStart,
}: {
  toolCall: RuntimeToolCallView
  threadId: string
  onUserResizeStart?: () => void
}) {
  const [collapsed, setCollapsed] = useState(true)
  const isRunning = toolCall.status === 'running'
  const input = asRecord(toolCall.input)

  if (toolCall.toolName === 'Agent') {
    return (
      <SubagentInlinePanel
        threadId={threadId}
        toolUseId={toolCall.id}
        runId={toolCall.subagentRunId}
        status={toolCall.subagentStatus}
        description={asString(input.description ?? input.prompt)}
        agentType={asString(input.subagent_type)}
        prompt={asString(input.prompt)}
        onUserResizeStart={onUserResizeStart}
      />
    )
  }

  const isBash = toolCall.toolName === 'Bash'
  const Icon = isBash ? Terminal : Wrench
  const resultOpen = !isRunning && !collapsed
  const shouldRenderResult = useDeferredUnmount(resultOpen)
  let resultData: unknown
  if (shouldRenderResult) {
    resultData = toolCall.output
    if (typeof toolCall.output === 'string') {
      try {
        resultData = JSON.parse(toolCall.output)
      } catch {
        resultData = toolCall.output
      }
    }
  }

  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_1px_2px_hsl(var(--lume-shadow-panel)/0.08)]">
      <Button
                variant="ghost"
        type="button"
        onClick={() => {
          if (!isRunning) {
            onUserResizeStart?.()
          }
          setCollapsed((value) => !value)
        }}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-[13px] text-[var(--lume-text-secondary)] transition-colors hover:bg-[var(--lume-accent-soft)]"
      >
        <Icon size={15} className="shrink-0 text-[var(--lume-text-muted)]" />
        <span className="font-mono font-semibold text-[var(--lume-text-primary)]">{toolCall.toolName}</span>
        {toolCall.riskLevel && (
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', riskLevelClassName(toolCall.riskLevel))}>
            {riskLevelLabel(toolCall.riskLevel)}
          </span>
        )}
        {getToolPermissionTitleBadgeText(toolCall) && (
          <span className="rounded-full bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-2 py-0.5 text-[12px] font-semibold text-[var(--lume-warning)]">
            {getToolPermissionTitleBadgeText(toolCall)}
          </span>
        )}
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[12px] font-semibold',
          toolCall.status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]',
        )}>
          {isRunning ? '执行中' : toolCall.status === 'failed' ? '失败' : '已完成'}
        </span>
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="tabular-nums text-[11px] font-medium text-[var(--lume-text-muted)]">
            {formatDurationLabel(toolCall.durationMs)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--lume-text-muted)]">{summarizeInput(input)}</span>
        {isRunning && <Loader2 size={13} className="shrink-0 animate-spin text-[var(--lume-accent)]" />}
        {!isRunning && (
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-[var(--lume-text-muted)] transition-transform', !collapsed && 'rotate-180')}
          />
        )}
      </Button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain border-t border-[var(--lume-border-subtle)] p-3">
            <ToolExecutionDetails toolCall={toolCall} />
            <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
})

export function getToolPermissionTitleBadgeText(toolCall: RuntimeToolCallView): string | null {
  if (toolCall.permissionState === 'timeout') return '权限超时'
  return null
}

function riskLevelLabel(level: NonNullable<RuntimeToolCallView['riskLevel']>): string {
  return level === 'high' ? '高风险' : level === 'medium' ? '中风险' : '低风险'
}

function riskLevelClassName(level: NonNullable<RuntimeToolCallView['riskLevel']>): string {
  return level === 'high'
    ? 'text-destructive'
    : level === 'medium'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-emerald-700 dark:text-emerald-300'
}
function FooterMemoryNotice({
  events,
  onOpenMemorySource,
}: {
  events: MemoryContextUsedViewEvent[]
  onOpenMemorySource?: (path: string, fileRef?: FileRef) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const totalCount = events.reduce((sum, e) => sum + e.items.length, 0)
  const groups = groupMemoryCitationItems(events.flatMap(e => e.items))
  return (
    <div className="relative">
      <Button
                variant="ghost"
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 text-[var(--lume-text-muted)] transition-colors hover:text-[var(--lume-accent)]"
      >
        <Database size={13} strokeWidth={1.8} />
        <span>引用了 {totalCount} 条记忆</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </Button>
      {expanded && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-[220px] max-w-[360px] overflow-y-auto rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)]">
          <div className="space-y-2 text-[11px] leading-5 text-[var(--lume-text-muted)]">
            {groups.map(group => (
              <div key={group.key}>
                <div className="mb-0.5 text-[var(--lume-text-muted)]">{group.label}</div>
                <ol className="space-y-1">
                  {group.items.map((item, index) => {
                    const sourcePath = normalizeMemoryCitationPath(item.citation)
                    const label = compactMemoryCitationLabel(item.citation)
                    const content = (
                      <>
                        <span className="shrink-0 tabular-nums">{index + 1}.</span>
                        <span className="truncate">{label}</span>
                      </>
                    )
                    if (!sourcePath || !onOpenMemorySource) {
                      return (
                        <li key={item.id} className="flex items-center gap-1.5 font-mono text-[var(--lume-text-secondary)]" title={item.citation}>
                          {content}
                        </li>
                      )
                    }
                    return (
                      <li key={item.id}>
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => onOpenMemorySource(sourcePath, item.fileRef)}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[var(--lume-text-secondary)] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)]"
                          title={item.citation}
                        >
                          {content}
                        </Button>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FooterSourceNotice({
  sources,
  truncated,
}: {
  sources: AssistantSourceReference[]
  truncated: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="relative shrink-0">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="assistant-footer-action inline-flex items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[var(--lume-accent)]"
      >
        <Globe size={13} strokeWidth={1.8} />
        <span>来源 · {sources.length}{truncated ? '+' : ''}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </Button>
      {expanded && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-[260px] max-w-[380px] overflow-y-auto rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)]">
          <div className="space-y-1 text-[11px] leading-5">
            {sources.map((source, index) => {
              const content = (
                <>
                  <span className="shrink-0 tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 truncate">{source.title}</span>
                  <span className="shrink-0 truncate text-[var(--lume-text-muted)]">{source.domain}</span>
                </>
              )
              if (!source.clickable) {
                return (
                  <div key={`${source.url}:${index}`} className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[var(--lume-text-secondary)]" title={source.url}>
                    {content}
                  </div>
                )
              }
              return (
                <Button
                  key={`${source.url}:${index}`}
                  variant="ghost"
                  type="button"
                  onClick={() => { void openExternal(source.url) }}
                  className="flex w-full min-w-0 items-center justify-start gap-1.5 rounded-md px-1 py-0.5 text-left font-mono text-[var(--lume-text-secondary)] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)]"
                  title={source.url}
                >
                  {content}
                  <ExternalLink size={11} className="ml-auto shrink-0" />
                </Button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function AssistantMessageFooter({
  threadId,
  messageId,
  text,
  isStreaming,
  tokenCount,
  tokenCountSource,
  tokenUsage,
  completedAt,
  memoryEvents,
  sources,
  sourcesTruncated,
  onOpenMemorySource,
}: {
  threadId: string
  messageId?: string
  text: string
  isStreaming: boolean
  tokenCount?: number
  tokenCountSource?: 'provider'
  tokenUsage?: RuntimeAssistantTokenUsageView
  completedAt?: string
  memoryEvents?: MemoryContextUsedViewEvent[]
  sources: AssistantSourceReference[]
  sourcesTruncated: boolean
  onOpenMemorySource?: (path: string, fileRef?: FileRef) => void
}) {
  const setThreads = useSetAtom(agentThreadsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [forking, setForking] = useState(false)
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false)
  const downloadMenuRef = useRef<HTMLDivElement>(null)
  const downloadTriggerRef = useRef<HTMLButtonElement>(null)
  const copyText = getAssistantCopyText(text)
  const canCopy = copyText.trim().length > 0 && !isStreaming
  const canFork = Boolean(messageId) && !isStreaming
  const canDownload = text.trim().length > 0 && !isStreaming
  const footerTokenUsage = getFooterTokenUsage(tokenUsage, tokenCount, tokenCountSource)
  const showTokens = footerTokenUsage !== null
  const completedTimeLabel = formatAssistantCompletionTime(completedAt)

  useEffect(() => {
    if (!downloadMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (downloadMenuRef.current?.contains(target) || downloadTriggerRef.current?.contains(target))) return
      setDownloadMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [downloadMenuOpen])

  const hasMemory = memoryEvents && memoryEvents.length > 0
  const hasSources = sources.length > 0

  if (!canCopy && !canFork && !canDownload && !showTokens && !completedTimeLabel && !hasMemory && !hasSources) return null

  const handleFork = async () => {
    if (!messageId || forking) return
    setForking(true)
    try {
      const result = await sidecarCall<{ newThreadId: string }>(AGENT_IPC_CHANNELS.FORK_THREAD, {
        threadId,
        upToMessageId: messageId,
      })
      const threads = await sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_THREADS)
      const nextThreads = Array.isArray(threads) ? threads : []
      const forkedThread = nextThreads.find((thread) => thread.id === result.newThreadId)

      setThreads(nextThreads)
      setTabs((prev) => (
        prev.some((tab) => tab.id === result.newThreadId)
          ? prev
          : [
              ...prev,
              {
                id: result.newThreadId,
                type: 'agent' as const,
                title: forkedThread?.title ?? '分叉线程',
                threadId: result.newThreadId,
                workspaceId: forkedThread?.workspaceId,
              },
            ]
      ))
      setActiveTabId(result.newThreadId)
      toast.success('已创建分支会话')
    } catch (error) {
      console.error('[RuntimeEventContentBlock] 创建分支会话失败:', error)
      toast.error('创建分支失败')
    } finally {
      setForking(false)
    }
  }

  const handleDownload = async (format: AssistantDownloadFormat) => {
    setDownloadMenuOpen(false)
    try {
      const savedPath = await downloadAssistantMessage(text, messageId, format)
      if (savedPath) {
        toast.success('已保存', {
          description: savedPath,
          duration: 6000,
          action: {
            label: '打开',
            onClick: () => { openInSystem(savedPath).catch(() => {}) },
          },
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('取消')) {
        toast.error('保存失败', { description: message })
      }
    }
  }

  return (
    <div className="assistant-message-footer pointer-events-none flex min-h-6 w-full -translate-y-1 items-center justify-between gap-3 pt-2 text-[var(--lume-text-muted)] opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/agent-message:pointer-events-auto group-hover/agent-message:translate-y-0 group-hover/agent-message:opacity-100 group-focus-within/agent-message:pointer-events-auto group-focus-within/agent-message:translate-y-0 group-focus-within/agent-message:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none">
      <div className="assistant-footer-actions flex min-w-0 items-center gap-4">
        {canCopy && (
          <CopyMessageButton
            text={copyText}
            label="复制"
            copiedLabel="已复制"
            className="assistant-footer-action inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[var(--lume-accent)] data-[state=copied]:text-[var(--lume-success)]"
            iconSize={15}
            strokeWidth={1.8}
          />
        )}
        {canFork && (
          <Button
                variant="ghost"
            type="button"
            disabled={forking}
            onClick={() => void handleFork()}
            className="assistant-footer-action inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[var(--lume-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title="创建分支"
            aria-label="创建分支"
          >
            {forking
              ? <Loader2 size={15} className="animate-spin" strokeWidth={1.8} />
              : <GitFork size={15} strokeWidth={1.8} />}
            <span>创建分支</span>
          </Button>
        )}
        {canDownload && (
          <div className="relative shrink-0" ref={downloadMenuRef}>
            <Button
                variant="ghost"
              ref={downloadTriggerRef}
              type="button"
              onClick={() => setDownloadMenuOpen((current) => !current)}
              className="assistant-footer-action inline-flex items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[var(--lume-accent)]"
              title="下载"
              aria-label="下载"
              aria-haspopup="menu"
              aria-expanded={downloadMenuOpen}
            >
              <Download size={15} strokeWidth={1.8} />
              <span>下载</span>
            </Button>
            <div
              role="menu"
              aria-label="选择下载格式"
              hidden={!downloadMenuOpen}
              className="absolute left-0 top-full z-30 mt-1 min-w-[112px] rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)]"
            >
              <DownloadFormatMenuItem onClick={() => handleDownload('html')}>下载 HTML</DownloadFormatMenuItem>
              <DownloadFormatMenuItem onClick={() => handleDownload('txt')}>下载 TXT</DownloadFormatMenuItem>
            </div>
          </div>
        )}
        {completedTimeLabel && (
          <span className="assistant-footer-completed-at inline-flex shrink-0 items-center rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 text-[var(--lume-text-muted)]">
            {completedTimeLabel}
          </span>
        )}
        {hasMemory && (
          <FooterMemoryNotice
            events={memoryEvents!}
            onOpenMemorySource={onOpenMemorySource}
          />
        )}
        {hasSources && <FooterSourceNotice sources={sources} truncated={sourcesTruncated} />}
      </div>
      {showTokens && (
        <AssistantTokenUsageMetrics usage={footerTokenUsage} />
      )}
    </div>
  )
}

function DownloadFormatMenuItem({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-start rounded-md px-2 py-1.5 text-left text-[12px] font-medium leading-5 text-[var(--lume-text-secondary)] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-accent)]"
    >
      {children}
    </Button>
  )
}

function AssistantTokenUsageMetrics({ usage }: { usage: FooterTokenUsage }) {
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-3 text-[12px] font-medium leading-5 text-[var(--lume-text-muted)] tabular-nums"
      title={usage.title}
      aria-label={usage.title}
    >
      {usage.inputTokens !== undefined && (
        <span className="assistant-footer-metric-input inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↑</span>
          <span>{usage.inputTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.outputTokens !== undefined && (
        <span className="assistant-footer-metric-output inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↓</span>
          <span>{usage.outputTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.cachedTokens !== undefined && (
        <span className="assistant-footer-metric-cached inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↺</span>
          <span>{usage.cachedTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.contextPercent !== undefined && (
        <span className="assistant-footer-metric-context inline-flex items-center gap-1 whitespace-nowrap" title={`上下文占用 ${usage.contextPercent}%`}>
          <Gauge size={14} strokeWidth={1.8} />
          <span>{usage.contextPercent}%</span>
        </span>
      )}
    </div>
  )
}

interface FooterTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  contextPercent?: number
  title: string
}

function getFooterTokenUsage(
  usage: RuntimeAssistantTokenUsageView | undefined,
  tokenCount: number | undefined,
  tokenCountSource: 'provider' | undefined,
): FooterTokenUsage | null {
  const inputTokens = positiveInteger(usage?.inputTokens)
  const outputTokens = positiveInteger(usage?.outputTokens ?? tokenCount)
  const cachedTokens = positiveInteger(usage?.cachedTokens ?? usage?.cacheReadInputTokens)
  const contextPercent = percentInteger(usage?.contextPercent)
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined && contextPercent === undefined) return null

  const titleParts: string[] = []
  if (inputTokens !== undefined) titleParts.push(`输入 ${inputTokens.toLocaleString()} tokens`)
  if (outputTokens !== undefined) {
    titleParts.push(`${tokenCountSource === 'provider' ? '输出' : '估算输出'} ${outputTokens.toLocaleString()} tokens`)
  }
  if (cachedTokens !== undefined) titleParts.push(`缓存 ${cachedTokens.toLocaleString()} tokens`)
  if (positiveInteger(usage?.cacheReadInputTokens) !== undefined) titleParts.push(`缓存命中 ${positiveInteger(usage?.cacheReadInputTokens)?.toLocaleString()} tokens`)
  if (positiveInteger(usage?.cacheCreationInputTokens) !== undefined) titleParts.push(`缓存写入 ${positiveInteger(usage?.cacheCreationInputTokens)?.toLocaleString()} tokens`)
  if (contextPercent !== undefined) titleParts.push(`上下文 ${contextPercent}%`)

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
    title: titleParts.join(' · '),
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function percentInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, Math.round(value)))
}

type AssistantDownloadFormat = 'html' | 'txt'

export function getAssistantDownloadPayload(text: string, format: AssistantDownloadFormat): string {
  const cleanText = getAssistantCopyText(text)
  return format === 'html' ? buildAssistantMessageHtml(cleanText) : cleanText
}

async function downloadAssistantMessage(text: string, messageId: string | undefined, format: AssistantDownloadFormat): Promise<string | null> {
  const filenameBase = messageId ?? `assistant-${Date.now()}`
  const filename = `${filenameBase}.${format}`
  const payload = getAssistantDownloadPayload(text, format)
  try {
    const result = await saveTextFileDialog(filename, payload)
    return result.path
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('取消')) return null
    throw error
  }
}

function buildAssistantMessageHtml(text: string): string {
  const escapedText = escapeHtml(text)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lume Assistant Message</title>
  <style>
    body { margin: 0; padding: 32px; color: #303445; background: #ffffff; font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 860px; margin: 0 auto; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  </style>
</head>
<body>
  <main>
    <pre>${escapedText}</pre>
  </main>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatAssistantCompletionTime(completedAt?: string): string | null {
  if (!completedAt) return null
  const date = new Date(completedAt)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

function CopyMessageButton({
  text,
  className,
  iconSize,
  strokeWidth,
  label,
  copiedLabel,
}: {
  text: string
  className: string
  iconSize: number
  strokeWidth?: number
  label?: string
  copiedLabel?: string
}) {
  const [copied, setCopied] = useState(false)
  const feedbackStateRef = useRef<CopyFeedbackState>({ resetTimeoutId: null })
  const displayLabel = copied ? (copiedLabel ?? label) : label

  useEffect(() => () => {
    if (feedbackStateRef.current.resetTimeoutId !== null) {
      window.clearTimeout(feedbackStateRef.current.resetTimeoutId)
      feedbackStateRef.current.resetTimeoutId = null
    }
  }, [])

  const handleCopy = async () => {
    try {
      await writeClipboardText(text)
      showTemporaryCopiedFeedback(feedbackStateRef.current, {
        setCopied,
        setTimer: window.setTimeout,
        clearTimer: window.clearTimeout,
      })
    } catch (error) {
      console.error('[RuntimeEventContentBlock] 复制消息失败:', error)
    }
  }

  return (
    <Button
      variant="ghost"
      type="button"
      aria-label={copied ? '复制成功' : '复制消息'}
      data-state={copied ? 'copied' : 'idle'}
      onClick={() => void handleCopy()}
      className={cn('h-auto justify-start', className)}
      title={copied ? '已复制' : '复制'}
    >
      {copied
        ? <Check size={iconSize} strokeWidth={strokeWidth} />
        : <Copy size={iconSize} strokeWidth={strokeWidth} />}
      {displayLabel && <span>{displayLabel}</span>}
    </Button>
  )
}

function formatDurationLabel(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const totalSec = Math.floor(s)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  if (s < 3600) return `${mm}:${String(ss).padStart(2, '0')}`
  const hh = Math.floor(mm / 60)
  return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * 运行态总用时格式化：<60s 取整秒（design 7.3：运行态按整秒跳动），
 * ≥60s 复用 formatDurationLabel（mm:ss / h:mm:ss）。供 RunningDurationClock 使用。
 */
export function formatRunningDuration(ms: number): string {
  if (ms <= 0) return ''
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(0)}s`
  return formatDurationLabel(ms)
}

/**
 * 完成态时长格式化：<60s 保留 1 位小数，≥60s 复用 formatDurationLabel。
 */
export function formatCompletedDuration(ms: number): string {
  if (ms <= 0) return ''
  return formatDurationLabel(ms)
}

function summarizeInput(input: unknown): string {
  const record = asRecord(input)
  const value = record.command
    ?? record.file_path
    ?? record.path
    ?? record.query
    ?? record.planFilePath
    ?? record.summary
    ?? record.goal
    ?? record.description
    ?? record.prompt
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}...` : value
  if (value === undefined) return '正在执行工具调用'
  return JSON.stringify(value)
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function asString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input : undefined
}
