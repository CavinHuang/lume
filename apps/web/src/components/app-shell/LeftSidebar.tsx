import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  SquarePen, Search, Box, Clock,
  ChevronLeft, ChevronRight,
  Minimize2, Maximize2, Filter, FolderPlus, Folder,
  Settings, MoreHorizontal, Pin, PinOff, Pencil, Trash2, Check, X,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  agentThreadsAtom,
  agentStreamingStatesAtom,
  sidebarCollapsedAtom,
  tabsAtom,
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  agentWorkspacesAtom,
  commandPaletteOpenAtom,
} from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'
import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'

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
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const setOpenCommandPalette = useSetAtom(commandPaletteOpenAtom)
  const [allExpanded, setAllExpanded] = useState(false)

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

  // 工作区操作
  const handleCreateWorkspace = async () => {
    const name = prompt('工作区名称：')
    if (!name?.trim()) return
    try {
      const ws = await sidecarCall<AgentWorkspace>('agent:create-workspace', { name: name.trim() })
      setWorkspaces((prev) => [...prev, ws])
      setCurrentWorkspaceId(ws.id)
      toast.success(`已创建工作区「${ws.name}」`)
    } catch (err) {
      console.error('[LeftSidebar] 创建工作区失败:', err)
      toast.error('创建失败')
    }
  }

  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl" style={{ width: 48, flexShrink: 0 }}>
        <div className="pt-2" />

        {/* 操作图标 */}
        <div className="flex flex-col items-center gap-0.5 px-2">
          <button onClick={handleNewThread} title="新建聊天" className="size-8 flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors">
            <SquarePen size={16} />
          </button>
          <button onClick={() => setOpenCommandPalette(true)} title="搜索" className="size-8 flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors">
            <Search size={16} />
          </button>
          <button title="技能" className="size-8 flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors">
            <Box size={16} />
          </button>
          <button title="自动化（即将推出）" className="size-8 flex items-center justify-center rounded-md text-foreground/20 cursor-not-allowed" disabled>
            <Clock size={16} />
          </button>
        </div>

        {/* 分隔线 */}
        <div className="w-6 h-px bg-foreground/10 my-2" />

        {/* 工作区图标 */}
        <div className="flex flex-col items-center gap-0.5 px-2">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => setCurrentWorkspaceId(ws.id)}
              title={ws.name}
              className={cn(
                'size-8 flex items-center justify-center rounded-md transition-colors',
                currentWorkspaceId === ws.id
                  ? 'bg-foreground/[0.08] text-foreground'
                  : 'text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/70'
              )}
            >
              <Folder size={16} />
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <div className="pb-3 px-2 flex flex-col items-center gap-0.5">
          <button onClick={() => setCollapsed(false)} title="展开侧边栏" className="size-8 flex items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/70 transition-colors">
            <ChevronRight size={16} />
          </button>
          <button onClick={openSettings} title="设置" className="size-8 flex items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/70 transition-colors">
            <Settings size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl" style={{ width: 260, minWidth: 180, flexShrink: 1 }}>
      <div className="pt-2" />

      {/* 顶部操作列表 */}
      <div className="px-3 space-y-0.5">
        <SidebarAction icon={<SquarePen size={17} />} label="新建聊天" onClick={handleNewThread} />
        <SidebarAction icon={<Search size={17} />} label="搜索" onClick={() => setOpenCommandPalette(true)} />
        <SidebarAction icon={<Box size={17} />} label="技能" onClick={() => {}} />
        <SidebarAction icon={<Clock size={17} />} label="自动化" disabled badge="即将推出" />
      </div>

      {/* 工作区区域 — 手风琴模式 */}
      <div className="mt-5 px-3">
        <div className="flex items-center justify-between px-2 mb-1">
          <span className="text-[13px] font-semibold text-foreground">工作区</span>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setAllExpanded((v) => !v)} className={cn("size-6 flex items-center justify-center rounded-[5px] transition-colors", allExpanded ? "text-foreground/60 bg-foreground/[0.06]" : "text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/60")} title={allExpanded ? '收起全部' : '展开全部'}>
              <span className="relative size-[14px]">
                <Maximize2 size={14} className={cn("absolute inset-0 transition-opacity duration-200", allExpanded ? "opacity-0" : "opacity-100")} />
                <Minimize2 size={14} className={cn("absolute inset-0 transition-opacity duration-200", allExpanded ? "opacity-100" : "opacity-0")} />
              </span>
            </button>
            <button className="size-6 flex items-center justify-center rounded-[5px] text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors" title="筛选">
              <Filter size={14} />
            </button>
            <button onClick={handleCreateWorkspace} className="size-6 flex items-center justify-center rounded-[5px] text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors" title="新建工作区">
              <FolderPlus size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* 工作区手风琴列表 */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 pb-3">
          {workspaces.map((ws) => {
            const isExpanded = allExpanded || currentWorkspaceId === ws.id
            const wsThreads = threads.filter((t) => !t.workspaceId || t.workspaceId === ws.id)
            const count = wsThreads.length
            const wsGroups = groupByDate(wsThreads)

            return (
              <div key={ws.id} className="mb-1">
                {/* 工作区标题行 */}
                <button
                  onClick={() => {
                    if (allExpanded) {
                      setAllExpanded(false)
                      setCurrentWorkspaceId(ws.id)
                    } else {
                      setCurrentWorkspaceId(isExpanded ? null : ws.id)
                    }
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-[7px] rounded-lg text-[13px] transition-colors',
                    isExpanded
                      ? 'bg-foreground/[0.08] text-foreground'
                      : 'text-foreground/70 hover:bg-foreground/[0.04]'
                  )}
                >
                  <ChevronRight
                    size={12}
                    className={cn(
                      'flex-shrink-0 text-foreground/30 transition-transform duration-150',
                      isExpanded && 'rotate-90'
                    )}
                  />
                  <Folder size={14} className={cn('flex-shrink-0', isExpanded ? 'text-primary' : 'text-foreground/40')} />
                  <span className="flex-1 truncate text-left">{ws.name}</span>
                  {count > 0 && <span className="text-[11px] text-foreground/35 flex-shrink-0">{count}</span>}
                </button>

                {/* 展开的线程列表 */}
                <div
                  className={cn(
                    "ml-3 border-l border-foreground/10 pl-2 overflow-hidden transition-all duration-200 ease-in-out",
                    isExpanded && wsGroups.length > 0 ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0 border-l-transparent"
                  )}
                >
                  {wsGroups.map((group) => (
                    <div key={group.label}>
                      <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">{group.label}</div>
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
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {/* 底部：设置 + 收缩按钮 */}
      <div className="px-3 pb-3 flex items-center">
        <button
          onClick={openSettings}
          className="flex-1 flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground text-[13px]"
        >
          <Settings size={15} />
          <span>设置</span>
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="size-8 flex items-center justify-center rounded-md text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/60 transition-colors"
          title="收起侧边栏"
        >
          <ChevronLeft size={16} />
        </button>
      </div>
    </div>
  )
}

/* ——— 顶部操作项 ——— */
function SidebarAction({
  icon,
  label,
  onClick,
  disabled,
  badge,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  badge?: string
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={cn(
        'w-full flex items-center gap-3 px-2 py-[9px] rounded-lg text-[13px] transition-colors',
        disabled
          ? 'text-foreground/25 cursor-not-allowed'
          : 'text-foreground/80 hover:bg-foreground/[0.04]'
      )}
      disabled={disabled}
    >
      {icon}
      <span>{label}</span>
      {badge && (
        <span className="ml-auto text-[10px] bg-foreground/[0.06] text-foreground/40 px-1.5 py-0.5 rounded">
          {badge}
        </span>
      )}
    </button>
  )
}

/* ——— 线程列表项 ——— */
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
      <div className="flex items-center gap-1 px-3 py-[7px] rounded-lg bg-foreground/[0.04]">
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
          'w-full flex items-center gap-2 px-3 py-[7px] rounded-lg transition-colors duration-100 text-left text-[13px]',
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
