import { FolderOpen, ChevronDown, MessageCircle } from 'lucide-react'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef } from 'react'

interface Props {
  onChange: (workspaceId: string | null) => void
}

/**
 * 快速输入窗口顶部的紧凑 workspace 切换器。只读切换（不含新建/重命名/删除，
 * 那些在主窗口完成）。切换即触发父级 onChange。
 */
export function QuickInputWorkspaceSelector({ onChange }: Props) {
  const [workspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = workspaces.find((w) => w.id === currentId)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-foreground/70 hover:bg-foreground/[0.06]"
      >
        <FolderOpen size={13} className="text-foreground/50" />
        <span className="max-w-[120px] truncate">{current?.name ?? '普通会话'}</span>
        <ChevronDown size={11} className={cn('text-foreground/40 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-border/60 bg-popover shadow-lg py-1">
          <Button
            variant="ghost"
            onClick={() => {
              setCurrentId(null)
              onChange(null)
              setOpen(false)
            }}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] justify-start',
              currentId === null ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/70 hover:bg-foreground/[0.04]',
            )}
          >
            <MessageCircle size={12} className="text-foreground/40" />
            <span>普通会话</span>
          </Button>
          {workspaces.map((ws) => (
            <Button
              key={ws.id}
              variant="ghost"
              onClick={() => {
                setCurrentId(ws.id)
                onChange(ws.id)
                setOpen(false)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] justify-start',
                ws.id === current?.id ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/70 hover:bg-foreground/[0.04]',
              )}
            >
              <FolderOpen size={12} className="text-foreground/40" />
              <span className="truncate">{ws.name}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
