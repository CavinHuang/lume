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
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-11 items-center gap-2 rounded-full border px-4 text-[13px] font-medium transition-colors',
          open
            ? 'border-[color:color-mix(in_oklab,var(--brand)_20%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--text-1)]'
            : 'border-[color:color-mix(in_oklab,var(--border-strong)_62%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_92%,transparent)] text-[var(--text-2)] hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]',
        )}
        title="选择工作区"
      >
        <FolderOpen size={14} className="text-[var(--text-3)]" />
        <span className="max-w-[180px] truncate">{selected?.name ?? '当前工作区'}</span>
        <ChevronDown size={12} className="text-[var(--text-3)]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-3 w-72 overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_74%,transparent)] bg-[var(--surface-1)] shadow-[0_28px_52px_-34px_hsl(var(--shadow-panel)/0.48)]">
          <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-3">
            <div className="flex items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-3 py-2">
              <Search size={13} className="text-[var(--text-3)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索工作区..."
                className="flex-1 bg-transparent text-[12px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[220px] overflow-y-auto p-2">
            {filtered.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => {
                  onSelect(ws.id)
                  setOpen(false)
                  setSearch('')
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left text-[13px] transition-colors',
                  ws.id === selectedId
                    ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--text-1)]'
                    : 'text-[var(--text-2)] hover:bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] hover:text-[var(--text-1)]'
                )}
              >
                <FolderOpen size={13} className="shrink-0 text-[var(--text-3)]" />
                <span className="truncate flex-1">{ws.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--text-3)]">无匹配工作区</div>
            )}
          </div>
          <div className="border-t border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setSearch('')
                onCreateWorkspaceClick()
              }}
              className="flex w-full items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left text-[13px] text-[var(--text-2)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] hover:text-[var(--text-1)]"
            >
              <Plus size={13} className="text-[var(--text-3)]" />
              新建工作区
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
