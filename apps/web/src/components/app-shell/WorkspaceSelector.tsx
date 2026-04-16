/**
 * WorkspaceSelector - 侧边栏工作区选择器（参考 Proma）
 *
 * 垂直列表展示工作区，支持选择/新建/重命名/删除。
 * 集成在 LeftSidebar 顶部，仅展开态显示。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { FolderOpen, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtom, useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, agentWorkspaceCapabilitiesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentWorkspace, WorkspaceCapabilities } from '@lume/shared'
import { toast } from 'sonner'

export function WorkspaceSelector() {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const capabilities = useAtomValue(agentWorkspaceCapabilitiesAtom)

  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) createInputRef.current?.focus()
  }, [creating])

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    if (!name) { setCreating(false); return }
    try {
      const ws = await sidecarCall<AgentWorkspace>('agent:create-workspace', { name })
      setWorkspaces((prev) => [...prev, ws])
      setCurrentId(ws.id)
      toast.success(`已创建工作区「${ws.name}」`)
    } catch (err) {
      console.error('[WorkspaceSelector] 创建失败:', err)
      toast.error('创建失败')
    }
    setCreating(false)
    setCreateName('')
  }, [createName, setWorkspaces, setCurrentId])

  const handleDelete = useCallback(async (ws: AgentWorkspace) => {
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
  }, [workspaces, currentId, setWorkspaces, setCurrentId])

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/40 bg-foreground/[0.02]">
        <span className="text-[11px] font-medium text-foreground/50 select-none">工作区</span>
        <button
          onClick={() => { setCreating(true); setCreateName('') }}
          className="size-5 flex items-center justify-center rounded text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.06] transition-colors"
          title="新建工作区"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 列表 */}
      <div className="max-h-[120px] overflow-y-auto scrollbar-thin">
        {workspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            isSelected={ws.id === currentId}
            caps={capabilities[ws.slug]}
            onSelect={() => setCurrentId(ws.id)}
            onDelete={() => handleDelete(ws)}
            onRename={(newName) => handleRename(ws, newName, setWorkspaces)}
          />
        ))}

        {/* 内联创建 */}
        {creating && (
          <div className="flex items-center gap-1.5 px-2 py-[5px]">
            <FolderOpen size={13} className="text-foreground/40 flex-shrink-0" />
            <input
              ref={createInputRef}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') { setCreating(false); setCreateName('') }
              }}
              placeholder="工作区名称"
              className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-foreground placeholder:text-foreground/30"
            />
            <button
              onClick={handleCreate}
              className="size-5 flex items-center justify-center text-green-500 hover:bg-green-500/10 rounded transition-colors"
            >
              <Check size={11} />
            </button>
            <button
              onClick={() => { setCreating(false); setCreateName('') }}
              className="size-5 flex items-center justify-center text-foreground/40 hover:bg-foreground/10 rounded transition-colors"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {workspaces.length === 0 && !creating && (
          <div className="px-3 py-3 text-center text-[11px] text-foreground/30">暂无工作区</div>
        )}
      </div>
    </div>
  )
}

// ——— 工作区行 ———

function WorkspaceItem({
  workspace,
  isSelected,
  caps,
  onSelect,
  onDelete,
  onRename,
}: {
  workspace: AgentWorkspace
  isSelected: boolean
  caps?: WorkspaceCapabilities
  onSelect: () => void
  onDelete: () => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(workspace.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commitRename = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== workspace.name) onRename(trimmed)
    setEditing(false)
    setDraft(workspace.name)
  }

  const mcpCount = caps?.mcpServers.filter((s) => s.enabled).length ?? 0
  const skillCount = caps?.skills.length ?? 0

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-[5px]">
        <FolderOpen size={13} className="text-foreground/40 flex-shrink-0" />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setEditing(false); setDraft(workspace.name) }
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-foreground"
        />
        <button onClick={commitRename} className="size-5 flex items-center justify-center text-green-500 hover:bg-green-500/10 rounded"><Check size={11} /></button>
        <button onClick={() => { setEditing(false); setDraft(workspace.name) }} className="size-5 flex items-center justify-center text-foreground/40 hover:bg-foreground/10 rounded"><X size={11} /></button>
      </div>
    )
  }

  return (
    <div className="group relative">
      <button
        onClick={onSelect}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[12px] text-left transition-colors duration-100',
          isSelected
            ? 'bg-foreground/[0.08] text-foreground font-medium'
            : 'text-foreground/70 hover:bg-foreground/[0.04]'
        )}
      >
        <FolderOpen
          size={13}
          className={cn(
            'flex-shrink-0',
            isSelected ? 'text-primary' : 'text-foreground/40'
          )}
        />
        <span className="flex-1 truncate">{workspace.name}</span>
        {(mcpCount > 0 || skillCount > 0) && (
          <span className="text-[10px] text-foreground/35 flex items-center gap-1 flex-shrink-0">
            {mcpCount > 0 && <span>{mcpCount} MCP</span>}
            {skillCount > 0 && <span>{skillCount} Skill</span>}
          </span>
        )}
      </button>

      {/* Hover 操作 */}
      <div className={cn(
        'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5',
        'opacity-0 group-hover:opacity-100 transition-opacity'
      )}>
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true); setDraft(workspace.name) }}
          className="size-5 flex items-center justify-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70"
          title="重命名"
        >
          <Pencil size={10} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="size-5 flex items-center justify-center rounded text-foreground/40 hover:bg-destructive/10 hover:text-destructive"
          title="删除"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  )
}

// ——— 辅助 ———

async function handleRename(
  ws: AgentWorkspace,
  newName: string,
  setWorkspaces: (fn: (prev: AgentWorkspace[]) => AgentWorkspace[]) => void,
) {
  try {
    await sidecarCall('agent:update-workspace', { id: ws.id, name: newName })
    setWorkspaces((prev) => prev.map((w) => w.id === ws.id ? { ...w, name: newName } : w))
  } catch (err) {
    console.error('[WorkspaceSelector] 重命名失败:', err)
    toast.error('重命名失败')
  }
}
