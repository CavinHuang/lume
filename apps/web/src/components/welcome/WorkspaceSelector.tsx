import { useState, useRef, useEffect } from 'react'
import { ChevronDown, FolderOpen, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentWorkspace } from '@lume/shared'

interface WorkspaceSelectorProps {
  workspaces: AgentWorkspace[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreateWorkspaceClick: () => void
}

export function WorkspaceSelector({
  workspaces,
  selectedId,
  onSelect,
  onCreateWorkspaceClick,
}: WorkspaceSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = workspaces.find((ws) => ws.id === selectedId)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = search.trim()
    ? workspaces.filter((ws) => ws.name.toLowerCase().includes(search.toLowerCase()))
    : workspaces

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors text-[12px]"
        title="选择工作区"
      >
        <FolderOpen size={14} />
        <span className="max-w-[80px] truncate">{selected?.name ?? '默认'}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1">
              <Search size={12} className="text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索工作区..."
                className="flex-1 bg-transparent outline-none text-[12px] placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[160px] overflow-y-auto p-1">
            {filtered.map((ws) => (
              <button
                key={ws.id}
                onClick={() => { onSelect(ws.id); setOpen(false); setSearch('') }}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md text-left transition-colors',
                  ws.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
                )}
              >
                <FolderOpen size={12} className="flex-shrink-0" />
                <span className="truncate flex-1">{ws.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-[12px] text-muted-foreground text-center">无匹配工作区</div>
            )}
          </div>
          <div className="border-t border-border p-1">
            <button
              onClick={() => {
                setOpen(false)
                setSearch('')
                onCreateWorkspaceClick()
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md hover:bg-muted/50 text-muted-foreground text-left transition-colors"
            >
              <Plus size={12} />
              新建工作区
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
