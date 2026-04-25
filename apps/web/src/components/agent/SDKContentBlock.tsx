import { useState, useMemo, useRef, useEffect, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Sparkles,
  Terminal,
  FileText,
  FilePlus,
  Pencil,
  FolderSearch,
  Search,
  Globe,
  Cpu,
  Wrench,
  Loader2,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
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
      <div className={cn('flex justify-end gap-2', cls)} style={style}>
        <div className="max-w-[520px] rounded-[12px] rounded-tr-[10px] bg-[#e4ddff] px-3 py-2 text-[15px] font-medium leading-[22px] text-[#34384c] shadow-[0_1px_0_rgba(101,91,255,0.08)]">
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#9377f4] text-[15px] font-semibold text-white shadow-[0_4px_10px_rgba(118,97,230,0.18)]">
          L
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
      <div className={cn('flex min-w-0 gap-4', cls)} style={style}>
        <div className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-full border border-[#ded6ff] bg-white text-[#675cff] shadow-[0_2px_8px_rgba(103,92,255,0.07)]">
          <Sparkles size={21} strokeWidth={1.8} fill="#675cff" fillOpacity={0.08} />
        </div>
        <div className="min-w-0 flex-1 space-y-4 pt-2">
          {blocks.map((block, i) => (
            <ContentBlockItem
              key={`${block.type}-${i}`}
              block={block}
              toolResultMap={toolResultMap}
              isStreaming={animate && isStreaming}
              threadId={threadId}
            />
          ))}
          <MessageFeedbackActions text={extractAssistantText(blocks)} />
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
          <p className="mt-1 text-[12px] text-[#8a91a6] whitespace-pre-wrap leading-relaxed">{block.thinking}</p>
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
  Agent: Cpu, Task: Cpu,
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

  const toolSummary = getToolSummary(block)

  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[10px] border border-[#e1e4ec] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-[13px] text-[#59637a] transition-colors hover:bg-[#fbfcff]"
      >
        <ToolIcon size={15} className="shrink-0 text-[#68718a]" />
        <span className="font-mono font-semibold text-[#4d566f]">{formatToolName(block.name)}</span>
        {hasResult ? (
          <span className="rounded-full bg-[#f0efff] px-2 py-0.5 text-[12px] font-semibold text-[#7567ff]">已完成</span>
        ) : (
          <span className="rounded-full bg-[#f0efff] px-2 py-0.5 text-[12px] font-semibold text-[#7567ff]">
            执行中
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[#68718a]">{toolSummary}</span>
        {!hasResult && <Loader2 size={13} className="shrink-0 animate-spin text-[#7567ff]" />}
        {hasResult && <span className="text-[11px] text-[#9aa1b3]">{elapsedSec}s</span>}
        <ChevronDown size={16} className={cn('shrink-0 text-[#7f8794] transition-transform', !collapsed && 'rotate-180')} />
      </button>
      {!collapsed && (
        <div className="border-t border-[#edf0f5] p-3">
          <ToolResultRenderer toolName={block.name} input={block.input} result={resultData} />
        </div>
      )}
    </div>
  )
}

function extractAssistantText(blocks: ContentBlockType[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
}

function MessageFeedbackActions({ text }: { text: string }) {
  if (!text.trim()) return null

  const handleCopy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="flex items-center gap-4 pt-2 text-[#9aa1b3]">
      <button
        type="button"
        aria-label="复制消息"
        onClick={handleCopy}
        className="rounded-md p-1 transition-colors hover:bg-[#f4f5fa] hover:text-[#6770ff]"
      >
        <Copy size={19} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label="喜欢"
        className="rounded-md p-1 transition-colors hover:bg-[#f4f5fa] hover:text-[#6770ff]"
      >
        <ThumbsUp size={19} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label="不喜欢"
        className="rounded-md p-1 transition-colors hover:bg-[#f4f5fa] hover:text-[#6770ff]"
      >
        <ThumbsDown size={19} strokeWidth={1.8} />
      </button>
    </div>
  )
}

function formatToolName(name: string): string {
  const labels: Record<string, string> = {
    Bash: 'bash',
    Read: 'read_files',
    Write: 'write_file',
    Edit: 'edit_file',
    Glob: 'glob',
    Grep: 'grep',
    WebSearch: 'web_search',
    WebFetch: 'web_fetch',
    Agent: 'agent',
    Task: 'agent',
  }

  return labels[name] ?? name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
}

function getToolSummary(block: { name: string; input: Record<string, unknown> }): string {
  const input = block.input
  const primaryValue = formatInputValue(
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.command ??
    input.description ??
    input.prompt,
  )

  switch (block.name) {
    case 'Read':
      return primaryValue ? `正在读取 ${shortenToolValue(primaryValue)}` : '正在读取相关文件'
    case 'Write':
      return primaryValue ? `正在写入 ${shortenToolValue(primaryValue)}` : '正在写入文件'
    case 'Edit':
      return primaryValue ? `正在修改 ${shortenToolValue(primaryValue)}` : '正在修改文件'
    case 'Bash':
      return primaryValue ? shortenToolValue(primaryValue) : '正在执行命令'
    case 'Glob':
    case 'Grep':
      return primaryValue ? `正在搜索 ${shortenToolValue(primaryValue)}` : '正在搜索项目文件'
    case 'WebSearch':
    case 'WebFetch':
      return primaryValue ? `正在检索 ${shortenToolValue(primaryValue)}` : '正在检索网页内容'
    case 'Agent':
    case 'Task':
      return primaryValue ? shortenToolValue(primaryValue) : '正在执行子任务'
    default:
      return primaryValue ? shortenToolValue(primaryValue) : '正在执行工具调用'
  }
}

function formatInputValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formatInputValue).filter(Boolean).join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}

function shortenToolValue(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= 38) return compact
  return `${compact.slice(0, 35)}...`
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
        className="agent-message-markdown x-markdown text-[15px] leading-7 text-[#303445]"
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
