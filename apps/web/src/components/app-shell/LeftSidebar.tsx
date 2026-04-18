import { useAtom, useAtomValue } from 'jotai'
import { Plus, Settings, PanelLeftClose, PanelLeftOpen, FolderOpen, MoreHorizontal, Pin, PinOff, Pencil, Trash2, Check, X } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  agentThreadsAtom,
  agentStreamingStatesAtom,
  sidebarCollapsedAtom,
  tabsAtom,
  activeTabIdAtom,
  currentWorkspaceIdAtom,
} from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentThreadMeta } from '@lume/shared'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { WorkspaceSelector } from './WorkspaceSelector'

function groupByDate(items: AgentThreadMeta[]) {
  const pinned = items.filter((t) => t.pinned)
  const unpinned = items.filter((t) => !t.pinned)
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const yesterdayStart = todayStart - 86_400_000
  const today: AgentThreadMeta[] = []
  const yesterday: AgentThreadMeta[] = []
  const earlier: AgentThreadMeta[] = []
  for (const item of unpinned) {
    if (item.updatedAt >= todayStart) today.push(item)
    else if (item.updatedAt >= yesterdayStart) yesterday.push(item)
    else earlier.push(item)
  }
  return [
    ...(pinned.length ? [{ label: '置顶', items: pinned }] : []),
    ...(today.length ? [{ label: '今天', items: today }] : []),
    ...(yesterday.length ? [{ label: '昨天', items: yesterday }] : []),
    ...(earlier.length ? [{ label: '更早', items: earlier }] : []),
  ]
}

export function LeftSidebar() {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)

  useEffect(() => {
    sidecarCall<AgentThreadMeta[]>('agent:list-threads', {})
      .then((r) => setThreads(Array.isArray(r) ? r : []))
      .catch(console.error)
  }, [setThreads])

  const openThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((t) => t.id === thread.id)) {
      setTabs((prev) => [...prev, { id: thread.id, type: 'agent', title: thread.title, threadId: thread.id }])
    }
  }

  const handleNewThread = async () => {
    const meta = await sidecarCall<AgentThreadMeta>('agent:create-thread', {
      workspaceId: currentWorkspaceId ?? undefined,
    })
    setThreads((prev) => [meta, ...prev])
    setTabs((prev) => [...prev, { id: meta.id, type: 'agent', title: meta.title, threadId: meta.id }])
    setActiveTabId(meta.id)
  }

  const openSettings = () => {
    const id = '__settings__'
    setActiveTabId(id)
    if (!tabs.find((t) => t.id === id)) {
      setTabs((prev) => [...prev, { id, type: 'settings', title: '设置' }])
    }
  }

  const togglePin = async (thread: AgentThreadMeta) => {
    try {
      await sidecarCall('agent:toggle-pin-thread', { threadId: thread.id })
      setThreads((prev) => prev.map((t) => t.id === thread.id ? { ...t, pinned: !t.pinned } : t))
    } catch (err) {
      console.error('[LeftSidebar] 置顶失败:', err)
      toast.error('操作失败')
    }
  }

  const deleteThread = async (thread: AgentThreadMeta) => {
    if (!confirm(`确认删除会话「${thread.title}」？`)) return
    try {
      await sidecarCall('agent:delete-thread', { threadId: thread.id })
      setThreads((prev) => prev.filter((t) => t.id !== thread.id))
      setTabs((prev) => prev.filter((t) => t.id !== thread.id))
      if (activeTabId === thread.id) {
        setActiveTabId(null)
      }
      toast.success('已删除')
    } catch (err) {
      console.error('[LeftSidebar] 删除失败:', err)
      toast.error('删除失败')
    }
  }

  const renameThread = async (thread: AgentThreadMeta, newTitle: string) => {
    const trimmed = newTitle.trim()
    if (!trimmed || trimmed === thread.title) return
    try {
      await sidecarCall('agent:update-thread-title', { threadId: thread.id, title: trimmed })
      setThreads((prev) => prev.map((t) => t.id === thread.id ? { ...t, title: trimmed } : t))
      setTabs((prev) => prev.map((t) => t.id === thread.id ? { ...t, title: trimmed } : t))
    } catch (err) {
      console.error('[LeftSidebar] 重命名失败:', err)
      toast.error('重命名失败')
    }
  }

  const groups = groupByDate(
    currentWorkspaceId
      ? threads.filter((t) => !t.workspaceId || t.workspaceId === currentWorkspaceId)
      : threads
  )

  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl" style={{ width: 48, flexShrink: 0 }}>
        <div className="pt-[50px]" />
        <button onClick={() => setCollapsed(false)} className="p-2 mt-2 rounded-[10px] text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground transition-colors">
          <PanelLeftOpen size={18} />
        </button>
        <button onClick={() => setCollapsed(false)} className="p-2 mt-2 rounded-[10px] text-foreground/50 hover:bg-foreground/[0.04] hover:text-foreground/70 transition-colors" title="工作区">
          <FolderOpen size={16} />
        </button>
        <button onClick={handleNewThread} className="p-2 mt-2 rounded-[10px] text-foreground/70 bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors border border-dashed border-foreground/10">
          <Plus size={16} />
        </button>
        <div className="flex-1" />
        <button onClick={openSettings} className="p-2 mb-3 rounded-[10px] text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground transition-colors">
          <Settings size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl" style={{ width: 260, minWidth: 180, flexShrink: 1 }}>
      <div className="pt-[50px] flex items-center justify-between px-3 pr-1">
        <span className="text-[13px] font-semibold text-foreground/70">Lume</span>
        <button onClick={() => setCollapsed(true)} className="size-8 flex items-center justify-center rounded-[10px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors">
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* 工作区选择器 */}
      <div className="px-3 pt-2">
        <WorkspaceSelector />
      </div>

      <div className="px-3 pt-2">
        <button
          onClick={handleNewThread}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium text-foreground/70 bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors border border-dashed border-foreground/10 hover:border-foreground/20"
        >
          <Plus size={14} />
          <span>新会话</span>
        </button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 pt-2 pb-3">
          {groups.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">{group.label}</div>
              {group.items.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={activeTabId === thread.id}
                  isRunning={streamingStates[thread.id] === 'streaming'}
                  onOpen={openThread}
                  onTogglePin={togglePin}
                  onDelete={deleteThread}
                  onRename={renameThread}
                />
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="px-3 pb-3">
        <button
          onClick={openSettings}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] transition-colors text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground text-[13px]"
        >
          <Settings size={15} />
          <span>设置</span>
        </button>
      </div>
    </div>
  )
}

