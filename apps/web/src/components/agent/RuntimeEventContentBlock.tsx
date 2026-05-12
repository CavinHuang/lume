import { useEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import { Check, CheckCircle, ChevronDown, ChevronRight, Circle, ClipboardList, Copy, Edit3, History, Loader2, Sparkles, Terminal, Wrench, X, XCircle } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { useSmoothStream } from '@lume/ui'
import { ToolResultRenderer } from './tool-result-renderers'
import { cn } from '@/lib/utils'
import type { RuntimeAssistantBlock, RuntimeMessageView, RuntimeToolCallView, TaskProgressViewEvent } from './runtime-message-view'
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { agentSend, getThreadMessageVersions } from '@/lib/desktop-api'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { normalizeThreadFilePathCandidate } from './thread-file-links'
import type { AgentMessage } from '@lume/shared'

interface RuntimeEventContentBlockProps {
  message: RuntimeMessageView
  animate?: boolean
  threadId: string
  onOpenThreadFile?: (path: string) => void
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

export function RuntimeEventContentBlock({ message, animate, threadId, onOpenThreadFile }: RuntimeEventContentBlockProps) {
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''

  if (message.type === 'user') {
    return <UserMessageBlock message={message} threadId={threadId} className={cls} />
  }

  const hasVisibleWorkBlock = message.blocks.some((block) => block.type === 'text' || block.type === 'tool_call')
  const shouldShowStreamingProgress = message.status === 'streaming'
    && (message.blocks.length === 0 || !hasVisibleWorkBlock)

  return (
    <div className={cn('flex min-w-0 gap-4', cls)}>
      <div className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full border border-[#ded6ff] bg-white text-[#675cff] shadow-[0_2px_8px_rgba(103,92,255,0.07)]">
        <Sparkles size={21} strokeWidth={1.8} fill="#675cff" fillOpacity={0.08} />
      </div>
      <div className="min-w-0 flex-1 space-y-4 pt-2">
        {message.blocks.map((block, index) => (
          <RuntimeEventAssistantBlockItem
            key={block.id}
            block={block}
            threadId={threadId}
            onOpenThreadFile={onOpenThreadFile}
            isStreaming={animate === true && message.status === 'streaming'}
            isActiveThinking={block.type === 'thinking'
              && animate === true
              && message.status === 'streaming'
              && index === message.blocks.length - 1}
          />
        ))}
        {shouldShowStreamingProgress && (
          <div className="flex items-center gap-2 text-[13px] text-[#8a92a6]">
            <Loader2 size={14} className="animate-spin" />
            {message.blocks.length === 0 ? 'Agent 正在思考...' : '正在准备下一步...'}
          </div>
        )}
        {message.error && (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive/80">
            {message.error}
          </p>
        )}
        <MessageFeedbackActions text={message.text} />
      </div>
    </div>
  )
}

function UserMessageBlock({
  message,
  threadId,
  className,
}: {
  message: Extract<RuntimeMessageView, { type: 'user' }>
  threadId: string
  className: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versions, setVersions] = useState<AgentMessage[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const canEdit = Boolean(message.messageId)
  const canShowVersions = Boolean(message.versionGroupId && (message.versionCount ?? 0) > 1)

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
    <div className={cn('group flex justify-end gap-2', className)}>
      <div className="flex max-w-[560px] flex-col items-end gap-1.5">
        <div className="rounded-[12px] rounded-tr-[10px] bg-[#e4ddff] px-3 py-2 text-[15px] font-medium leading-[22px] text-[#34384c] shadow-[0_1px_0_rgba(101,91,255,0.08)]">
          {editing ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-20 w-[min(520px,70vw)] resize-y rounded-lg border border-[#c8c0fb] bg-white/80 px-2 py-1.5 text-[14px] leading-6 text-[#34384c] outline-none focus:border-[#8d7af5]"
              autoFocus
            />
          ) : (
            <div className="whitespace-pre-wrap">{message.text}</div>
          )}
        </div>
        <div className="flex items-center gap-1 text-[#8b8fa3] opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
            text={message.text}
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

function RuntimeEventAssistantBlockItem({
  block,
  threadId,
  onOpenThreadFile,
  isStreaming,
  isActiveThinking,
}: {
  block: RuntimeAssistantBlock
  threadId: string
  onOpenThreadFile?: (path: string) => void
  isStreaming: boolean
  isActiveThinking: boolean
}) {
  if (block.type === 'text') {
    return <SmoothText text={block.text} isStreaming={isStreaming} onOpenThreadFile={onOpenThreadFile} />
  }

  if (block.type === 'thinking') {
    return <RuntimeEventThinkingBlock text={block.text} active={isActiveThinking} />
  }

  if (block.type === 'task_progress') {
    return <RuntimeEventTaskProgressBlock event={block.event} />
  }

  return <RuntimeEventToolCallBlock toolCall={block.toolCall} threadId={threadId} />
}

function RuntimeEventTaskProgressBlock({ event }: { event: TaskProgressViewEvent }) {
  const total = event.tasks.length
  const completed = event.tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length
  const failed = event.tasks.filter((task) => task.status === 'failed').length
  const current = event.currentTaskId
    ? event.tasks.find((task) => task.id === event.currentTaskId)
    : event.tasks.find((task) => task.status === 'running')
  const tone = failed > 0 || event.status === 'failed'
    ? 'danger'
    : event.status === 'completed'
      ? 'success'
      : 'active'

  return (
    <div className={cn(
      'max-w-[680px] rounded-lg border bg-white px-3 py-3 shadow-[0_8px_24px_rgba(53,48,85,0.06)]',
      tone === 'active' && 'border-[#d9d2ff]',
      tone === 'success' && 'border-emerald-500/20',
      tone === 'danger' && 'border-destructive/20 bg-destructive/5',
    )}>
      <div className="flex items-start gap-2">
        <span className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          tone === 'success' ? 'bg-emerald-500/10 text-emerald-600' : tone === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-[#f1efff] text-[#675cff]',
        )}>
          {tone === 'success' ? <CheckCircle size={15} /> : tone === 'danger' ? <XCircle size={15} /> : <ClipboardList size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-[13px] font-semibold text-[#34384c]">
              {event.status === 'completed' ? '任务全部完成' : event.status === 'failed' ? '任务执行失败' : '正在执行任务'}
            </div>
            <div className="shrink-0 text-[11px] text-[#8a92a6]">
              {completed}/{total}
            </div>
          </div>
          {current && (
            <div className="mt-1 text-[12px] leading-5 text-[#5c6275]">
              {current.title || current.description || current.id}
            </div>
          )}
          {event.message && event.message !== (current?.title || current?.description) && (
            <div className="mt-1 text-[11px] leading-5 text-[#8a92a6]">
              {event.message}
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            {event.tasks.slice(0, 8).map((task) => (
              <span key={task.id} title={task.title || task.description || task.id} className="text-[#9aa0b2]">
                {task.status === 'completed' || task.status === 'skipped'
                  ? <CheckCircle size={12} className="text-emerald-500" />
                  : task.status === 'running'
                    ? <Loader2 size={12} className="animate-spin text-[#675cff]" />
                    : task.status === 'failed'
                      ? <XCircle size={12} className="text-destructive" />
                      : <Circle size={12} />}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeEventThinkingBlock({ text, active }: { text: string; active: boolean }) {
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
}

function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains('dark'),
  )
}

function SmoothText({
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
  })
  const isDark = useIsDark()

  return (
    <div className="min-w-0 w-full">
      <XMarkdown
        className="agent-message-markdown x-markdown text-[15px] leading-7 text-[#303445]"
        rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
        streaming={{
          hasNextChunk: false,
          enableAnimation: true,
          tail: true,
          incompleteMarkdownComponentMap: {
            link: 'incomplete-link',
            image: 'incomplete-image',
            table: 'incomplete-table',
          },
        }}
        components={{
          code: (props) => (
            <MarkdownCode
              {...(props as MarkdownCodeProps)}
              onOpenThreadFile={onOpenThreadFile}
            />
          ),
          'incomplete-link': IncompleteLink,
          'incomplete-image': IncompleteImage,
          'incomplete-table': IncompleteTable,
        }}
      >
        {displayedContent}
      </XMarkdown>
    </div>
  )
}

type MarkdownCodeProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode
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
  const text = flattenText(children)
  const filePath = !block ? normalizeThreadFilePathCandidate(text) : null

  if (filePath && onOpenThreadFile) {
    return (
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
  }

  return <code {...rest}>{children}</code>
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

function RuntimeEventToolCallBlock({ toolCall, threadId }: { toolCall: RuntimeToolCallView; threadId: string }) {
  const [collapsed, setCollapsed] = useState(true)
  const isRunning = toolCall.status === 'running'
  const input = asRecord(toolCall.input)

  if (toolCall.toolName === 'Agent') {
    return (
      <SubagentInlinePanel
        threadId={threadId}
        toolUseId={toolCall.id}
        description={asString(input.description ?? input.prompt)}
        agentType={asString(input.subagent_type)}
        prompt={asString(input.prompt)}
      />
    )
  }

  const isBash = toolCall.toolName === 'Bash'
  const Icon = isBash ? Terminal : Wrench
  let resultData: unknown = toolCall.output
  if (typeof toolCall.output === 'string') {
    try {
      resultData = JSON.parse(toolCall.output)
    } catch {
      resultData = toolCall.output
    }
  }

  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[10px] border border-[#e1e4ec] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-[13px] text-[#59637a] transition-colors hover:bg-[#fbfcff]"
      >
        <Icon size={15} className="shrink-0 text-[#68718a]" />
        <span className="font-mono font-semibold text-[#4d566f]">{toolCall.toolName}</span>
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[12px] font-semibold',
          toolCall.status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-[#f0efff] text-[#7567ff]',
        )}>
          {isRunning ? '执行中' : toolCall.status === 'failed' ? '失败' : '已完成'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[#68718a]">{summarizeInput(input)}</span>
        {isRunning && <Loader2 size={13} className="shrink-0 animate-spin text-[#7567ff]" />}
        {!isRunning && (
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-[#7f8794] transition-transform', !collapsed && 'rotate-180')}
          />
        )}
      </button>
      {!isRunning && (
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
            collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-t border-[#edf0f5] p-3">
              <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageFeedbackActions({ text }: { text: string }) {
  if (!text.trim()) return null

  return (
    <div className="flex items-center pt-2 text-[#9aa1b3]">
      <CopyMessageButton
        text={text}
        className="rounded-md p-0.5 transition-colors hover:bg-[#f4f5fa] hover:text-[#6770ff] data-[state=copied]:text-emerald-600"
        iconSize={15}
        strokeWidth={1.8}
      />
    </div>
  )
}

function CopyMessageButton({
  text,
  className,
  iconSize,
  strokeWidth,
}: {
  text: string
  className: string
  iconSize: number
  strokeWidth?: number
}) {
  const [copied, setCopied] = useState(false)
  const feedbackStateRef = useRef<CopyFeedbackState>({ resetTimeoutId: null })

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
    </button>
  )
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
