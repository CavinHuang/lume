/**
 * WorkspaceGitGraphDialog - 项目 Git 图谱
 *
 * 大对话框：左侧一张覆盖全部行的 SVG 泳道图（边从子提交节点直连父提交
 * 节点，跨行完整曲线），右侧描述（含 HEAD/分支引用标签）、日期、作者、
 * 提交哈希。顶部刷新，底部加载更多（按 limit 递增重取）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, GitGraph, Loader2, RefreshCw, Tag, X } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type AgentWorkspaceGitLogCommit } from '@lume/shared'
import { sidecarCall } from '@/lib/desktop-api'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { computeGitGraphLayout } from './git-graph-lanes'

const INITIAL_LIMIT = 200
const ROW_HEIGHT = 68
const LANE_WIDTH = 22
const GRAPH_PAD_X = 14
/** 泳道配色（按泳道序循环，与参考稿的多彩曲线一致） */
const LANE_COLORS = ['#f97316', '#3b82f6', '#10b981', '#a855f7', '#eab308', '#ec4899', '#06b6d4', '#84cc16']

interface WorkspaceGitGraphDialogProps {
  workspaceId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspaceGitGraphDialog({ workspaceId, open, onOpenChange }: WorkspaceGitGraphDialogProps) {
  const [commits, setCommits] = useState<AgentWorkspaceGitLogCommit[]>([])
  const [limit, setLimit] = useState(INITIAL_LIMIT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchLog = useCallback((nextLimit: number, replace: boolean) => {
    if (!workspaceId) return Promise.resolve()
    setLoading(true)
    setError(null)
    return sidecarCall<AgentWorkspaceGitLogCommit[]>(AGENT_IPC_CHANNELS.GET_WORKSPACE_GIT_LOG, { id: workspaceId, limit: nextLimit })
      .then((list) => {
        if (Array.isArray(list)) setCommits(list)
        else setCommits([])
      })
      .catch(() => setError('读取提交历史失败'))
      .finally(() => {
        setLoading(false)
        if (replace) setLimit(nextLimit)
      })
  }, [workspaceId])

  useEffect(() => {
    if (!open) return
    setLimit(INITIAL_LIMIT)
    void fetchLog(INITIAL_LIMIT, true)
  }, [open, fetchLog])

  const layout = computeGitGraphLayout(commits)
  const graphWidth = GRAPH_PAD_X * 2 + Math.max(layout.laneCount, 1) * LANE_WIDTH
  const xOf = (lane: number) => GRAPH_PAD_X + lane * LANE_WIDTH
  const yOf = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2
  const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]

  // 边从子提交节点直连父提交节点（git log 保证父提交在子提交之后出现）；
  // 父提交被截断在列表外时，垂线画到列表底部。
  const graphEdges = useMemo(() => {
    const rowIndexByHash = new Map(commits.map((commit, index) => [commit.hash, index]))
    const edges: Array<{ x1: number; y1: number; x2: number; y2: number; colorIndex: number }> = []
    commits.forEach((commit, index) => {
      const lane = layout.lanes[index]
      for (const parent of commit.parents) {
        const parentRow = rowIndexByHash.get(parent)
        if (parentRow === undefined) {
          edges.push({ x1: xOf(lane), y1: yOf(index), x2: xOf(lane), y2: commits.length * ROW_HEIGHT, colorIndex: lane })
        } else {
          edges.push({ x1: xOf(lane), y1: yOf(index), x2: xOf(layout.lanes[parentRow]), y2: yOf(parentRow), colorIndex: lane })
        }
      }
    })
    return edges
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits, layout])

  const hasMore = !loading && !error && commits.length >= limit
  const gridTemplateColumns = `${graphWidth}px 1fr 136px 110px 96px`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1200px]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-3.5">
          <GitGraph size={16} className="shrink-0 text-[var(--text-2)]" />
          <DialogTitle className="text-[15px] font-semibold text-[var(--text-1)]">Git 图谱</DialogTitle>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              type="button"
              size="icon-sm"
              disabled={loading}
              onClick={() => void fetchLog(limit, false)}
              title="刷新"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
            </Button>
            <Button variant="ghost" type="button" size="icon-sm" onClick={() => onOpenChange(false)} title="关闭">
              <X size={14} />
            </Button>
          </div>
        </div>

