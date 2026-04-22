/**
 * WorkspacePicker - 工作区选择器
 *
 * 显示在 AgentHeader 中，允许切换/创建工作区。
 * 工作区仅在创建新线程时应用到该线程，不强制影响已有线程。
 */

import { useState, useEffect, useRef } from 'react'
import { FolderTree, ChevronDown, Check, Plus, Wrench, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, agentWorkspaceCapabilitiesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { WorkspaceCapabilities } from '@lume/shared'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'

export function WorkspacePicker() {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const [capabilities, setCapabilities] = useAtom(agentWorkspaceCapabilitiesAtom)
  const [open, setOpen] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  const currentCaps = current ? capabilities[current.slug] : undefined
  const mcpCount = currentCaps?.mcpServers.filter((s) => s.enabled).length ?? 0
  const skillCount = currentCaps?.skills.length ?? 0

  // 当前工作区切换时拉取能力摘要（MCP + Skill 计数）
  useEffect(() => {
    if (!current?.slug) return
    let cancelled = false
    sidecarCall<WorkspaceCapabilities>('agent:get-capabilities', { workspaceSlug: current.slug })
      .then((caps) => {
        if (cancelled || !current?.slug) return
        setCapabilities((prev) => ({ ...prev, [current.slug]: caps }))
      })
      .catch((err) => console.error('[WorkspacePicker] 获取能力失败:', err))
    return () => { cancelled = true }
  }, [current?.slug, setCapabilities])

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // 打开下拉时为未缓存的工作区拉取能力摘要
  useEffect(() => {
    if (!open) return
    const missing = workspaces.filter((w) => !capabilities[w.slug])
    if (missing.length === 0) return
    let cancelled = false
    Promise.all(
      missing.map((w) =>
        sidecarCall<WorkspaceCapabilities>('agent:get-capabilities', { workspaceSlug: w.slug })
          .then((caps) => ({ slug: w.slug, caps }))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return
      setCapabilities((prev) => {
        const next = { ...prev }
        for (const r of results) if (r) next[r.slug] = r.caps
        return next
      })
    })
    return () => { cancelled = true }
  }, [open, workspaces, capabilities, setCapabilities])

  return (
    <div className="relative flex items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-foreground/60 hover:bg-muted/50 hover:text-foreground/80 transition-colors"
        title="切换工作区"
      >
        <FolderTree size={12} />
        <span className="truncate max-w-[140px]">{current?.name ?? '默认'}</span>
        <ChevronDown size={10} className="text-foreground/40" />
      </button>
      {current && (mcpCount > 0 || skillCount > 0) && (
        <span
          className="flex items-center gap-2 px-2 py-0.5 rounded-full bg-foreground/[0.04] text-[11px] text-foreground/60"
          title={`MCP 服务器 ${mcpCount} 个 · Skill ${skillCount} 个`}
        >
          {mcpCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench size={10} />
              {mcpCount}
            </span>
          )}
          {skillCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Sparkles size={10} />
              {skillCount}
            </span>
          )}
        </span>
      )}
      {open && (
        <div
          ref={menuRef}
          className="absolute top-full mt-1 left-0 z-50 min-w-[240px] max-h-[360px] overflow-y-auto rounded-lg border border-border/60 bg-popover shadow-lg py-1"
        >
          {workspaces.map((w) => {
            const caps = capabilities[w.slug]
            const mcps = caps?.mcpServers.filter((s) => s.enabled).length ?? 0
            const skills = caps?.skills.length ?? 0
            return (
              <button
                key={w.id}
                onClick={() => { setCurrentId(w.id); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors',
                  currentId === w.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground/70 hover:bg-muted/50'
                )}
              >
                <span className="flex-1 truncate">{w.name}</span>
                {(mcps > 0 || skills > 0) && (
                  <span className="text-[10px] text-foreground/40 flex items-center gap-1.5">
                    {mcps > 0 && <span className="flex items-center gap-0.5"><Wrench size={9} />{mcps}</span>}
                    {skills > 0 && <span className="flex items-center gap-0.5"><Sparkles size={9} />{skills}</span>}
                  </span>
                )}
                {currentId === w.id && <Check size={12} className="text-primary" />}
              </button>
            )
          })}
          <div className="border-t border-border/40 mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false)
                setCreateWorkspaceOpen(true)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
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
