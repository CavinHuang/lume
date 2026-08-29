import { useState, useRef, useEffect } from 'react'
import { ChevronDown, FolderOpen, MessageCircle, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentWorkspace } from '@lume/shared'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface WorkspaceSelectorProps {
  workspaces: AgentWorkspace[]
  selectedId: string | null
  onSelect: (id: string | null) => void
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
      <Button
                variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors',
          open
            ? 'bg-[var(--surface-2)] text-[var(--text-1)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
        )}
        title="选择项目或普通会话"
      >
        {selected ? <FolderOpen size={13} className="shrink-0 text-[var(--text-3)]" /> : <MessageCircle size={13} className="shrink-0 text-[var(--text-3)]" />}
        <span className="min-w-0 max-w-[200px] truncate text-[var(--text-1)]">{selected?.name ?? '普通会话'}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--text-3)]" />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_74%,transparent)] bg-[var(--surface-1)] shadow-[0_28px_52px_-34px_hsl(var(--shadow-panel)/0.48)]">
          <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-3">
            <div className="flex items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-3 py-2">
              <Search size={13} className="text-[var(--text-3)]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索项目..."
                className="flex-1 border-0 bg-transparent px-0 text-[12px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[220px] overflow-y-auto p-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                onSelect(null)
                setOpen(false)
                setSearch('')
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left text-[13px] transition-colors',
                selectedId === null
                  ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--text-1)]'
                  : 'text-[var(--text-2)] hover:bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] hover:text-[var(--text-1)]'
              )}
            >
              <MessageCircle size={13} className="shrink-0 text-[var(--text-3)]" />
              <span className="truncate flex-1">普通会话</span>
            </Button>
            {filtered.map((ws) => (
              <Button
                variant="ghost"
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
              </Button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--text-3)]">无匹配项目</div>
            )}
          </div>
          <div className="border-t border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-2">
            <Button
                variant="ghost"
              type="button"
              onClick={() => {
                setOpen(false)
                setSearch('')
                onCreateWorkspaceClick()
              }}
              className="flex w-full items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left text-[13px] text-[var(--text-2)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] hover:text-[var(--text-1)]"
            >
              <Plus size={13} className="text-[var(--text-3)]" />
              添加项目
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
