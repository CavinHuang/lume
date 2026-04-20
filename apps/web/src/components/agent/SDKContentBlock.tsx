import { useState, useMemo, useRef, useEffect, useSyncExternalStore } from 'react'
import { ChevronRight, Bot, Terminal, FileText, FilePlus, Pencil, FolderSearch, Search, Globe, Cpu, Wrench, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { useSmoothStream } from '@lume/ui'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { ToolResultRenderer } from './tool-result-renderers'
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { agentSubagentRunsAtom } from '@/atoms'
import type { SDKMessage } from '@lume/shared'

/** 监听 document.documentElement 的 dark 类变化 */
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

/** 从消息流中构建 tool_use_id → tool_result 映射 */
export function buildToolResultMap(messages: SDKMessage[]): Map<string, { output: string; toolName: string }> {
  const map = new Map<string, { output: string; toolName: string }>()
  const toolNameById = new Map<string, string>()

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = (msg as { message?: { content?: unknown[] } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolNameById.set(block.id, block.name)
      }
    }
  }

  for (const msg of messages) {
    if (msg.type === 'tool_result' && msg.result) {
      map.set(msg.result.tool_use_id, {
        output: msg.result.output,
        toolName: msg.result.tool_name,
      })
      continue
    }

    if (msg.type !== 'user') continue
    const content = (msg as { message?: { content?: unknown[] } }).message?.content
    if (!Array.isArray(content)) continue

    for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      map.set(block.tool_use_id, {
        output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        toolName: toolNameById.get(block.tool_use_id) ?? '',
      })
    }
  }
  return map
}

interface SDKContentBlockProps {
  message: SDKMessage
  index: number
  animate?: boolean
  /** 完整消息列表，用于关联 tool_result */
  allMessages?: SDKMessage[]
  /** 是否正在流式输出 */
  isStreaming?: boolean
  threadId?: string
}

export function SDKContentBlock({ message, index, animate, allMessages, isStreaming, threadId }: SDKContentBlockProps) {
  const style = animate ? { animationDelay: `${index * 30}ms` } : undefined
  const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : ''

  const toolResultMap = useMemo(
    () => allMessages ? buildToolResultMap(allMessages) : new Map(),
    [allMessages]
  )

  if (message.type === 'user') {
    const content = message.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find((b: { type: string; text?: string }) => b.type === 'text') as { text: string } | undefined)?.text ?? ''
        : ''
    if (!text) return null
    return (
      <div className={cn('flex justify-end', cls)} style={style}>
        <div className="max-w-[80%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }

  if (message.type === 'assistant') {
    const blocks = (message.message?.content ?? []) as Array<
      { type: 'text'; text: string } |
      { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } |
      { type: 'thinking'; thinking: string }
    >
    return (
      <div className={cn('flex gap-3 min-w-0', cls)} style={style}>
        <div className="size-7 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Bot size={14} className="text-foreground/60" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          {blocks.map((block, i) => (
            <ContentBlockItem
              key={`${block.type}-${i}`}
              block={block}
              toolResultMap={toolResultMap}
              isStreaming={animate && isStreaming}
              threadId={threadId}
            />
          ))}
        </div>
      </div>
    )
  }

  if (message.type === 'tool_result') {
    return null
  }

  if (message.type === 'system') {
    const subtype = (message as SDKMessage & { subtype?: string }).subtype
    if (subtype === 'compact_boundary') {
      return (
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-border/40" />
          <span className="text-[11px] text-muted-foreground/60 px-2 py-0.5 rounded-full border border-border/30 bg-muted/20">上下文已压缩</span>
          <div className="flex-1 h-px bg-border/40" />
        </div>
      )
    }
    return null
  }

  return null
}

type ContentBlockType =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string }

