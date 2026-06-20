import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type HTMLAttributes, type ReactNode } from 'react'
import { Bot, Brain, Check, ChevronDown, ChevronRight, Clock, Copy, Database, Download, Edit3, FileText, GitFork, History, Loader2, Sparkles, Terminal, TriangleAlert, Wrench, X } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { useSmoothStream } from '@lume/ui'
import { ToolResultRenderer } from './tool-result-renderers'
import { cn } from '@/lib/utils'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeTabIdAtom, agentThreadsAtom, generalSettingsAtom, tabsAtom } from '@/atoms'
import type { MemoryContextUsedViewEvent, PlanPreviewView, RuntimeAssistantBlock, RuntimeAssistantTokenUsageView, RuntimeMessageView, RuntimeToolCallView, TaskProgressViewEvent } from './runtime-message-view'
import { groupAssistantBlocksForMinimal } from './minimal-assistant-grouping'
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { agentSend, getThreadMessageVersions, sidecarCall, saveTextFileDialog, openInSystem } from '@/lib/desktop-api'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { normalizeThreadFilePathCandidate } from './thread-file-links'
import { useThreadFileEnv } from './thread-file-env'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { AGENT_IPC_CHANNELS, getAgentRole, parseAfterglowBlocks, stripAfterglowLines, type AgentMessage, type AgentMessageAttachmentInput, type AgentThreadFileDataResult, type AgentRoleDefinition, type AgentThreadMeta } from '@lume/shared'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import { AGENT_ROLE_ASSETS } from '@/components/settings/agents-settings-state'
import { toast } from 'sonner'
import { AgentAttachmentGrid, isImageAttachment } from './AgentAttachmentGrid'

const MARKDOWN_STREAM_MIN_DELAY_MS = 50

interface RuntimeEventContentBlockProps {
  message: RuntimeMessageView
  animate?: boolean
  streaming?: boolean
  threadId: string
  onOpenThreadFile?: (path: string) => void
  onOpenThreadImage?: (attachment: AgentMessageAttachmentInput) => void
  onOpenMemorySource?: (path: string) => void
  onUserResizeStart?: () => void
}

/**
 * memo 比较函数：流式时 projection 每 token 重建所有 message 对象引用，
 * 默认浅比较会失效、导致整条消息列表每 token 都 re-render。这里按「内容」
 * 比较 message，让内容未变的历史消息跳过 re-render。
 *
 * - 标量 props（streaming/animate/threadId）直接比较；
 * - onOpen* / onUserResizeStart 回调由父级 useCallback 保证引用稳定，不参与比较；
 * - message 用 JSON.stringify 比较，自动覆盖全部渲染字段，避免漏字段导致该刷新不刷新。
 */
