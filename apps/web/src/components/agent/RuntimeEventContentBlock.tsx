import { useEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Edit3, FileText, History, Loader2, Sparkles, Terminal, Wrench, X } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { useSmoothStream } from '@lume/ui'
import { ToolResultRenderer } from './tool-result-renderers'
import { cn } from '@/lib/utils'
import type { PlanPreviewView, RuntimeAssistantBlock, RuntimeMessageView, RuntimeToolCallView, TaskProgressViewEvent } from './runtime-message-view'
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
  onOpenMemorySource?: (path: string) => void
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

export function RuntimeEventContentBlock({ message, animate, threadId, onOpenThreadFile, onOpenMemorySource }: RuntimeEventContentBlockProps) {
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''

  if (message.type === 'user') {
    return <UserMessageBlock message={message} threadId={threadId} className={cls} onOpenThreadFile={onOpenThreadFile} />
  }

  const latestTaskProgressBlock = findLatestTaskProgressBlock(message.blocks)
  const contentBlocks = message.blocks.filter((block) => block.type !== 'task_progress')
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
    animate === true && message.status === 'streaming' && !latestTaskProgressBlock,
    activitySignature,
  )

  return (
    <div className={cn('flex min-w-0 gap-4', cls)}>
      <div className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full border border-[#ded6ff] bg-white text-[#675cff] shadow-[0_2px_8px_rgba(103,92,255,0.07)]">
        <Sparkles size={21} strokeWidth={1.8} fill="#675cff" fillOpacity={0.08} />
      </div>
      <div className="min-w-0 flex-1 space-y-4 pt-2">
        {contentBlocks.map((block, index) => (
          <RuntimeEventAssistantBlockItem
            key={block.id}
            block={block}
            threadId={threadId}
            onOpenThreadFile={onOpenThreadFile}
            onOpenMemorySource={onOpenMemorySource}
            isStreaming={animate === true && message.status === 'streaming'}
            isActiveThinking={block.type === 'thinking'
              && animate === true
              && message.status === 'streaming'
              && index === contentBlocks.length - 1}
          />
        ))}
        {latestTaskProgressBlock && (
          <TaskProgressStatusLine event={latestTaskProgressBlock.event} />
        )}
        {showIdleStatus && <ShimmerStatusLine text="正在思考" />}
        {message.error && (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive/80">
            {message.error}
          </p>
        )}
        <MessageFeedbackActions text={message.text} isStreaming={message.status === 'streaming'} />
      </div>
    </div>
  )
}

function UserMessageBlock({
  message,
  threadId,
  className,
  onOpenThreadFile,
}: {
  message: Extract<RuntimeMessageView, { type: 'user' }>
  threadId: string
  className: string
  onOpenThreadFile?: (path: string) => void
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
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex max-w-[560px] flex-wrap justify-end gap-1.5">
            {message.attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                onClick={() => onOpenThreadFile?.(attachment.threadPath)}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-[#ded6ff] bg-white/82 px-2 py-1 text-[11px] font-medium text-[#5f6477] shadow-[0_1px_0_rgba(101,91,255,0.06)] transition-colors hover:border-[#bdb3ff] hover:text-[#675cff]"
                title={attachment.filename}
              >
                <FileTypeIcon filename={attachment.filename} size={12} className="text-[#8b7df1]" />
                <span className="min-w-0 truncate">{attachment.filename}</span>
                <span className="shrink-0 text-[#9aa0b4]">{formatMessageAttachmentSize(attachment.size)}</span>
              </button>
            ))}
          </div>
        )}
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

