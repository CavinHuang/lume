import { useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, Copy, Loader2, Sparkles, Terminal, Wrench } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { useSmoothStream } from '@lume/ui'
import { ToolResultRenderer } from './tool-result-renderers'
import { cn } from '@/lib/utils'
import type { RunEventAssistantBlock, RunEventMessageView, RunEventToolCallView } from './run-event-message-projection'
import { SubagentInlinePanel } from './SubagentInlinePanel'

interface RunEventContentBlockProps {
  message: RunEventMessageView
  animate?: boolean
  threadId: string
}

export function RunEventContentBlock({ message, animate, threadId }: RunEventContentBlockProps) {
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''

  if (message.type === 'user') {
    return (
      <div className={cn('flex justify-end gap-2', cls)}>
        <div className="max-w-[520px] rounded-[12px] rounded-tr-[10px] bg-[#e4ddff] px-3 py-2 text-[15px] font-medium leading-[22px] text-[#34384c] shadow-[0_1px_0_rgba(101,91,255,0.08)]">
          <div className="whitespace-pre-wrap">{message.text}</div>
        </div>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#9377f4] text-[15px] font-semibold text-white shadow-[0_4px_10px_rgba(118,97,230,0.18)]">
          L
        </div>
      </div>
    )
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
        {message.blocks.map((block) => (
          <RunEventAssistantBlockItem
            key={block.id}
            block={block}
            threadId={threadId}
            isStreaming={animate === true && message.status === 'streaming'}
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

function RunEventAssistantBlockItem({
  block,
  threadId,
  isStreaming,
}: {
  block: RunEventAssistantBlock
  threadId: string
  isStreaming: boolean
}) {
  if (block.type === 'text') {
    return <SmoothText text={block.text} isStreaming={isStreaming} />
  }

  if (block.type === 'thinking') {
    return <RunEventThinkingBlock text={block.text} />
  }

  return <RunEventToolCallBlock toolCall={block.toolCall} threadId={threadId} />
}

function RunEventThinkingBlock({ text }: { text: string }) {
  const [collapsed, setCollapsed] = useState(true)

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
      {!collapsed && (
        <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[#8a91a6]">{text}</p>
      )}
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

function SmoothText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
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

function RunEventToolCallBlock({ toolCall, threadId }: { toolCall: RunEventToolCallView; threadId: string }) {
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
      {!isRunning && !collapsed && (
        <div className="border-t border-[#edf0f5] p-3">
          <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
        </div>
      )}
    </div>
  )
}

function MessageFeedbackActions({ text }: { text: string }) {
  if (!text.trim()) return null

  return (
    <div className="flex items-center pt-2 text-[#9aa1b3]">
      <button
        type="button"
        aria-label="复制消息"
        onClick={() => void navigator.clipboard?.writeText(text)}
        className="rounded-md p-0.5 transition-colors hover:bg-[#f4f5fa] hover:text-[#6770ff]"
      >
        <Copy size={15} strokeWidth={1.8} />
      </button>
    </div>
  )
}

function summarizeInput(input: unknown): string {
  const record = asRecord(input)
  const value = record.command ?? record.file_path ?? record.path ?? record.query ?? record.description ?? record.prompt
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
