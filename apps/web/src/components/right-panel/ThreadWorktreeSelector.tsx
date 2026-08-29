import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { Check, ChevronDown, GitBranch, RefreshCw } from 'lucide-react'
import type { AgentActiveWorktree, ThreadWorktreeInfo } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { toast } from 'sonner'
import { agentThreadsAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { sidecarCall } from '@/lib/desktop-api'

export interface ThreadWorktreesResult {
  worktrees: ThreadWorktreeInfo[]
  activeWorktree?: AgentActiveWorktree
}

/**
 * 线程活动 worktree 选择器（对齐 Proma 的 Changes 面板 WorktreeSelector）。
 *
 * 列表来自 `agent:list-thread-worktrees`；选中态以线程 meta 的 activeWorktree
 * 为准（threads atom 经 THREAD_WORKTREE_UPDATED 推送保持最新，Agent 侧
 * EnterWorktree 绑定/失效自愈同样驱动此处）。切换后由 onChanged 让面板重拉
 * diff——变更集合按线程 cwd 在 sidecar 侧解析，绑定生效即自然落到 worktree。
 */
export function ThreadWorktreeSelector({ threadId, onChanged }: {
  threadId: string
  onChanged?: () => void
}) {
  const [result, setResult] = useState<ThreadWorktreesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const fetchSequenceRef = useRef(0)

  const activeWorktreePath = useAtomValue(agentThreadsAtom)
    .find((thread) => thread.id === threadId)?.activeWorktree?.path

  const fetchWorktrees = useCallback(async () => {
    const requestId = ++fetchSequenceRef.current
    setLoading(true)
    try {
      const data = await sidecarCall<ThreadWorktreesResult>(AGENT_IPC_CHANNELS.LIST_THREAD_WORKTREES, { threadId })
      if (requestId === fetchSequenceRef.current) setResult(data)
    } catch {
      if (requestId === fetchSequenceRef.current) setResult({ worktrees: [] })
    } finally {
      if (requestId === fetchSequenceRef.current) setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    void fetchWorktrees()
  }, [fetchWorktrees])

  const linkedWorktrees = (result?.worktrees ?? []).filter((worktree) => !worktree.isMain)
  const selected = linkedWorktrees.find((worktree) => worktree.path === activeWorktreePath)
  const normalizedActivePath = activeWorktreePath?.split(/[\\/]/).join('/')
  const selectedByPath = selected
    ?? (normalizedActivePath
      ? linkedWorktrees.find((worktree) => worktree.path.split(/[\\/]/).join('/') === normalizedActivePath)
      : undefined)

  if (!loading && linkedWorktrees.length === 0 && !selectedByPath) return null

  const selectWorktree = async (worktreePath: string | null) => {
    setSwitching(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SET_THREAD_WORKTREE, { threadId, worktreePath })
      onChanged?.()
      await fetchWorktrees()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换 worktree 失败')
    } finally {
      setSwitching(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-1 text-[13px] font-medium text-[var(--lume-text-primary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
            title="线程 Worktree"
            aria-label="选择线程 Worktree"
          />
        }
      >
        <GitBranch className="size-3.5 text-[var(--lume-text-muted)]" />
        <span className="max-w-32 truncate">
          {switching ? '切换中…' : selectedByPath ? selectedByPath.branch : '主仓库'}
        </span>
        <ChevronDown className="size-3.5 text-[var(--lume-text-muted)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-72" align="start">
        <DropdownMenuItem onSelect={() => void selectWorktree(null)}>
          <GitBranch className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />
          <span className="min-w-0 flex-1">
            <span className="block">主仓库（默认）</span>
            <span className="block truncate text-[11px] text-[var(--lume-text-muted)]">Agent 工作目录为项目根</span>
          </span>
          {!selectedByPath && <Check className="ml-auto size-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-2 py-3 text-[12px] text-[var(--lume-text-muted)]">正在加载 Worktree…</div>
          )}
          {!loading && linkedWorktrees.length === 0 && (
            <div className="px-2 py-3 text-[12px] text-[var(--lume-text-muted)]">
              没有 linked worktree。可让 Agent 执行 <code className="font-mono">git worktree add</code> 后刷新。
            </div>
          )}
          {linkedWorktrees.map((worktree) => (
            <DropdownMenuItem
              key={worktree.path}
              onSelect={() => void selectWorktree(worktree.path)}
            >
              <GitBranch className="size-3.5 shrink-0 text-[var(--lume-text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{worktree.branch}</span>
                <span className="block truncate text-[11px] text-[var(--lume-text-muted)]">{worktree.path}</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--lume-text-muted)]">{worktree.head}</span>
              {selectedByPath?.path === worktree.path && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void fetchWorktrees()} disabled={loading || switching}>
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          刷新 Worktree 列表
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