function ContentBlockItem({
  block,
  toolResultMap,
  isStreaming,
  threadId,
}: {
  block: ContentBlockType
  toolResultMap: Map<string, { output: string; toolName: string }>
  isStreaming?: boolean
  threadId?: string
}) {
  const [collapsed, setCollapsed] = useState(true)

  if (block.type === 'text') {
    return <SmoothText text={block.text} isStreaming={isStreaming} />
  }

  if (block.type === 'thinking') {
    return (
      <div className="border-l-2 border-dashed border-foreground/20 pl-3">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 text-[12px] text-foreground/40 hover:text-foreground/60 transition-colors"
        >
          <ChevronRight size={12} className={cn('transition-transform', !collapsed && 'rotate-90')} />
          思考过程
        </button>
        {!collapsed && (
          <p className="mt-1 text-[12px] text-foreground/50 whitespace-pre-wrap leading-relaxed">{block.thinking}</p>
        )}
      </div>
    )
  }

  if (block.type === 'tool_use') {
    const toolResult = toolResultMap.get(block.id)
    let resultData: unknown = undefined
    if (toolResult) {
      try { resultData = JSON.parse(toolResult.output) }
      catch { resultData = toolResult.output }
    }
    return (
      <ToolUseBlock
        block={block}
        hasResult={toolResult !== undefined}
        resultData={resultData}
        threadId={threadId}
      />
    )
  }

  return null
}

const TOOL_ICONS: Partial<Record<string, LucideIcon>> = {
  Bash: Terminal, Read: FileText, Write: FilePlus, Edit: Pencil,
  Glob: FolderSearch, Grep: Search, WebSearch: Globe, WebFetch: Globe,
  Agent: Bot, Task: Cpu,
}

function ToolUseBlock({
  block, hasResult, resultData, threadId,
}: {
  block: { id: string; name: string; input: Record<string, unknown> }
  hasResult: boolean
  resultData: unknown
  threadId?: string
}) {
  const [collapsed, setCollapsed] = useState(true)
  const startedAtRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)

  useEffect(() => {
    if (hasResult) return
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200)
    return () => clearInterval(id)
  }, [hasResult])

  // Agent tool_use → SubagentInlinePanel (always, handles own loading state)
  if (block.name === 'Agent' && threadId) {
    const runs = subagentRunsMap[threadId] ?? []
    const run = runs.find(r => r.parentToolUseId === block.id)
    const description = (block.input.description ?? block.input.prompt ?? '') as string
    const agentType = (block.input as Record<string, unknown>).subagent_type as string | undefined
    const prompt = (block.input as Record<string, unknown>).prompt as string | undefined
    return (
      <SubagentInlinePanel
        runId={run?.runId}
        threadId={threadId}
        toolUseId={block.id}
        description={description}
        agentType={agentType}
        prompt={prompt}
      />
    )
  }

  const ToolIcon = TOOL_ICONS[block.name] ?? Wrench
  const elapsedSec = (elapsed / 1000).toFixed(1)

  return (
    <div className="rounded-xl border border-border/50 overflow-hidden bg-muted/20">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/60 hover:bg-muted/30 transition-colors"
      >
        <ChevronRight size={12} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        <ToolIcon size={12} className="text-foreground/50 shrink-0" />
        <span className="font-mono font-medium text-foreground/70">{block.name}</span>
        {hasResult ? (
          <span className="ml-auto text-[10px] text-muted-foreground/50">{elapsedSec}s</span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-blue-500/80">
            <Loader2 size={10} className="animate-spin" />
            {elapsedSec}s
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="border-t border-border/30 p-3">
          <ToolResultRenderer toolName={block.name} input={block.input} result={resultData} />
        </div>
      )}
    </div>
  )
}

// ── 不完整 Markdown 语法骨架组件 ──

function IncompleteLink() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted/30 animate-pulse text-muted-foreground/50 text-[13px]">
      <span className="inline-block w-16 h-3 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteImage() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-muted/30 animate-pulse text-muted-foreground/40 text-[12px]">
      <span className="inline-block w-4 h-4 rounded bg-muted/50" />
      <span className="inline-block w-12 h-3 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteTable() {
  return (
    <div className="my-1 rounded border border-border/20 overflow-hidden animate-pulse">
      <div className="flex gap-px bg-muted/20">
        <span className="flex-1 h-4 bg-muted/30" />
        <span className="flex-1 h-4 bg-muted/30" />
        <span className="flex-1 h-4 bg-muted/30" />
      </div>
      <div className="flex gap-px bg-muted/10">
        <span className="flex-1 h-4 bg-muted/20" />
        <span className="flex-1 h-4 bg-muted/20" />
        <span className="flex-1 h-4 bg-muted/20" />
      </div>
    </div>
  )
}

// ── 流式文本平滑渲染组件 ──

function SmoothText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming: !!isStreaming,
  })
  const isDark = useIsDark()

  return (
    <div className="min-w-0 w-full">
      <XMarkdown
        className="x-markdown text-[14px] leading-relaxed"
        rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      streaming={{
        hasNextChunk: !!isStreaming,
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
