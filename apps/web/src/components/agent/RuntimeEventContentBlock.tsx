import { useAtomValue, useSetAtom } from 'jotai'
import { memo, useEffect, useMemo, useState, type ClipboardEvent } from 'react'
import { BookOpen, Check, ChevronDown, ChevronRight, Clock, Database, Edit3, History, ListChecks, ListCollapse, Loader2, MessageSquareText, Package, Quote, Sparkles, Terminal, TriangleAlert, Workflow, Wrench, X } from 'lucide-react'
import { parseQuotedSelectionRefs } from '@/lib/quoted-selection'
import { ToolResultRenderer } from './tool-result-renderers'
import { AgentLoadingIndicator } from './AgentLoadingIndicator'
import { cn } from '@/lib/utils'
import { formatDurationLabel } from '@/lib/format-duration'
import { activeTabIdAtom, capabilityDetailTargetAtom, generalSettingsAtom, memoryCenterDeepLinkAtom, tabsAtom } from '@/atoms'
import type { RuntimeAssistantBlock, RuntimeMessageView, RuntimeToolCallView, TaskProgressViewEvent } from './runtime-message-view'
import { groupAssistantBlocksForMinimal, groupAssistantBlocksForStandard } from './minimal-assistant-grouping'
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { agentSend, getThreadMessageVersions, revokeFilePreviewScope } from '@/lib/desktop-api'
import { MessageFileReferenceBindingProvider } from './thread-file-env'
import { getAgentRole, validatePlanningTodoRefPart, type AgentCapabilityReferenceView, type AgentMessage, type AgentMessageAttachmentInput, type AgentRoleDefinition, type AgentUserMessagePart, type FileRef } from '@lume/shared'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import { AGENT_ROLE_ASSETS } from '@/components/settings/agents-settings-state'
import { toast } from 'sonner'
import { AgentAttachmentGrid, isImageAttachment } from './AgentAttachmentGrid'
import { createThreadImagePreviewScope } from './thread-image-preview'
import {
  buildExpressionActionSendInput,
  deriveExpressionActions,
  type ExpressionAction,
  type ExpressionActionId,
} from './expression-actions'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { OpenThreadFile } from './AgentFileReference'
import { CodingTurnFileChangesSummary } from './CodingTurnFileChangesSummary'
import { MEMORY_CENTER_TAB_ID, memoryCenterTarget, upsertMemoryCenterTab } from '@/components/memory/open-memory-center'
import { remapAgentMessagePartsForEditedText } from './agent-editor-message-parts'
import { CopyFeedbackState, getAssistantCopyText, getCopyTextWithoutAfterglow, showTemporaryCopiedFeedback } from './message-blocks/copy-text'
import { compactMemoryCitationLabel, groupMemoryCitationItems, normalizeMemoryCitationPath } from './message-blocks/memory-citation'
import { PlanPreviewCard, SmoothText } from './message-blocks/markdown'
import { collectAssistantSources } from './source-references'
import { AssistantMessageFooter, CopyMessageButton, formatMessageTime } from './message-blocks/assistant-footer'
import { MinimalProcessGroup, ToolExecutionDetails, riskLevelClassName, riskLevelLabel } from './message-blocks/minimal-process'
import { asRecord, asString, memoryMutationError, memoryMutationLabel, parseToolCallOutput, summarizeInput } from './message-blocks/tool-summary'

