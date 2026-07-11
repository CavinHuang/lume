import { useAtom, useAtomValue } from 'jotai'
import { Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  commandPaletteOpenAtom,
  tabsAtom,
  activeTabIdAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
} from '@/atoms'
import { cn } from '@/lib/utils'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom)
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useAtom(activeTabIdAtom)[1]

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Debounce search query by 150ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(timer)
  }, [query])

  const results = useMemo(() => {
    if (!debouncedQuery.trim()) return []
    const q = debouncedQuery.toLowerCase()
    return threads
      .filter((t) => t.title.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
  }, [debouncedQuery, threads])

  const wsMap = useMemo(() => {
    const m = new Map<string, AgentWorkspace>()
    for (const ws of workspaces) m.set(ws.id, ws)
    return m
  }, [workspaces])

  const closePalette = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setOpen(false)
      setClosing(false)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }, 100) // matches animate-out duration
  }, [setOpen])

  const openThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((t) => t.id === thread.id)) {
      setTabs((prev) => [
        ...prev,
        { id: thread.id, type: 'agent' as const, title: thread.title, threadId: thread.id, ...(thread.parentThreadId ? { readOnly: true } : {}) },
      ])
    }
    closePalette()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePalette()
      return
    }
    if (!results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (i + 1) % results.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (i - 1 + results.length) % results.length)
      return
    }
    if (e.key === 'Enter') {
      openThread(results[selectedIndex])
    }
  }

  // 打开时重置状态并聚焦
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement
      setQuery('')
      setDebouncedQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 结果变化时重置选中索引
  useEffect(() => {
    setSelectedIndex(0)
  }, [results.length])

  // 选中项滚动到可视区
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open && !closing) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      {/* 遮罩 */}
      <div
        className={cn(
          "absolute inset-0 bg-black/50",
          closing ? "animate-out fade-out duration-100" : "animate-in fade-in duration-150"
        )}
        onClick={closePalette}
      />

      {/* 弹窗 */}
      <div className={cn(
        "relative w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden",
        closing
          ? "animate-out fade-out zoom-out-95 duration-100"
          : "animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-150"
      )}>
        {/* 搜索输入 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground flex-shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索线程标题..."
            className="flex-1 border-0 bg-transparent px-0 text-sm shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          />
          {query && results.length > 0 && (
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {results.length} 个结果
            </span>
          )}
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
            Esc
          </kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[300px] overflow-y-auto p-1">
          {query.trim() === '' ? (
            <EmptyState />
          ) : results.length === 0 ? (
            <NoResults />
          ) : (
            results.map((thread, i) => (
              <ResultItem
                key={thread.id}
                thread={thread}
                workspace={thread.workspaceId ? wsMap.get(thread.workspaceId) : undefined}
                isSelected={i === selectedIndex}
                onClick={() => openThread(thread)}
                onMouseEnter={() => setSelectedIndex(i)}
              />
            ))
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
          <span>↑↓ 导航</span>
          <span>↵ 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}

/* ——— 子组件 ——— */

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <Search size={28} className="text-muted-foreground/40" strokeWidth={1.5} />
      <p className="text-sm text-muted-foreground mt-2">输入关键词搜索所有线程</p>
    </div>
  )
}

function NoResults() {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <p className="text-sm text-muted-foreground">未找到匹配的线程</p>
      <p className="text-xs text-muted-foreground/70 mt-1">尝试其他关键词</p>
    </div>
  )
}

function ResultItem({
  thread,
  workspace,
  isSelected,
  onClick,
  onMouseEnter,
}: {
  thread: AgentThreadMeta
  workspace?: AgentWorkspace
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
}) {
  return (
    <Button
                variant="ghost"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors duration-100',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate">{thread.title}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {relativeTime(thread.updatedAt)}
        </div>
      </div>
      {workspace && (
        <span className="ml-2 flex-shrink-0 text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {workspace.name}
        </span>
      )}
    </Button>
  )
}