export function areRuntimeEventContentBlockPropsEqual(
  prev: RuntimeEventContentBlockProps,
  next: RuntimeEventContentBlockProps,
): boolean {
  if (prev.streaming !== next.streaming) return false
  if (prev.animate !== next.animate) return false
  if (prev.threadId !== next.threadId) return false
  if (prev.message === next.message) return true
  if (prev.message.type !== next.message.type) return false
  return JSON.stringify(prev.message) === JSON.stringify(next.message)
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
  return (clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export function getAssistantCopyText(text: string): string {
  return stripAfterglowLines(text)
}

export const RuntimeEventContentBlock = memo(function RuntimeEventContentBlock({
  message,
  animate,
  streaming,
  threadId,
  onOpenThreadFile,
  onOpenThreadImage,
  onOpenMemorySource,
  onUserResizeStart,
}: RuntimeEventContentBlockProps) {
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''

  if (message.type === 'user') {
    return (
      <UserMessageBlock
        message={message}
        threadId={threadId}
        className={cls}
        onOpenThreadFile={onOpenThreadFile}
        onOpenThreadImage={onOpenThreadImage}
      />
    )
  }

  if (message.type === 'system') {
    return <SystemMessageBlock message={message} className={cls} />
  }

  const latestTaskProgressBlock = findLatestTaskProgressBlock(message.blocks)
  const contentBlocks = message.blocks.filter((block) => block.type !== 'task_progress')
  const useMinimalMode = useAtomValue(generalSettingsAtom).agentMessageDisplayMode === 'minimal'
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

  return (
    <div className={cn('group/agent-message flex w-full max-w-[920px] min-w-0 gap-4', cls)}>
      <div className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full border border-[#ded6ff] bg-white text-[#675cff] shadow-[0_2px_8px_rgba(103,92,255,0.07)]">
        <Sparkles size={21} strokeWidth={1.8} fill="#675cff" fillOpacity={0.08} />
      </div>
      <div className="min-w-0 flex-1 space-y-4 pt-2">
        {useMinimalMode ? (
          <MinimalAssistantContent
            blocks={contentBlocks.filter((b) => b.type !== 'memory_context_used')}
            threadId={threadId}
            isStreamingMessage={streaming === true && message.status === 'streaming'}
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        ) : (
          contentBlocks
            .filter((block) => block.type !== 'memory_context_used')
            .map((block, index) => (
              <RuntimeEventAssistantBlockItem
                key={block.id}
                block={block}
                threadId={threadId}
                onOpenThreadFile={onOpenThreadFile}
                onUserResizeStart={onUserResizeStart}
                isStreaming={block.type === 'text' && block.id === activeStreamingTextBlockId}
                isActiveThinking={block.type === 'thinking'
                  && streaming === true
                  && message.status === 'streaming'
                  && index === contentBlocks.length - 1}
              />
            ))
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
          onOpenMemorySource={onOpenMemorySource}
        />
        {message.imDelivery && <ImDeliveryStatusLine delivery={message.imDelivery} />}
      </div>
    </div>
  )
}, areRuntimeEventContentBlockPropsEqual)

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
        'flex min-h-5 items-center gap-1.5 text-[12px] leading-5 text-[#9aa1b3]',
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
      <div className="flex w-full items-center gap-4 px-6 py-1 text-[15px] font-semibold leading-6 text-[#7d8494]">
        <span className="h-px min-w-8 flex-1 bg-[#dde1e8]" />
        <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
          {active
            ? <Loader2 size={17} className="animate-spin text-[#8b91a0]" strokeWidth={2} />
            : <History size={17} className="text-[#7d8494]" strokeWidth={2} />}
          {message.text}
          {hasSummary && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-1 text-[12px] font-medium text-[#8b91a0] underline-offset-2 hover:underline"
            >
              {expanded ? '收起总结' : '查看总结'}
            </button>
          )}
        </span>
        <span className="h-px min-w-8 flex-1 bg-[#dde1e8]" />
      </div>
      {hasSummary && expanded && (
        <div className="mx-auto max-h-60 w-full max-w-3xl overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#f5f6f8] px-4 py-3 text-[13px] font-normal leading-6 text-[#3f4452]">
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
  onOpenThreadFile,
  onOpenThreadImage,
}: {
  message: Extract<RuntimeMessageView, { type: 'user' }>
  threadId: string
  className: string
  onOpenThreadFile?: (path: string) => void
  onOpenThreadImage?: (attachment: AgentMessageAttachmentInput) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<AgentMessage[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const canEdit = Boolean(message.messageId)
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
    <div className={cn('group/user-message ml-auto flex w-full max-w-[920px] justify-end gap-2', className)}>
      <div className="flex max-w-[560px] flex-col items-end gap-1.5">
        {message.attachments && message.attachments.length > 0 && (
          <AgentAttachmentGrid
            attachments={message.attachments}
            align="right"
            imageSrcById={imageSrcById}
            onOpenFile={(attachment) => onOpenThreadFile?.(attachment.threadPath)}
            onOpenImage={(attachment) => onOpenThreadImage?.(attachment)}
          />
        )}
        <div className="rounded-[12px] rounded-tr-[10px] bg-[#e4ddff] px-3 py-2 text-[15px] font-medium leading-[22px] text-[#34384c] shadow-[0_1px_0_rgba(101,91,255,0.08)]">
          {editing ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-20 w-[min(520px,70vw)] resize-y rounded-lg border border-[#c8c0fb] bg-white/80 px-2 py-1.5 text-[14px] leading-6 text-[#34384c] outline-none focus:border-[#8d7af5]"
              autoFocus
            />
          ) : (
            <UserAgentRoleInvocationContent text={message.text} />
          )}
        </div>
        <div className="pointer-events-none flex -translate-y-1 items-center gap-1 text-[#8b8fa3] opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/user-message:pointer-events-auto group-hover/user-message:translate-y-0 group-hover/user-message:opacity-100 group-focus-within/user-message:pointer-events-auto group-focus-within/user-message:translate-y-0 group-focus-within/user-message:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none">
          {canShowVersions && (
            <button
              type="button"
              onClick={() => void loadVersions()}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-[#f4f2ff] hover:text-[#675cff]"
              title="查看历史版本"
            >
              <History size={13} />
              v{message.versionIndex}/{message.versionCount}
            </button>
          )}
          <CopyMessageButton
            text={visibleMessageText}
            className="rounded-md p-1 transition-colors hover:bg-[#f4f2ff] hover:text-[#675cff] data-[state=copied]:text-emerald-600"
            iconSize={14}
          />
          {editing ? (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitEdit()}
                className="rounded-md p-1 transition-colors hover:bg-emerald-500/10 hover:text-emerald-600 disabled:opacity-50"
                title="保存并重新发送"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button
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
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => {
                setDraft(message.text)
                setEditing(true)
              }}
              className="rounded-md p-1 transition-colors hover:bg-[#f4f2ff] hover:text-[#675cff] disabled:cursor-not-allowed disabled:opacity-40"
              title={canEdit ? '编辑并重新发送' : '旧消息暂不支持编辑'}
            >
              <Edit3 size={14} />
            </button>
          )}
        </div>
        {versionsOpen && (
          <div className="w-[min(520px,70vw)] rounded-xl border border-[#e5e0ff] bg-white p-2 text-left shadow-[0_12px_32px_rgba(57,48,120,0.12)]">
            {versionsLoading ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-[#8b8fa3]">
                <Loader2 size={13} className="animate-spin" />
                加载版本...
              </div>
            ) : (
              <div className="space-y-1">
                {versions.map((version) => (
                  <div key={version.id} className="rounded-lg bg-[#f8f7ff] px-2 py-1.5">
                    <div className="mb-1 text-[11px] font-medium text-[#786ef0]">版本 {version.versionIndex}</div>
                    <div className="whitespace-pre-wrap text-[12px] leading-5 text-[#4d5368]">{version.content}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#9377f4] text-[15px] font-semibold text-white shadow-[0_4px_10px_rgba(118,97,230,0.18)]">
        L
      </div>
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
): Record<string, string | undefined> {
  const [srcById, setSrcById] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    const imageAttachments = (attachments ?? []).filter(isImageAttachment)
    if (imageAttachments.length === 0) {
      setSrcById({})
      return
    }

    let cancelled = false
    setSrcById({})
    void Promise.all(imageAttachments.map(async (attachment) => {
      try {
        const result = await sidecarCall<AgentThreadFileDataResult>(AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA, {
          threadId,
          path: attachment.threadPath,
        })
        return [attachment.id, `data:${attachment.mediaType};base64,${result.data}`] as const
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
    }
  }, [attachments, threadId])

  return srcById
}

export function UserAgentRoleInvocationContent({ text }: { text: string }) {
  const invocation = parseAgentRoleInstructionMessage(text)

  if (!invocation) {
    return <div className="whitespace-pre-wrap">{text}</div>
  }

  return (
    <div data-agent-role-message={invocation.role.id} className="min-w-0 space-y-2">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/45 bg-white/50 px-2 py-1 shadow-[0_1px_0_rgba(101,91,255,0.08)]">
        <img
          src={AGENT_ROLE_ASSETS.roles[invocation.role.id]}
          alt=""
          className="size-6 shrink-0 rounded-full object-cover ring-1 ring-white/80"
        />
        <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-[#34384c]">
          {invocation.role.displayName}
        </span>
        <span className="shrink-0 text-[12px] font-medium leading-5 text-[#6f7488]">
          {invocation.role.title}
        </span>
      </div>
      {invocation.task && (
        <div className="whitespace-pre-wrap text-[15px] leading-[22px] text-[#34384c]">{invocation.task}</div>
      )}
    </div>
  )
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
  onOpenThreadFile?: (path: string) => void
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

  return (
    <RuntimeEventToolCallBlock
      toolCall={block.toolCall}
      threadId={threadId}
      onUserResizeStart={onUserResizeStart}
    />
  )
})

function MinimalProcessGroup({
  blocks,
  threadId,
  isStreamingMessage,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onUserResizeStart?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const toolCalls = blocks
    .filter((b): b is Extract<RuntimeAssistantBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => b.toolCall)
  const subagentCount = toolCalls.filter((tc) => tc.toolName === 'Agent').length
  const nonAgentCount = toolCalls.length - subagentCount
  const failedCount = toolCalls.filter((tc) => tc.status === 'failed').length
  const completedCount = toolCalls.filter((tc) => tc.status === 'completed').length
  // 仅展示第一个运行中的工具：agent 绝大多数情况顺序执行工具；并发多工具时其余的进度不单独展示。
  const runningTool = toolCalls.find((tc) => tc.status === 'running')
  const hasRunning = isStreamingMessage && Boolean(runningTool)

  useEffect(() => {
    if (!hasRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [hasRunning])

  const nonAgentDurationMs = toolCalls
    .filter((tc) => tc.toolName !== 'Agent')
    .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
  const subagentDurationMs = toolCalls
    .filter((tc) => tc.toolName === 'Agent')
    .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
  const runningElapsedMs = hasRunning && runningTool?.startedAt
    ? Math.max(0, now - Date.parse(runningTool.startedAt))
    : 0
  const runningOnSubagent = hasRunning && runningTool?.toolName === 'Agent'
  const toolDurationMs = nonAgentDurationMs + (runningOnSubagent ? 0 : runningElapsedMs)
  const subagentTotalMs = subagentDurationMs + (runningOnSubagent ? runningElapsedMs : 0)
  const thinkingCount = blocks.filter((b) => b.type === 'thinking').length

  const fmtDuration = (ms: number) => (
    ms <= 0
      ? ''
      : ms / 1000 < 60
        ? `${(ms / 1000).toFixed(hasRunning ? 0 : 1)}s`
        : formatDurationLabel(ms)
  )

  // 折叠行摘要：图标 + 文本单元，用 · 分隔（不再使用 emoji）
  const summaryUnits: ReactNode[] = []
  if (hasRunning && runningTool) {
    // 运行中：当前动作 + 已完成步数 + 总已用时
    summaryUnits.push(
      <span key="run" className="inline-flex items-center gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
        正在执行 {runningTool.toolName}
      </span>,
    )
    summaryUnits.push(
      <span key="done">
        已完成 {completedCount} 步{failedCount > 0 ? ` · ${failedCount} 失败` : ''}
      </span>,
    )
    const elapsed = fmtDuration(runningElapsedMs + nonAgentDurationMs + subagentDurationMs)
    if (elapsed) {
      summaryUnits.push(
        <span key="dur" className="inline-flex items-center gap-1 tabular-nums">
          <Clock size={12} />
          {elapsed}
        </span>,
      )
    }
  } else {
    // 完成态：按分类（思考次数 / 工具调用数+时长 / 子代理数+时长 / 失败），按需省略
    if (thinkingCount > 0) {
      summaryUnits.push(
        <span key="think" className="inline-flex items-center gap-1">
          <Brain size={12} />
          思考 {thinkingCount} 次
        </span>,
      )
    }
    if (nonAgentCount > 0) {
      const d = fmtDuration(toolDurationMs)
      summaryUnits.push(
        <span key="ops" className="inline-flex items-center gap-1 tabular-nums">
          <Wrench size={12} />
          {nonAgentCount} 个工具调用{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (subagentCount > 0) {
      const d = fmtDuration(subagentTotalMs)
      summaryUnits.push(
        <span key="sub" className="inline-flex items-center gap-1 tabular-nums">
          <Bot size={12} />
          {subagentCount} 子代理{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (failedCount > 0) {
      summaryUnits.push(
        <span key="fail" className="inline-flex items-center gap-1 text-destructive/70">
          <TriangleAlert size={12} />
          {failedCount} 失败
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
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        {summaryNodes}
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>
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
}

function MinimalToolCallRow({ toolCall }: { toolCall: RuntimeToolCallView }) {
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
      <button
        type="button"
        disabled={isRunning}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60 disabled:hover:text-foreground/40"
      >
        <Icon size={12} className="shrink-0" />
        <span className="shrink-0 font-mono font-medium">{toolCall.toolName}</span>
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
      </button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="mb-1 mt-1 max-h-[min(40vh,360px)] overflow-y-auto rounded-md bg-foreground/[0.03] p-2">
            <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
}

function MinimalThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <Brain size={12} className="shrink-0" />
        <span className="flex-1">思考过程</span>
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      <AnimatedCollapsiblePanel open={open}>
        <p className="mb-1 mt-1 whitespace-pre-wrap rounded-md bg-foreground/[0.03] p-2 text-[11.5px] leading-relaxed text-foreground/50">
          {text}
        </p>
      </AnimatedCollapsiblePanel>
    </div>
  )
}

function MinimalSubagentRow({
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
      <button
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
      </button>
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
}

function MinimalAssistantContent({
  blocks,
  threadId,
  isStreamingMessage,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onOpenThreadFile?: (path: string) => void
  onUserResizeStart?: () => void
}) {
  const segments = useMemo(() => groupAssistantBlocksForMinimal(blocks), [blocks])

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === 'inline') {
          const block = segment.block
          if (block.type === 'text') {
            return (
              <SmoothText
                key={block.id}
                text={block.text}
                isStreaming={isStreamingMessage}
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
    <div className="flex min-h-5 items-center text-[13px] font-medium leading-5 text-[#8a92a6]">
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
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex items-center gap-1 text-[12px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <ChevronRight size={12} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        思考过程
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[#8a91a6]">{text}</p>
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
      className="my-1.5 select-none text-[13px] italic leading-6 text-[#6b7280]/70"
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
  onOpenThreadFile?: (path: string) => void
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
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
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
    event.clipboardData.setData('text/plain', text)
  }, [])
  const renderMarkdown = (content: string, key?: string) => (
    <XMarkdown
      key={key}
      className="agent-message-markdown x-markdown text-[15px] leading-7 text-[#303445]"
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
  onOpenThreadFile?: (path: string) => void
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
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard)
    if (!writeText) return

    try {
      await writeText(preview.markdown)
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
      className="w-full max-w-[920px] overflow-hidden rounded-[24px] border border-[#e6e6e9] bg-[#f4f4f5] px-5 py-5 shadow-[0_18px_50px_rgba(28,31,39,0.08)]"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-5 text-[#20242c]">计划</div>
          <h3 className="mt-6 text-[28px] font-semibold leading-[1.18] tracking-normal text-[#1f232b]">
            {preview.title}
          </h3>
          {preview.summary && (
            <p className="mt-3 text-[15px] leading-7 text-[#4f5663]">{preview.summary}</p>
          )}
          {preview.planFilePath && (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-[#777d88]">
              <FileText size={13} className="shrink-0" />
              <span className="truncate font-mono">{preview.planFilePath}</span>
              {preview.planVerified ? <span className="shrink-0 text-emerald-600">已验证</span> : null}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[#858991]">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-black/[0.05] hover:text-[#20242c]"
            title={copied ? '已复制' : '复制 Markdown'}
            aria-label="复制计划"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            <span>复制计划</span>
          </button>
          {preview.planFilePath && (
            <button
              type="button"
              onClick={() => {
                if (preview.planFilePath) onOpenThreadFile?.(preview.planFilePath)
              }}
              disabled={!canOpenFile}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-black/[0.05] hover:text-[#20242c] disabled:cursor-not-allowed disabled:opacity-50"
              title={preview.planFilePath}
            >
              <FileText size={15} />
              <span>打开计划文件</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-black/[0.05] hover:text-[#20242c]"
            aria-label={expanded ? '收起计划' : '展开计划'}
          >
            <ChevronDown size={16} className={cn('transition-transform', expanded && 'rotate-180')} />
            <span>{expanded ? '收起计划' : '展开计划'}</span>
          </button>
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
  onOpenThreadFile?: (path: string) => void
}) {
  const isDark = useIsDark()
  const components = useMemo(() => ({
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
  }), [onOpenThreadFile])

  return (
    <XMarkdown
      className="agent-message-markdown x-markdown text-[15px] leading-7 text-[#303445]"
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

export function MarkdownCode({
  children,
  block,
  lang: _lang,
  domNode: _domNode,
  streamStatus: _streamStatus,
  onOpenThreadFile,
  ...rest
}: MarkdownCodeProps & { onOpenThreadFile?: (path: string) => void }) {
  const env = useThreadFileEnv()
  const text = flattenText(children)
  const filePath = !block ? normalizeThreadFilePathCandidate(text) : null

  if (filePath && onOpenThreadFile) {
    const button = (
      <button
        type="button"
        data-thread-file-link="true"
        data-file-link-highlight="true"
        aria-label={`在右侧预览文件 ${filePath}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenThreadFile(filePath)
        }}
        className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-[#d9d2ff] bg-[#f4f1ff] px-1.5 py-0.5 align-baseline font-mono text-[0.92em] font-medium text-[#4f46e5] shadow-[0_1px_0_rgba(103,92,255,0.12)] transition-colors hover:border-[#b9afff] hover:bg-[#edeaff] hover:text-[#4338ca] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#675cff]/35"
        title="在右侧预览文件"
      >
        <span
          aria-hidden="true"
          data-file-link-icon="true"
          className="inline-flex shrink-0 items-center"
        >
          <FileTypeIcon filename={filePath} size={13} />
        </span>
        <span className="truncate">{children}</span>
      </button>
    )
    return (
      <FileLinkContextMenu
        context={{ source: "thread", relPath: filePath, threadId: env.threadId, workspaceSlug: env.workspaceSlug }}
        onPreview={() => onOpenThreadFile(filePath)}
        inline
      >
        {button}
      </FileLinkContextMenu>
    )
  }

  const codeProps = normalizeMarkdownCodeProps(rest as Record<string, unknown>) as HTMLAttributes<HTMLElement>
  return <code {...codeProps}>{children}</code>
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
    <div className="w-full max-w-[460px] overflow-hidden rounded-[10px] border border-[#e1e4ec] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <button
        type="button"
        onClick={() => {
          if (!isRunning) {
            onUserResizeStart?.()
          }
          setCollapsed((value) => !value)
        }}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-[13px] text-[#59637a] transition-colors hover:bg-[#fbfcff]"
      >
        <Icon size={15} className="shrink-0 text-[#68718a]" />
        <span className="font-mono font-semibold text-[#4d566f]">{toolCall.toolName}</span>
        {getToolPermissionTitleBadgeText(toolCall) && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-700">
            {getToolPermissionTitleBadgeText(toolCall)}
          </span>
        )}
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[12px] font-semibold',
          toolCall.status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-[#f0efff] text-[#7567ff]',
        )}>
          {isRunning ? '执行中' : toolCall.status === 'failed' ? '失败' : '已完成'}
        </span>
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="tabular-nums text-[11px] font-medium text-[#9aa0a6]">
            {formatDurationLabel(toolCall.durationMs)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[#68718a]">{summarizeInput(input)}</span>
        {isRunning && <Loader2 size={13} className="shrink-0 animate-spin text-[#7567ff]" />}
        {!isRunning && (
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-[#7f8794] transition-transform', !collapsed && 'rotate-180')}
          />
        )}
      </button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain border-t border-[#edf0f5] p-3">
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
function FooterMemoryNotice({
  events,
  onOpenMemorySource,
}: {
  events: MemoryContextUsedViewEvent[]
  onOpenMemorySource?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const totalCount = events.reduce((sum, e) => sum + e.items.length, 0)
  const groups = groupMemoryCitationItems(events.flatMap(e => e.items))
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 text-[#8a92a6] transition-colors hover:text-[#6770ff]"
      >
        <Database size={13} strokeWidth={1.8} />
        <span>引用了 {totalCount} 条记忆</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {expanded && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-[220px] max-w-[360px] overflow-y-auto rounded-lg border border-[#e3e5ee] bg-white p-2 shadow-[0_16px_40px_-24px_rgba(30,34,60,0.45)]">
          <div className="space-y-2 text-[11px] leading-5 text-[#8a92a6]">
            {groups.map(group => (
              <div key={group.key}>
                <div className="mb-0.5 text-[#9aa3b8]">{group.label}</div>
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
                        <li key={item.id} className="flex items-center gap-1.5 font-mono text-[#7b849c]" title={item.citation}>
                          {content}
                        </li>
                      )
                    }
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => onOpenMemorySource(sourcePath)}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[#7b849c] transition-colors hover:bg-[#f1f3f8] hover:text-[#4f46e5]"
                          title={item.citation}
                        >
                          {content}
                        </button>
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
  onOpenMemorySource?: (path: string) => void
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

  if (!canCopy && !canFork && !canDownload && !showTokens && !completedTimeLabel && !hasMemory) return null

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
    <div className="pointer-events-none flex min-h-6 w-full -translate-y-1 items-center justify-between gap-3 pt-2 text-[#6f717a] opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/agent-message:pointer-events-auto group-hover/agent-message:translate-y-0 group-hover/agent-message:opacity-100 group-focus-within/agent-message:pointer-events-auto group-focus-within/agent-message:translate-y-0 group-focus-within/agent-message:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none">
      <div className="flex min-w-0 items-center gap-4">
        {canCopy && (
          <CopyMessageButton
            text={copyText}
            label="复制"
            copiedLabel="已复制"
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[#6770ff] data-[state=copied]:text-emerald-600"
            iconSize={15}
            strokeWidth={1.8}
          />
        )}
        {canFork && (
          <button
            type="button"
            disabled={forking}
            onClick={() => void handleFork()}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[#6770ff] disabled:cursor-not-allowed disabled:opacity-50"
            title="创建分支"
            aria-label="创建分支"
          >
            {forking
              ? <Loader2 size={15} className="animate-spin" strokeWidth={1.8} />
              : <GitFork size={15} strokeWidth={1.8} />}
            <span>创建分支</span>
          </button>
        )}
        {canDownload && (
          <div className="relative shrink-0" ref={downloadMenuRef}>
            <button
              ref={downloadTriggerRef}
              type="button"
              onClick={() => setDownloadMenuOpen((current) => !current)}
              className="inline-flex items-center gap-1 rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 transition-colors hover:text-[#6770ff]"
              title="下载"
              aria-label="下载"
              aria-haspopup="menu"
              aria-expanded={downloadMenuOpen}
            >
              <Download size={15} strokeWidth={1.8} />
              <span>下载</span>
            </button>
            <div
              role="menu"
              aria-label="选择下载格式"
              hidden={!downloadMenuOpen}
              className="absolute left-0 top-full z-30 mt-1 min-w-[112px] rounded-lg border border-[#e3e5ee] bg-white p-1 shadow-[0_16px_40px_-24px_rgba(30,34,60,0.45)]"
            >
              <DownloadFormatMenuItem onClick={() => handleDownload('html')}>下载 HTML</DownloadFormatMenuItem>
              <DownloadFormatMenuItem onClick={() => handleDownload('txt')}>下载 TXT</DownloadFormatMenuItem>
            </div>
          </div>
        )}
        {completedTimeLabel && (
          <span className="inline-flex shrink-0 items-center rounded-md px-0 py-0.5 text-[12px] font-medium leading-5 text-[#9aa1b3]">
            {completedTimeLabel}
          </span>
        )}
        {hasMemory && (
          <FooterMemoryNotice
            events={memoryEvents!}
            onOpenMemorySource={onOpenMemorySource}
          />
        )}
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
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] font-medium leading-5 text-[#4c5162] transition-colors hover:bg-[#f5f6fb] hover:text-[#6770ff]"
    >
      {children}
    </button>
  )
}

function AssistantTokenUsageMetrics({ usage }: { usage: FooterTokenUsage }) {
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-3 text-[12px] font-medium leading-5 text-[#6f717a] tabular-nums"
      title={usage.title}
      aria-label={usage.title}
    >
      {usage.inputTokens !== undefined && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↑</span>
          <span>{usage.inputTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.outputTokens !== undefined && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↓</span>
          <span>{usage.outputTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.cachedTokens !== undefined && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="text-[15px] leading-none">↺</span>
          <span>{usage.cachedTokens.toLocaleString()}</span>
        </span>
      )}
      {usage.contextPercent !== undefined && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Copy size={13} strokeWidth={1.8} />
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
  const cachedTokens = positiveInteger(usage?.cachedTokens ?? ((usage?.cacheReadInputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0)))
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
    const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard)
    if (!writeText) return

    try {
      await writeText(text)
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
    <button
      type="button"
      aria-label={copied ? '复制成功' : '复制消息'}
      data-state={copied ? 'copied' : 'idle'}
      onClick={() => void handleCopy()}
      className={className}
      title={copied ? '已复制' : '复制'}
    >
      {copied
        ? <Check size={iconSize} strokeWidth={strokeWidth} />
        : <Copy size={iconSize} strokeWidth={strokeWidth} />}
      {displayLabel && <span>{displayLabel}</span>}
    </button>
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
