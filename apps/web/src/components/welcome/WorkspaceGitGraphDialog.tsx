/**
 * WorkspaceGitGraphDialog - 项目 Git 图谱
 *
 * 大对话框：左列 SVG 泳道图，右侧描述（含 HEAD/分支引用标签）、日期、作者、
 * 提交哈希。顶部刷新，底部加载更多（按 limit 递增重取）。
 */
import { useCallback, useEffect, useState } from 'react'
import { GitBranch, GitGraph, Loader2, RefreshCw, Tag, X } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type AgentWorkspaceGitLogCommit } from '@lume/shared'
import { sidecarCall } from '@/lib/desktop-api'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { computeGitGraphLayout } from './git-graph-lanes'

const INITIAL_LIMIT = 200
const ROW_HEIGHT = 56
const LANE_WIDTH = 18
const GRAPH_PAD_X = 12
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
  const hasMore = !loading && !error && commits.length >= limit

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1080px]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-3">
          <GitGraph size={15} className="shrink-0 text-[var(--text-2)]" />
          <DialogTitle className="text-[14px] font-semibold text-[var(--text-1)]">Git 图谱</DialogTitle>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              type="button"
              size="icon-sm"
              disabled={loading}
              onClick={() => void fetchLog(limit, false)}
              title="刷新"
            >
              <RefreshCw size={14} className={cnSpin(loading)} />
            </Button>
            <Button variant="ghost" type="button" size="icon-sm" onClick={() => onOpenChange(false)} title="关闭">
              <X size={14} />
            </Button>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-[72px_1fr_104px_110px_72px] items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-4 py-1.5 text-[11.5px] font-medium text-[var(--text-3)]">
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
            <div>
              {commits.map((commit, index) => (
                <GitGraphCommitRow
                  key={commit.hash}
                  commit={commit}
                  row={layout.rows[index]}
                  laneCount={layout.laneCount}
                />
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

function cnSpin(loading: boolean) {
  return loading ? 'animate-spin' : undefined
}

function GitGraphCommitRow({
  commit,
  row,
  laneCount,
}: {
  commit: AgentWorkspaceGitLogCommit
  row: ReturnType<typeof computeGitGraphLayout>['rows'][number] | undefined
  laneCount: number
}) {
  const graphWidth = Math.max(2, laneCount) * LANE_WIDTH + GRAPH_PAD_X * 2
  const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]

  return (
    <div className="grid grid-cols-[72px_1fr_104px_110px_72px] items-center gap-2 px-4 transition-colors hover:bg-[var(--surface-2)]">
      <div className="h-full">
        {row && (
          <svg width={graphWidth} height={ROW_HEIGHT}>
            {row.transit.map((lane) => (
              <line
                key={`t${lane}`}
                x1={GRAPH_PAD_X + lane * LANE_WIDTH}
                y1={0}
                x2={GRAPH_PAD_X + lane * LANE_WIDTH}
                y2={ROW_HEIGHT}
                stroke={laneColor(lane)}
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
            {row.outEdges.map((edge, index) => {
              const x1 = GRAPH_PAD_X + edge.from * LANE_WIDTH
              const x2 = GRAPH_PAD_X + edge.to * LANE_WIDTH
              return edge.from === edge.to ? (
                <line key={`e${index}`} x1={x1} y1={ROW_HEIGHT / 2} x2={x2} y2={ROW_HEIGHT} stroke={laneColor(edge.from)} strokeWidth={2} strokeLinecap="round" />
              ) : (
                <path
                  key={`e${index}`}
                  d={`M ${x1} ${ROW_HEIGHT / 2} C ${x1} ${ROW_HEIGHT * 0.78}, ${x2} ${ROW_HEIGHT * 0.78}, ${x2} ${ROW_HEIGHT}`}
                  fill="none"
                  stroke={laneColor(edge.from)}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              )
            })}
            <circle
              cx={GRAPH_PAD_X + row.lane * LANE_WIDTH}
              cy={ROW_HEIGHT / 2}
              r={4}
              fill={laneColor(row.lane)}
              stroke="var(--surface-1)"
              strokeWidth={1.5}
            />
          </svg>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {commit.refs.map((ref) => (
          <span
            key={ref}
            className={cnRefChip(ref)}
          >
            {ref.startsWith("tag:") ? <Tag size={10} className="shrink-0" /> : <GitBranch size={10} className="shrink-0" />}
            <span className="max-w-[140px] truncate">{ref}</span>
          </span>
        ))}
        <span className="min-w-0 truncate text-[13px] text-[var(--text-1)]" title={commit.subject}>
          {commit.subject}
        </span>
      </div>
      <span className="truncate text-[12px] text-[var(--text-2)]">{formatGitDate(commit.date)}</span>
      <span className="truncate text-[12px] text-[var(--text-2)]" title={commit.author}>{commit.author}</span>
      <span className="truncate text-right font-mono text-[12px] text-[var(--text-2)]">{commit.shortHash}</span>
    </div>
  )
}

function cnRefChip(ref: string) {
  const base = 'inline-flex h-[18px] max-w-[160px] shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium'
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