        <div
          className="grid shrink-0 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-2.5 text-[12px] font-medium text-[var(--text-3)]"
          style={{ gridTemplateColumns }}
        >
          <span>图</span>
          <span>描述</span>
          <span>日期</span>
          <span>作者</span>
          <span className="text-right">提交</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--lume-danger)]">{error}</div>
          ) : loading && commits.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-3)]">
              <Loader2 size={14} className="animate-spin" />
              正在读取提交历史
            </div>
          ) : commits.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--text-3)]">暂无提交</div>
          ) : (
            <div className="relative">
              <svg
                aria-hidden="true"
                width={graphWidth}
                height={commits.length * ROW_HEIGHT}
                className="absolute left-4 top-0"
              >
                {graphEdges.map((edge, index) => {
                  const stroke = laneColor(edge.colorIndex)
                  if (edge.x1 === edge.x2) {
                    return <line key={`e${index}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke={stroke} strokeWidth={2.5} strokeLinecap="round" />
                  }
                  const dy = edge.y2 - edge.y1
                  return (
                    <path
                      key={`e${index}`}
                      d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.y1 + dy * 0.5}, ${edge.x2} ${edge.y2 - dy * 0.5}, ${edge.x2} ${edge.y2}`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                    />
                  )
                })}
                {commits.map((commit, index) => (
                  <circle
                    key={commit.hash}
                    cx={xOf(layout.lanes[index])}
                    cy={yOf(index)}
                    r={4.5}
                    fill={laneColor(layout.lanes[index])}
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                  />
                ))}
              </svg>
              {commits.map((commit) => (
                <GitGraphCommitRow key={commit.hash} commit={commit} graphWidth={graphWidth} gridTemplateColumns={gridTemplateColumns} />
              ))}
              {hasMore && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="ghost"
                    type="button"
                    className="h-7 rounded-lg px-3 text-[12px] text-[var(--text-2)] hover:text-[var(--text-1)]"
                    onClick={() => void fetchLog(limit + INITIAL_LIMIT, true)}
                  >
                    加载更多
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function GitGraphCommitRow({
  commit,
  graphWidth,
  gridTemplateColumns,
}: {
  commit: AgentWorkspaceGitLogCommit
  graphWidth: number
  gridTemplateColumns: string
}) {
  return (
    <div
      className="grid h-[68px] items-center gap-2 px-4 transition-colors hover:bg-[var(--surface-2)]"
      style={{ gridTemplateColumns }}
    >
      <div style={{ width: graphWidth }} />
      <div className="flex min-w-0 items-center gap-2">
        {commit.refs.map((ref) => (
          <span
            key={ref}
            className={cnRefChip(ref)}
          >
            {ref.startsWith("tag:") ? <Tag size={12} className="shrink-0" /> : <GitBranch size={12} className="shrink-0" />}
            <span className="max-w-[170px] truncate">{ref}</span>
          </span>
        ))}
        <span className="min-w-0 truncate text-[14px] text-[var(--text-1)]" title={commit.subject}>
          {commit.subject}
        </span>
      </div>
      <span className="truncate text-[13px] text-[var(--text-2)]">{formatGitDate(commit.date)}</span>
      <span className="truncate text-[13px] text-[var(--text-2)]" title={commit.author}>{commit.author}</span>
      <span className="truncate text-right font-mono text-[13px] text-[var(--text-2)]">{commit.shortHash}</span>
    </div>
  )
}

function cnRefChip(ref: string) {
  const base = 'inline-flex h-[24px] max-w-[190px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium'
  return ref === 'HEAD'
    ? `${base} border border-[#f97316]/50 text-[#f97316]`
    : `${base} border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] text-[var(--text-3)]`
}

function formatGitDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
