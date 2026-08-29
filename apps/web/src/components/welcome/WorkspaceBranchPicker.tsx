/**
 * WorkspaceBranchPicker - 项目条上的分支选择器
 *
 * 触发器为紧凑 chip（分支图标 + 当前分支名）；点击向上弹出分支菜单：
 * 搜索过滤、本地分支列表（当前分支打勾并显示未提交更改数）、
 * 切换分支与「创建并检出新分支」。非 Git 项目不渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, GitGraph, Loader2, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AGENT_IPC_CHANNELS, type AgentWorkspaceGitInfo } from '@lume/shared'
import { sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkspaceGitGraphDialog } from './WorkspaceGitGraphDialog'

interface WorkspaceBranchPickerProps {
  /** 目标项目 id；null（普通会话）时不渲染 */
  workspaceId: string | null
}

export function WorkspaceBranchPicker({ workspaceId }: WorkspaceBranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<AgentWorkspaceGitInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [graphOpen, setGraphOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchInfo = useCallback(() => {
    if (!workspaceId) return Promise.resolve()
    return sidecarCall<AgentWorkspaceGitInfo>(AGENT_IPC_CHANNELS.GET_WORKSPACE_GIT_INFO, { id: workspaceId })
      .then((next) => setInfo(next?.isGitRepo ? next : null))
      .catch(() => setInfo(null))
  }, [workspaceId])

  useEffect(() => {
    setInfo(null)
    setOpen(false)
    void fetchInfo()
  }, [fetchInfo])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    void fetchInfo().finally(() => {
      if (active) setLoading(false)
    })
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      active = false
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [open, fetchInfo])

  if (!workspaceId || !info?.isGitRepo) return null

  const currentBranch = info.branch
  // 当前分支置顶（与参考稿一致），其余按字母序
  const branches = (info.branches ?? [])
    .slice()
    .sort((a, b) => {
      const aCurrent = a === currentBranch ? 0 : 1
      const bCurrent = b === currentBranch ? 0 : 1
      if (aCurrent !== bCurrent) return aCurrent - bCurrent
      return a.localeCompare(b)
    })
    .filter((name) => !search.trim() || name.toLowerCase().includes(search.trim().toLowerCase()))
  const dirtyHint = (info.dirtyFiles ?? 0) > 0 ? `未提交的更改: ${info.dirtyFiles} 个文件` : undefined

  const closeAndReset = () => {
    setOpen(false)
    setSearch('')
    setCreating(false)
    setNewBranchName('')
  }

  const handleCheckout = async (branch: string, create: boolean) => {
    setSwitching(true)
    try {
      const result = await sidecarCall<{ ok: boolean; error?: string }>(
        AGENT_IPC_CHANNELS.CHECKOUT_WORKSPACE_BRANCH,
        { id: workspaceId, branch, ...(create ? { create: true } : {}) },
      )
      if (!result?.ok) {
        toast.error(result?.error ?? '切换分支失败')
        return
      }
      toast.success(create ? `已创建并检出 ${branch}` : `已切换到 ${branch}`)
      closeAndReset()
      void fetchInfo()
    } catch {
      toast.error('切换分支失败')
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
        title="切换分支"
      >
        <GitBranch size={13} className="shrink-0 text-[var(--text-3)]" />
        <span className="max-w-[200px] truncate text-[var(--text-1)]">{currentBranch ?? 'HEAD'}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--text-3)]" />
      </Button>

      {workspaceId && (
        <WorkspaceGitGraphDialog workspaceId={workspaceId} open={graphOpen} onOpenChange={setGraphOpen} />
      )}

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-[352px] overflow-hidden rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[var(--surface-1)] shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)]">
          <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] p-2">
            <div className="flex items-center gap-2 rounded-lg bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-2.5 py-1.5">
              <Search size={13} className="shrink-0 text-[var(--text-3)]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索分支"
                className="h-auto flex-1 border-0 bg-transparent px-0 py-0 text-[12.5px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[260px] overflow-y-auto p-1.5">
            <div className="px-2 py-1 text-[11px] font-medium text-[var(--text-3)]">分支</div>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-[var(--text-3)]">
                <Loader2 size={13} className="animate-spin" />
                正在读取分支
              </div>
            ) : branches.length === 0 ? (
              <div className="px-2 py-4 text-center text-[12px] text-[var(--text-3)]">无匹配分支</div>
            ) : (
              branches.map((branch) => {
                const current = branch === currentBranch
                return (
                  <Button
                    variant="ghost"
                    type="button"
                    key={branch}
                    disabled={switching}
                    onClick={() => { if (!current) void handleCheckout(branch, false) }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2.5 text-left transition-colors',
                      current && 'bg-[var(--surface-2)]',
                    )}
                  >
                    <GitBranch size={13} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--text-1)]">{branch}</span>
                      {current && dirtyHint && (
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--text-3)]">{dirtyHint}</span>
                      )}
                    </span>
                    {current && <Check size={14} className="mt-0.5 shrink-0 text-[var(--text-2)]" />}
                  </Button>
                )
              })
            )}
          </div>
          <div className="border-t border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] p-1.5">
            {creating ? (
              <div className="flex items-center gap-1.5 px-1">
                <Input
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.target.value)}
                  placeholder="新分支名称"
                  className="h-7 flex-1 border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] bg-transparent px-2 text-[12.5px] text-[var(--text-1)] shadow-none"
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && newBranchName.trim() && !switching) void handleCheckout(newBranchName, true)
                    if (event.key === 'Escape') setCreating(false)
                  }}
                />
                <Button
                  variant="ghost"
                  type="button"
                  disabled={!newBranchName.trim() || switching}
                  onClick={() => void handleCheckout(newBranchName, true)}
                  className="h-7 shrink-0 rounded-md px-2 text-[12px] text-[var(--text-1)]"
                >
                  {switching ? <Loader2 size={12} className="animate-spin" /> : '创建'}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                type="button"
                disabled={switching}
                onClick={() => { setCreating(true); setSearch('') }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
              >
                <Plus size={13} className="shrink-0 text-[var(--text-3)]" />
                创建并检出新分支…
              </Button>
            )}
            <Button
              variant="ghost"
              type="button"
              onClick={() => { closeAndReset(); setGraphOpen(true) }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
            >
              <GitGraph size={13} className="shrink-0 text-[var(--text-3)]" />
              Git 图谱
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