export type { CopyFeedbackState }
export { getAssistantCopyText, getCopyTextWithoutAfterglow, showTemporaryCopiedFeedback }
export { compactMemoryCitationLabel, groupMemoryCitationItems, normalizeMemoryCitationPath }
export { MarkdownAnchor, MarkdownCode, MarkdownPre, PlanPreviewCard, activateThreadBrowserUrl, isSafeExternalHref, normalizeMarkdownCodeProps } from './message-blocks/markdown'
export { getAssistantDownloadPayload } from './message-blocks/assistant-footer'

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
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setMemoryCenterDeepLink = useSetAtom(memoryCenterDeepLinkAtom)
  const openMemoryCenter = (target?: Extract<RuntimeMessageView, { type: 'system'; variant: 'memory_saved' | 'memory_job' }>['target']) => {
    setTabs(upsertMemoryCenterTab)
    setMemoryCenterDeepLink(memoryCenterTarget(target))
    setActiveTabId(MEMORY_CENTER_TAB_ID)
  }

  if (message.type === 'user') {
    return (
      <UserMessageBlock
        message={message}
        threadId={threadId}
        className={cls}
        leftAligned={useLeftAlignedMessageList}
        showAvatar={showMessageAvatar && showAssistantAvatar}
        canEdit={canEditUserMessage}
        onOpenThreadFile={onOpenThreadFile}
        onOpenThreadImage={onOpenThreadImage}
      />
    )
  }

  if (message.type === 'system') {
    return <SystemMessageBlock message={message} className={cls} onOpenMemoryCenter={openMemoryCenter} />
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
    streaming === true && message.status === 'streaming' && !latestTaskProgressBlock && !message.retry,
    activitySignature,
  )
  const expressionActions = useMemo(
    () => showExpressionActions
      ? deriveExpressionActions(message.text, message.status === 'streaming')
      : [],
    [message.status, message.text, showExpressionActions],
  )
  const showAssistantHeader = showAssistantAvatar && showMessageAvatar

  return (
    <MessageFileReferenceBindingProvider value={message.fileReferenceBinding} consumerThreadId={threadId} protocolVersion={message.fileReferenceProtocolVersion}>
    <div className={cn('group/agent-message flex w-full max-w-[920px] min-w-0 flex-col gap-0.5', cls)}>
      {showAssistantHeader && (
        <div className="mb-2.5 flex items-start gap-2.5">
          <div
            data-agent-message-avatar="true"
            className="flex size-[35px] shrink-0 items-center justify-center rounded-[25%] border border-[color:color-mix(in_oklab,var(--lume-accent)_24%,var(--lume-border-subtle))] bg-[var(--lume-bg-elevated)] text-[var(--lume-accent)]"
          >
            <Sparkles size={19} strokeWidth={1.8} fill="currentColor" fillOpacity={0.1} />
          </div>
          <div className="flex h-[35px] flex-col justify-between">
            <span className="text-[13px] font-semibold leading-none text-[var(--lume-text-secondary)]">Lume</span>
            {formatMessageTime(message.completedAt) && (
              <span className="text-[10px] leading-none text-[var(--lume-text-muted)]">
                {formatMessageTime(message.completedAt)}
              </span>
            )}
          </div>
        </div>
      )}
      <div className={cn('min-w-0 flex-1 space-y-3', showAssistantHeader && 'pl-[46px]')}>
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
        {latestTaskProgressBlock && (
          <TaskProgressStatusLine event={latestTaskProgressBlock.event} />
        )}
        {message.retry && (
          <ShimmerStatusLine text={`正在重新连接 ${message.retry.attempt}/${message.retry.maxRetries}`} />
        )}
        {showIdleStatus && <ShimmerStatusLine text="正在思考" />}
        {message.error && (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive/80">
            {message.error}
          </p>
        )}
        {message.status !== 'streaming' && message.codingReport && (
          <CodingTurnFileChangesSummary report={message.codingReport} assistantMessageId={message.messageId} threadId={threadId} onOpenThreadFile={onOpenThreadFile} />
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
          completedAt={showAssistantHeader ? undefined : message.completedAt}
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

function ExpressionActionBar({
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
  onOpenMemoryCenter,
}: {
  message: Extract<RuntimeMessageView, { type: 'system' }>
  className?: string
  onOpenMemoryCenter: (target: Extract<RuntimeMessageView, { type: 'system'; variant: 'memory_saved' | 'memory_job' }>['target']) => void
}) {
  if (message.variant === 'context_compaction') {
    return <ContextCompactionDivider message={message} className={className} />
  }
  if (message.variant === 'memory_saved') {
    return <MemorySystemNotice message={message} className={className} onOpenMemoryCenter={onOpenMemoryCenter} />
  }
  if (message.variant === 'memory_job') {
    return <MemorySystemNotice message={message} className={className} onOpenMemoryCenter={onOpenMemoryCenter} />
  }
  return null
}

function MemorySystemNotice({
  message,
  className,
  onOpenMemoryCenter,
}: {
  message: Extract<RuntimeMessageView, { type: 'system'; variant: 'memory_saved' | 'memory_job' }>
  className?: string
  onOpenMemoryCenter: (target: Extract<RuntimeMessageView, { type: 'system'; variant: 'memory_saved' | 'memory_job' }>['target']) => void
}) {
  return (
    <div className={cn('mx-6 flex min-h-5 items-center gap-1.5 text-[12px] leading-5 text-[var(--lume-text-muted)]', className)}>
      {message.variant === 'memory_job' && message.status === 'active'
        ? <Loader2 size={13} className="shrink-0 animate-spin" />
        : <Database size={13} className="shrink-0" />}
      <span>{message.text}</span>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-[12px] text-[var(--lume-text-muted)]"
        onClick={() => onOpenMemoryCenter(message.target)}
      >
        打开
      </Button>
    </div>
  )
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
      const messageParts = remapAgentMessagePartsForEditedText(message.messageParts, nextText)
      await agentSend({
        threadId,
        userMessage: nextText,
        editFromMessageId: message.messageId,
        ...(messageParts ? { messageParts } : {}),
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
      'group/user-message flex w-full max-w-[920px]',
      leftAligned ? 'flex-col gap-0.5' : 'ml-auto flex-row justify-end gap-2',
      className,
    )}>
      {leftAligned && showAvatar && (
        <div className="mb-2.5 flex items-start gap-2.5">
          <div className="flex size-[35px] shrink-0 items-center justify-center rounded-full bg-[var(--lume-accent)] text-[14px] font-semibold text-[var(--lume-accent-foreground)]">
            L
          </div>
          <div className="flex h-[35px] flex-col justify-between">
            <span className="text-[13px] font-semibold leading-none text-[var(--lume-text-secondary)]">你</span>
            {formatMessageTime(message.createdAt) && (
              <span className="text-[10px] leading-none text-[var(--lume-text-muted)]">
                {formatMessageTime(message.createdAt)}
              </span>
            )}
          </div>
        </div>
      )}
      <div className={cn(
        'relative flex min-w-0 flex-col',
        leftAligned
          ? cn('max-w-[806px] items-start', showAvatar && 'pl-[46px]')
          : 'max-w-[560px] items-end',
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
                <span className="truncate">
                  {comment.intent === 'modify' ? '修改请求 · ' : comment.intent === 'context' ? '代码上下文 · ' : ''}
                  {comment.position.path}:L{comment.position.startLine ?? comment.position.line}{(comment.position.startLine ?? comment.position.line) !== comment.position.line ? `–L${comment.position.line}` : ''} · {comment.body}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className={cn(
          'text-chat font-medium leading-[1.5] text-[var(--lume-text-primary)]',
          leftAligned
            ? 'rounded-[10px] bg-[var(--lume-accent-soft)] px-3.5 py-2.5'
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
        <div className={cn(
          'pointer-events-none mt-0.5 flex h-6 items-center gap-0.5 whitespace-nowrap text-[var(--lume-text-muted)] opacity-0 transition-opacity duration-150 ease-out group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100 group-focus-within/user-message:pointer-events-auto group-focus-within/user-message:opacity-100 motion-reduce:transition-none',
          leftAligned ? 'self-start' : 'self-end',
        )}>
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
      {!leftAligned && showAvatar && (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--lume-accent)] text-[15px] font-semibold text-[var(--lume-accent-foreground)] shadow-[0_12px_24px_-18px_hsl(var(--lume-shadow-panel)/0.72)]">
          L
        </div>
      )}
    </div>
  )
}

interface AgentRoleInstructionMessage {
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
  const { quotes, text: cleanText } = parseQuotedSelectionRefs(text)
  const cleanMessageParts = stripQuotedSelectionRefsFromMessageParts(messageParts)
  const quoteMarks = quotes.length > 0 ? (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {quotes.map((quote, index) => (
        <span key={`${quote.label ?? quote.filename}-${index}`} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_20%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-2.5 py-1 text-[12px] text-[var(--text-2)]">
          <Quote className="size-3.5 shrink-0 text-[var(--text-3)]" />
          <span className="min-w-0 truncate">{quote.label ?? quote.filename}</span>
        </span>
      ))}
    </div>
  ) : null

  if (messageParts?.some((part) => part.type === 'capability_ref')) {
    return (
      <div className="min-w-0">
        {quoteMarks}
        <CapabilityMessageText text={cleanText} messageParts={cleanMessageParts} capabilityReferences={capabilityReferences} />
      </div>
    )
  }
  const invocation = parseAgentRoleInstructionMessage(cleanText)

  if (!invocation) {
    return (
      <div className="min-w-0">
        {quoteMarks}
        <CapabilityMessageText text={cleanText} />
      </div>
    )
  }

  return (
    <div data-agent-role-message={invocation.role.id} className="min-w-0 space-y-2">
      {quoteMarks}
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

function stripQuotedSelectionRefsFromMessageParts(
  messageParts: AgentUserMessagePart[] | undefined,
): AgentUserMessagePart[] | undefined {
  const first = messageParts?.[0]
  if (!first || first.type !== 'text') return messageParts
  const parsed = parseQuotedSelectionRefs(first.text)
  if (parsed.quotes.length === 0) return messageParts
  const rest = messageParts.slice(1)
  return parsed.text ? [{ ...first, text: parsed.text }, ...rest] : rest
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
        if (part.type === 'planning_todo_ref') {
          let available = true
          try { validatePlanningTodoRefPart(part) } catch { available = false }
          return <span key={index} data-planning-todo-unavailable={!available || undefined} className={cn('mx-0.5 inline-flex rounded-md border px-1.5 py-0.5 align-baseline text-[13px]', available ? 'border-border' : 'border-destructive/50 text-muted-foreground')} title={available ? part.uri : '此 Planning Todo 引用已不可用'}>&amp;{available ? part.displayText : '待办不可用'}</span>
        }
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
    return <SmoothText text={block.text} isStreaming={isStreaming} threadId={threadId} onOpenThreadFile={onOpenThreadFile} />
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
      onOpenThreadFile={onOpenThreadFile}
      onUserResizeStart={onUserResizeStart}
    />
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
    if (segment.kind === 'memory_mutation') {
      return <MemoryMutationStatusLine key={segment.block.id} toolCall={segment.block.toolCall} />
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

function MemoryMutationStatusLine({ toolCall }: { toolCall: RuntimeToolCallView }) {
  const label = memoryMutationLabel(toolCall)
  const isRunning = toolCall.status === 'running'
  const error = memoryMutationError(toolCall)
  return (
    <div className={cn(
      'mx-6 flex min-h-5 items-start gap-1.5 text-[12px] leading-5 text-[var(--lume-text-muted)]',
      toolCall.status === 'failed' && 'text-destructive/75',
    )}>
      {isRunning
        ? <Loader2 size={13} className="shrink-0 animate-spin" />
        : toolCall.status === 'failed'
          ? <TriangleAlert size={13} className="mt-1 shrink-0" />
          : <Database size={13} className="shrink-0" />}
      <span className="min-w-0 whitespace-pre-wrap break-words">{label}{error ? `：${error}` : ''}</span>
    </div>
  )
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
        if (segment.kind === 'memory_mutation') {
          return <MemoryMutationStatusLine key={segment.block.id} toolCall={segment.block.toolCall} />
        }
        if (segment.kind === 'inline') {
          const block = segment.block
          if (block.type === 'text') {
            return (
              <SmoothText
                key={block.id}
                text={block.text}
                isStreaming={block.id === activeStreamingTextBlockId}
                threadId={threadId}
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
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        )
      })}
    </>
  )
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
  if (event.status === 'cancelled') return '任务已取消'
  if (event.status === 'waiting_for_user') return title ? `等待你的确认：${title}` : event.message?.trim() || '等待你的确认'
  if (event.status === 'waiting_for_permission') return title ? `等待授权：${title}` : event.message?.trim() || '等待授权'
  if (event.status === 'pending') return title ? `准备执行：${title}` : event.message?.trim() || '准备执行任务'
  if (title) return `正在执行：${title}`
  return event.message?.trim() || '正在执行任务'
}

function TaskProgressStatusLine({ event }: { event: TaskProgressViewEvent }) {
  const [expanded, setExpanded] = useState(event.status !== 'completed')
  const shouldRenderTasks = useDeferredUnmount(expanded)
  const completedCount = event.tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length
  const failedCount = event.tasks.filter((task) => task.status === 'failed').length
  const isRunning = event.status === 'pending' || event.status === 'in_progress' || event.status === 'running'
  const isWaiting = event.status === 'waiting_for_user' || event.status === 'waiting_for_permission'

  useEffect(() => {
    if (event.status === 'failed') {
      setExpanded(true)
      return undefined
    }
    if (event.status !== 'completed' && event.status !== 'cancelled') return undefined
    const timeoutId = window.setTimeout(() => setExpanded(false), 650)
    return () => window.clearTimeout(timeoutId)
  }, [event.status])

  if (event.tasks.length === 0) {
    return isRunning
      ? <ShimmerStatusLine text={getTaskProgressStatusText(event)} />
      : <div className="text-[12px] text-[var(--lume-text-muted)]">{getTaskProgressStatusText(event)}</div>
  }

  return (
    <div data-task-progress={event.status} className="max-w-[560px] overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]/60">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-auto w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-[var(--lume-bg-elevated)]"
      >
        <span className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-300',
          failedCount > 0
            ? 'border-destructive/25 bg-destructive/8 text-destructive'
            : isWaiting
              ? 'border-[color:color-mix(in_oklab,var(--lume-warning)_28%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-warning)_10%,transparent)] text-[var(--lume-warning)]'
            : isRunning
              ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_28%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]'
              : event.status === 'cancelled'
                ? 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-muted)]'
              : 'border-[color:color-mix(in_oklab,var(--lume-success)_28%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-success)_10%,transparent)] text-[var(--lume-success)]',
        )}>
          {failedCount > 0
            ? <TriangleAlert size={13} />
            : isWaiting
              ? <Clock size={13} />
            : isRunning
              ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
              : event.status === 'cancelled'
                ? <X size={13} />
              : <Check size={13} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn(
            'block truncate text-[12.5px] font-medium text-[var(--lume-text-secondary)]',
            isRunning && 'lume-shimmer-text',
          )}>
            {getTaskProgressStatusText(event)}
          </span>
          <span className="block text-[10.5px] tabular-nums text-[var(--lume-text-muted)]">
            已完成 {completedCount}/{event.tasks.length}{failedCount > 0 ? ` · ${failedCount} 失败` : ''}
          </span>
        </span>
        <ChevronRight size={13} className={cn('shrink-0 text-[var(--lume-text-muted)] transition-transform duration-300', expanded && 'rotate-90')} />
      </Button>
      {shouldRenderTasks && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div className="border-t border-[var(--lume-border-subtle)] px-2 py-1.5">
            {event.tasks.map((task, index) => {
              const running = task.status === 'running' || task.status === 'in_progress'
              const detail = task.error || task.blockedReason || (running ? task.description : undefined)
              const title = task.title || task.subject || task.description || task.id
              return (
                <div
                  key={task.id}
                  className="animate-in fade-in slide-in-from-top-1 fill-mode-both rounded-lg px-1.5 py-1.5 duration-300 motion-reduce:animate-none"
                  style={{ animationDelay: `${index * 80}ms` }}
                >
                  <div className="flex items-center gap-2 text-[11.5px] text-[var(--lume-text-secondary)]">
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {task.status === 'completed'
                        ? <Check size={12} className="text-[var(--lume-success)]" />
                        : task.status === 'failed'
                          ? <TriangleAlert size={12} className="text-destructive" />
                          : running
                            ? <Loader2 size={12} className="animate-spin text-[var(--lume-accent)] motion-reduce:animate-none" />
                            : <Clock size={11} className="text-[var(--lume-text-muted)]" />}
                    </span>
                    <span className={cn('min-w-0 flex-1 truncate', task.status === 'completed' && 'text-[var(--lume-text-muted)]')}>{title}</span>
                    {task.attemptCount && task.attemptCount > 1 ? (
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--lume-text-muted)]">第 {task.attemptCount} 次</span>
                    ) : null}
                  </div>
                  {detail && detail !== title ? (
                    <p className={cn('ml-6 mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-[var(--lume-text-muted)]', task.status === 'failed' && 'text-destructive/80')}>
                      {detail}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
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

const RuntimeEventToolCallBlock = memo(function RuntimeEventToolCallBlock({
  toolCall,
  threadId,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  toolCall: RuntimeToolCallView
  threadId: string
  onOpenThreadFile?: OpenThreadFile
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
        className="group/tool-call flex h-11 w-full items-center gap-3 px-4 text-left text-[13px] text-[var(--lume-text-secondary)] transition-colors hover:bg-[var(--lume-accent-soft)]"
      >
        {isRunning ? (
          <Icon size={15} className="shrink-0 text-[var(--lume-text-muted)]" />
        ) : (
          /* 图标↔箭头渐变：hover 或展开时图标淡出、箭头淡入（右向=可展开，下向=已展开） */
          <span className="relative flex size-4 shrink-0 items-center justify-center text-[var(--lume-text-muted)]">
            <Icon
              size={15}
              className={cn(
                'transition-opacity duration-100 group-hover/tool-call:opacity-0 motion-reduce:transition-none',
                !collapsed && 'opacity-0',
              )}
            />
            <ChevronDown
              size={13}
              className={cn(
                'absolute transition-[opacity,transform] duration-150 group-hover/tool-call:opacity-100 motion-reduce:transition-none',
                collapsed ? 'opacity-0 -rotate-90' : 'opacity-100',
              )}
            />
          </span>
        )}
        <span className="font-semibold text-[var(--lume-text-primary)]">{toolCall.toolName}</span>
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
          {isRunning ? (toolCall.toolName === 'memory.remember' ? '正在记住…' : toolCall.toolName === 'memory.forget' ? '正在遗忘…' : '执行中') : toolCall.status === 'failed' ? '失败' : '已完成'}
        </span>
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="tabular-nums text-[11px] font-medium text-[var(--lume-text-muted)]">
            {formatDurationLabel(toolCall.durationMs)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--lume-text-muted)]">{summarizeInput(input)}</span>
        {isRunning && <AgentLoadingIndicator variant="drive" startedAt={toolCall.startedAt} className="shrink-0" />}
      </Button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain border-t border-[var(--lume-border-subtle)] p-3">
            <ToolExecutionDetails toolCall={toolCall} onOpenThreadFile={onOpenThreadFile} />
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