function ThreadItem({
  thread,
  isActive,
  isRunning,
  onOpen,
  onTogglePin,
  onDelete,
  onRename,
}: {
  thread: AgentThreadMeta
  isActive: boolean
  isRunning: boolean
  onOpen: (t: AgentThreadMeta) => void
  onTogglePin: (t: AgentThreadMeta) => void
  onDelete: (t: AgentThreadMeta) => void
  onRename: (t: AgentThreadMeta, title: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.title)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = () => {
    onRename(thread, draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-3 py-[7px] rounded-[10px] bg-foreground/[0.04]">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setEditing(false); setDraft(thread.title) }
          }}
          className="flex-1 bg-transparent outline-none text-[13px] text-foreground"
        />
        <button onClick={commitRename} className="size-5 flex items-center justify-center text-green-500 hover:bg-green-500/10 rounded"><Check size={12} /></button>
        <button onClick={() => { setEditing(false); setDraft(thread.title) }} className="size-5 flex items-center justify-center text-foreground/40 hover:bg-foreground/10 rounded"><X size={12} /></button>
      </div>
    )
  }

  return (
    <div className="relative group">
      <button
        onClick={() => onOpen(thread)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-[7px] rounded-[10px] transition-colors duration-100 text-left text-[13px]',
          isActive
            ? 'bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
            : 'text-foreground/80 hover:bg-foreground/[0.04]'
        )}
      >
        {isRunning && (
          <span className="relative flex-shrink-0 size-2">
            <span className="absolute inset-0 rounded-full bg-blue-500/60 animate-ping" />
            <span className="relative block size-2 rounded-full bg-blue-500" />
          </span>
        )}
        {thread.pinned && !isRunning && <Pin size={10} className="text-foreground/40 flex-shrink-0" />}
        <span className="flex-1 truncate">{thread.title}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2 size-6 flex items-center justify-center rounded',
          'text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          menuOpen && 'opacity-100'
        )}
      >
        <MoreHorizontal size={13} />
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-1 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-border/60 bg-popover shadow-lg py-1"
        >
          <MenuItem icon={thread.pinned ? <PinOff size={13} /> : <Pin size={13} />} onClick={() => { onTogglePin(thread); setMenuOpen(false) }}>
            {thread.pinned ? '取消置顶' : '置顶'}
          </MenuItem>
          <MenuItem icon={<Pencil size={13} />} onClick={() => { setEditing(true); setMenuOpen(false) }}>
            重命名
          </MenuItem>
          <MenuItem icon={<Trash2 size={13} />} onClick={() => { onDelete(thread); setMenuOpen(false) }} destructive>
            删除
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  icon,
  onClick,
  destructive,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors',
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
      )}
    >
      {icon}
      {children}
    </button>
  )
}
