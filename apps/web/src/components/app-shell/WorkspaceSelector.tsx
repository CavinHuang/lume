/**
 * WorkspaceSelector - 侧边栏工作区下拉选择器
 *
 * 触发按钮显示当前工作区名称，点击展开下拉列表，
 * 支持切换、新建、重命名、删除工作区。
 */

import { useState, useEffect, useRef } from 'react'
import { FolderOpen, ChevronDown, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtom, useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, agentWorkspaceCapabilitiesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentWorkspace } from '@lume/shared'
import { toast } from 'sonner'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'

export function WorkspaceSelector() {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const capabilities = useAtomValue(agentWorkspaceCapabilitiesAtom)

  const [open, setOpen] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const containerRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditingId(null)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // 自动聚焦编辑输入框
  useEffect(() => {
    if (editingId) {
      requestAnimationFrame(() => {
        editInputRef.current?.focus()
        editInputRef.current?.select()
      })
    }
  }, [editingId])

  // ——— 重命名 ———
  const handleRename = async () => {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) { setEditingId(null); return }
    try {
      await sidecarCall('agent:update-workspace', { id: editingId, name: trimmed })
      setWorkspaces((prev) => prev.map((w) => w.id === editingId ? { ...w, name: trimmed } : w))
    } catch (err) {
      console.error('[WorkspaceSelector] 重命名失败:', err)
      toast.error('重命名失败')
    }
    setEditingId(null)
  }

  // ——— 删除 ———
  const handleDelete = async (ws: AgentWorkspace) => {
    if (workspaces.length <= 1) {
      toast.error('至少保留一个工作区')
      return
    }
    if (!confirm(`确认删除工作区「${ws.name}」？`)) return
    try {
      await sidecarCall('agent:delete-workspace', { id: ws.id })
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id))
      if (currentId === ws.id) {
        const next = workspaces.find((w) => w.id !== ws.id)
        setCurrentId(next?.id ?? null)
      }
      toast.success('已删除')
    } catch (err) {
      console.error('[WorkspaceSelector] 删除失败:', err)
      toast.error('删除失败')
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* ——— 触发按钮 ——— */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] transition-colors',
          'text-foreground/70 hover:bg-foreground/[0.06]',
          open && 'bg-foreground/[0.06]'
        )}
      >
        <FolderOpen size={14} className="text-foreground/50 flex-shrink-0" />
        <span className="flex-1 truncate text-left font-medium">
          {current?.name ?? '选择工作区'}
        </span>
        <ChevronDown
          size={12}
          className={cn(
            'text-foreground/40 transition-transform flex-shrink-0',
            open && 'rotate-180'
          )}
        />
      </button>

      {/* ——— 下拉面板 ——— */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border border-border/60 bg-popover shadow-lg overflow-hidden">
          {/* 列表头部 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
            <span className="text-[11px] font-medium text-foreground/40 select-none">工作区</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                setCreateWorkspaceOpen(true)
              }}
              className="size-5 flex items-center justify-center rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.06] transition-colors"
              title="新建工作区"
            >
              <Plus size={13} />
            </button>
          </div>

          {/* 工作区列表 */}
          <div className="max-h-[200px] overflow-y-auto py-1">
            {workspaces.map((ws) => {
              const isSelected = ws.id === currentId
              const caps = capabilities[ws.slug]
              const mcpCount = caps?.mcpServers.filter((s) => s.enabled).length ?? 0
              const skillCount = caps?.skills.length ?? 0

              // 重命名模式
              if (editingId === ws.id) {
                return (
                  <div key={ws.id} className="flex items-center gap-1.5 px-3 py-[6px] mx-1">
                    <FolderOpen size={13} className="text-foreground/40 flex-shrink-0" />
                    <input
                      ref={editInputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={handleRename}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 bg-transparent text-[12px] text-foreground border-b border-primary/50 outline-none"
                      maxLength={50}
                    />
                    <button onClick={handleRename} className="size-5 flex items-center justify-center text-green-500 hover:bg-green-500/10 rounded">
                      <Check size={11} />
                    </button>
                    <button onClick={() => setEditingId(null)} className="size-5 flex items-center justify-center text-foreground/40 hover:bg-foreground/10 rounded">
                      <X size={11} />
                    </button>
                  </div>
                )
              }

              return (
                <div key={ws.id} className="group relative mx-1">
                  <button
                    onClick={() => {
                      setCurrentId(ws.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-[6px] rounded-md text-[12px] text-left transition-colors duration-100',
                      isSelected
                        ? 'bg-foreground/[0.08] text-foreground font-medium'
                        : 'text-foreground/70 hover:bg-foreground/[0.04]'
                    )}
                  >
                    <FolderOpen
                      size={13}
                      className={cn('flex-shrink-0', isSelected ? 'text-primary' : 'text-foreground/40')}
                    />
                    <span className="flex-1 truncate">{ws.name}</span>
                    {(mcpCount > 0 || skillCount > 0) && (
                      <span className="text-[10px] text-foreground/30 flex items-center gap-1 flex-shrink-0 mr-8">
                        {mcpCount > 0 && <span>{mcpCount} MCP</span>}
                        {skillCount > 0 && <span>{skillCount} Skill</span>}
                      </span>
                    )}
                    {isSelected && <Check size={12} className="text-primary flex-shrink-0" />}
                  </button>

                  {/* hover 操作按钮 */}
                  <div className={cn(
                    'absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5',
                    'opacity-0 group-hover:opacity-100 transition-opacity'
                  )}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(ws.id)
                        setEditName(ws.name)
                      }}
                      className="size-5 flex items-center justify-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70"
                      title="重命名"
                    >
                      <Pencil size={10} />
                    </button>
                    {workspaces.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(ws)
                        }}
                        className="size-5 flex items-center justify-center rounded text-foreground/40 hover:bg-destructive/10 hover:text-destructive"
                        title="删除"
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {workspaces.length === 0 && (
              <div className="px-3 py-3 text-center text-[11px] text-foreground/30">暂无工作区</div>
            )}
          </div>

          {/* 底部新建入口 */}
          <div className="border-t border-border/40">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                setCreateWorkspaceOpen(true)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/50 hover:bg-foreground/[0.04] hover:text-foreground/70 transition-colors"
            >
              <Plus size={12} />
              新建工作区
            </button>
          </div>
        </div>
      )}

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={(workspace) => {
          setWorkspaces((prev) => (prev.some((item) => item.id === workspace.id) ? prev : [...prev, workspace]))
          setCurrentId(workspace.id)
        }}
      />
    </div>
  )
}