export function formatMessageAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${Math.round(kb / 1024)} MB`
}

function RuntimeEventAssistantBlockItem({
  block,
  threadId,
  onOpenThreadFile,
  onOpenMemorySource,
  isStreaming,
  isActiveThinking,
}: {
  block: RuntimeAssistantBlock
  threadId: string
  onOpenThreadFile?: (path: string) => void
  onOpenMemorySource?: (path: string) => void
  isStreaming: boolean
  isActiveThinking: boolean
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
    return <MemoryContextUsedNotice event={block.event} onOpenMemorySource={onOpenMemorySource} />
  }

  return <RuntimeEventToolCallBlock toolCall={block.toolCall} threadId={threadId} />
}

function MemoryContextUsedNotice({
  event,
  onOpenMemorySource,
}: {
  event: Extract<RuntimeAssistantBlock, { type: 'memory_context_used' }>['event']
  onOpenMemorySource?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const count = event.items.length
  const groups = groupMemoryCitationItems(event.items)
  return (
    <div className="mt-2 max-w-full text-[11px] leading-5 text-[#8a92a6]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="inline-flex min-h-6 max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[#f5f6fb] hover:text-[#6f778d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#675cff]/25"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#9aa3b8]" />
        <span className="shrink-0 font-medium">引用了 {count} 条记忆</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1.5 border-l border-[#d9deea] pl-3">
          {groups.map((group) => (
            <div key={group.key} className="grid grid-cols-[42px_minmax(0,1fr)] gap-2">
              <div className="shrink-0 text-[#9aa3b8]">{group.label}</div>
              <ol className="min-w-0 space-y-1">
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
                      <li key={item.id} className="flex min-w-0 items-center gap-1.5 font-mono text-[#7b849c]" title={item.citation}>
                        {content}
                      </li>
                    )
                  }
                  return (
                    <li key={item.id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenMemorySource(sourcePath)}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[#7b849c] transition-colors hover:bg-[#f1f3f8] hover:text-[#4f46e5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#675cff]/30"
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
      )}
    </div>
  )
}

export function normalizeMemoryCitationPath(citation: string): string | null {
  const withoutLines = citation.replace(/#L\d+(?:-L?\d+)?$/i, '')
  const schemeMatch = withoutLines.match(/^[a-z]+:[a-z-]+:(\/.+)$/i)
  const path = schemeMatch?.[1] ?? (withoutLines.startsWith('/') ? withoutLines : '')
  return path.trim() || null
}

type MemoryCitationItem = Extract<RuntimeAssistantBlock, { type: 'memory_context_used' }>['event']['items'][number]
type MemoryCitationGroupKey = 'thread' | 'workspace' | 'global'

export function groupMemoryCitationItems(items: MemoryCitationItem[]): Array<{
  key: MemoryCitationGroupKey
  label: string
  items: MemoryCitationItem[]
}> {
  const groups: Record<MemoryCitationGroupKey, MemoryCitationItem[]> = {
    thread: [],
    workspace: [],
    global: [],
  }

  for (const item of items) {
    groups[getMemoryCitationGroupKey(item)].push(item)
  }

  return [
    { key: 'thread' as const, label: '线程', items: groups.thread },
    { key: 'workspace' as const, label: '工作区', items: groups.workspace },
    { key: 'global' as const, label: '全局', items: groups.global },
  ].filter((group) => group.items.length > 0)
}

function getMemoryCitationGroupKey(item: MemoryCitationItem): MemoryCitationGroupKey {
  const scope = item.scope as string
  if (scope === 'global') return 'global'
  if (scope === 'thread' || /^thread:/i.test(item.citation)) return 'thread'
  return 'workspace'
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
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
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
  const isDark = useIsDark()
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

      <div className={cn('relative mt-6', expanded ? '' : 'max-h-[390px] overflow-hidden')}>
        <XMarkdown
          className="agent-message-markdown x-markdown text-[15px] leading-7 text-[#303445]"
          rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
          components={{
            code: (props) => (
              <MarkdownCode
                {...(props as MarkdownCodeProps)}
                onOpenThreadFile={onOpenThreadFile}
              />
            ),
          }}
        >
          {preview.markdown}
        </XMarkdown>
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-28 items-end justify-center bg-gradient-to-t from-[#f4f4f5] via-[#f4f4f5]/88 to-transparent pb-2">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="pointer-events-auto rounded-full bg-[#1f232b] px-4 py-1.5 text-[14px] font-semibold text-white shadow-[0_10px_24px_rgba(31,35,43,0.22)] transition-transform hover:scale-[1.02]"
            >
              展开计划
            </button>
          </div>
        )}
      </div>
    </article>
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

export function getToolPermissionTitleBadgeText(toolCall: RuntimeToolCallView): string | null {
  if (toolCall.permissionState === 'timeout') return '权限超时'
  return null
}

function MessageFeedbackActions({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  if (!text.trim() || isStreaming) return null

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
