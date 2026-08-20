import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Database, Download, ExternalLink, Gauge, GitFork, Globe, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { activeTabIdAtom, agentThreadsAtom, tabsAtom } from '@/atoms'
import { AGENT_IPC_CHANNELS, type AgentThreadMeta, type FileRef } from '@lume/shared'
import { openExternal, openInSystem, saveTextFileDialog, sidecarCall, writeClipboardText } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import type { MemoryContextUsedViewEvent, RuntimeAssistantTokenUsageView } from '../runtime-message-view'
import type { AssistantSourceReference } from '../source-references'
import { CopyFeedbackState, getAssistantCopyText, showTemporaryCopiedFeedback } from './copy-text'
import { compactMemoryCitationLabel, groupMemoryCitationItems, normalizeMemoryCitationPath } from './memory-citation'

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
        <span>参考了 {totalCount} 条记忆</span>
        <ChevronRight size={13} className={cn('transition-transform duration-300', expanded && 'rotate-90')} />
      </Button>
      {expanded && (
        <div className="animate-in fade-in zoom-in-95 slide-in-from-top-1 absolute left-0 top-full z-30 mt-1 max-h-60 min-w-[220px] max-w-[360px] origin-top-left overflow-y-auto rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)] duration-200 motion-reduce:animate-none">
          <div className="space-y-2 text-[11px] leading-5 text-[var(--lume-text-muted)]">
            {groups.map((group, groupIndex) => (
              <div
                key={group.key}
                className="animate-in fade-in slide-in-from-top-1 fill-mode-both duration-300 motion-reduce:animate-none"
                style={{ animationDelay: `${groupIndex * 80}ms` }}
              >
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

export function AssistantMessageFooter({
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
    <div className="assistant-message-footer pointer-events-none flex min-h-5 w-full items-center justify-between gap-3 text-[var(--lume-text-muted)] opacity-0 transition-opacity duration-150 ease-out group-hover/agent-message:pointer-events-auto group-hover/agent-message:opacity-100 group-focus-within/agent-message:pointer-events-auto group-focus-within/agent-message:opacity-100 motion-reduce:transition-none">
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

export function formatMessageTime(value?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatAssistantCompletionTime(completedAt?: string): string | null {
  return formatMessageTime(completedAt)
}

export function CopyMessageButton({
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
