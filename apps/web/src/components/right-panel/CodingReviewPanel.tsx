import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { History, Loader2, Undo2, X } from 'lucide-react'
import type { RuntimeCodingFileChange } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { codingReviewStatusActionAtom, codingReviewStatusAtom, type CodingReviewPanelState } from '@/atoms/right-panel-atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

interface CodingDiffPayload {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  oldContent: string
  newContent: string
  lines: CodingDiffLine[]
  addedLines: number
  removedLines: number
}

interface CodingDiffLine {
  type: 'context' | 'added' | 'removed'
  oldLine?: number
  newLine?: number
  text: string
}

export function CodingReviewPanel({ threadId, state, onClose }: {
  threadId: string
  state: CodingReviewPanelState
  onClose: () => void
}) {
  const [selectedPath, setSelectedPath] = useState(state.selectedPath)
  const [activeTab, setActiveTab] = useState<'session' | 'workspace' | 'changes'>('session')
  const [workspaceChanges, setWorkspaceChanges] = useState<RuntimeCodingFileChange[]>([])
  const [review, setReview] = useState<CodingDiffPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [rewinding, setRewinding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const reviewStatus = useAtomValue(codingReviewStatusAtom)[threadId]
  const reviewStatusAction = useSetAtom(codingReviewStatusActionAtom)
  const [pendingRewind, setPendingRewind] = useState<{ operationId: string; status: string; error?: string } | null>(null)
  const visibleChanges = activeTab === 'workspace' ? workspaceChanges : state.changes
  const filteredChanges = visibleChanges.filter((change) => change.path.toLowerCase().includes(filter.toLowerCase()))
  const selectedChange = filteredChanges.find((change) => change.path === selectedPath) ?? filteredChanges[0]

  useEffect(() => {
    void sidecarCall<{ files?: RuntimeCodingFileChange[]; pendingRewind?: { operationId: string; status: string; error?: string } } | RuntimeCodingFileChange[]>(AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET, { threadId })
      .then((result) => {
        if (Array.isArray(result)) {
          setWorkspaceChanges(result)
          return
        }
        setWorkspaceChanges(result.files ?? [])
        setPendingRewind(result.pendingRewind ?? null)
      })
      .catch(() => setWorkspaceChanges([]))
  }, [threadId])

  useEffect(() => {
    setSelectedPath(state.selectedPath)
  }, [state.selectedPath])

  useEffect(() => {
    if (selectedChange) {
      reviewStatusAction({ type: 'mark-reviewed', threadId, path: selectedChange.path })
    }
  }, [selectedChange?.path, threadId, reviewStatusAction])

  useEffect(() => {
    if (!selectedChange) {
      setReview(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setReview(null)
    void sidecarCall<CodingDiffPayload>(AGENT_IPC_CHANNELS.GET_CODING_DIFF, {
      threadId,
      path: selectedChange.path,
    }).then((next) => {
      if (!cancelled) setReview(next)
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '无法加载 Coding diff')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedChange?.path, threadId])

  const revertRun = async () => {
    if (!state.onRevertRun) return
    setReverting(true)
    try {
      await state.onRevertRun()
    } finally {
      setReverting(false)
    }
  }

  const rewindTurn = async () => {
    if (!state.onRewindTurn) return
    setRewinding(true)
    try {
      await state.onRewindTurn()
    } finally {
      setRewinding(false)
    }
  }

  const revertFile = async (path: string) => {
    if (!state.runId) return
    setReverting(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.REVERT_CODING_FILE, {
        threadId,
        path,
        runId: state.runId,
      })
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法撤销文件变更')
    } finally {
      setReverting(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--lume-bg-panel)]" aria-label="Coding 变更审核">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--lume-border-subtle)] px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--lume-text-primary)]">审核变更</div>
          <div className="text-[11px] text-[var(--lume-text-muted)]">{visibleChanges.length} 个文件</div>
        </div>
        {state.onRevertRun && (
          <Button variant="ghost" size="sm" disabled={reverting} onClick={() => void revertRun()} title="撤销本次 Coding Run">
            {reverting ? <Loader2 className="animate-spin" /> : <Undo2 />}
            撤销本次
          </Button>
        )}
        {state.onRewindTurn && (
          <Button variant="ghost" size="sm" disabled={rewinding} onClick={() => void rewindTurn()} title="恢复文件并删除此 Turn 之后的会话消息">
            {rewinding ? <Loader2 className="animate-spin" /> : <History />}
            回退会话
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="关闭审核面板" aria-label="关闭审核面板">
          <X />
        </Button>
      </header>
      {pendingRewind && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          存在未完成的回退事务（{pendingRewind.operationId.slice(0, 8)}…，{pendingRewind.status}）。请检查已恢复和冲突文件后再继续。
          {pendingRewind.error && <div className="mt-1 break-words opacity-80">{pendingRewind.error}</div>}
        </div>
      )}
      <nav className="flex h-10 shrink-0 items-end gap-4 border-b border-[var(--lume-border-subtle)] px-3" aria-label="Coding 变更范围">
        {([
          ['session', '会话文件'],
          ['workspace', '工作区文件'],
          ['changes', '文件改动'],
        ] as const).map(([value, label]) => (
          <Button
            key={value}
            variant="ghost"
            size="sm"
            className={cn('h-9 rounded-none border-b-2 px-0 text-xs', activeTab === value ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground')}
            onClick={() => {
              setActiveTab(value)
              const next = (value === 'workspace' ? workspaceChanges : state.changes)[0]?.path
              if (next) setSelectedPath(next)
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--lume-border-subtle)] px-3 py-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选文件"
          aria-label="筛选 Coding 文件"
          className="h-7 min-w-0 flex-1 px-2 text-xs"
        />
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {reviewStatus?.unseenPaths.length ?? 0} 个未查看
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => reviewStatusAction({ type: 'complete', threadId, paths: state.changes.map((change) => change.path) })}
        >
          {reviewStatus?.completed ? '已审核' : '审核完成'}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,0.36fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-auto border-r border-[var(--lume-border-subtle)] p-1.5">
          {filteredChanges.map((change) => (
            <ChangeFileButton
              key={change.path}
              change={change}
              selected={selectedChange?.path === change.path}
              onClick={() => setSelectedPath(change.path)}
              onRevert={() => void revertFile(change.path)}
              canRevert={Boolean(state.runId && change.canUndo && change.state !== 'conflict' && change.state !== 'external_modified' && change.state !== 'committed')}
            />
          ))}
        </div>
        <div className="min-w-0 min-h-0 overflow-auto p-2">
          {loading ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载 diff…</div>
          ) : error ? (
            <div className="flex min-h-32 items-center justify-center px-4 text-center text-sm text-destructive">{error}</div>
          ) : review ? (
            review.lines.length > 0 ? <UnifiedDiffPane lines={review.lines} /> : (
              <div className="grid min-h-40 gap-3 xl:grid-cols-2">
                <DiffPane title="修改前" content={review.oldContent} tone="removed" />
                <DiffPane title="修改后" content={review.newContent} tone="added" />
              </div>
            )
          ) : (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">选择文件查看变更</div>
          )}
        </div>
      </div>
    </section>
  )
}

function ChangeFileButton({ change, selected, onClick, onRevert, canRevert }: {
  change: RuntimeCodingFileChange
  selected: boolean
  onClick: () => void
  onRevert: () => void
  canRevert: boolean
}) {
  return (
    <div className={cn(
      'mb-0.5 flex min-h-10 w-full items-center rounded-md',
      selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
    )}>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-w-0 flex-1 justify-start rounded-md px-2 py-1.5 text-left text-xs font-normal"
        onClick={onClick}
      >
        <span className={cn(
          'mr-1 shrink-0 text-[10px] font-semibold uppercase',
          change.status === 'added' || change.status === 'untracked' ? 'text-emerald-500' :
            change.status === 'deleted' ? 'text-red-500' :
              change.state === 'conflict' || change.state === 'external_modified' ? 'text-amber-500' : 'text-muted-foreground',
        )}>
          {change.status === 'untracked' ? 'A' : change.status === 'added' ? 'A' : change.status === 'deleted' ? 'D' : change.status === 'renamed' ? 'R' : 'M'}
        </span>
        <span className="min-w-0 flex-1 truncate">{change.path}</span>
        {(typeof change.addedLines === 'number' || typeof change.removedLines === 'number') && (
          <span className="ml-2 shrink-0 tabular-nums">
            <span className="text-emerald-500">+{change.addedLines ?? 0}</span>
            <span className="ml-1 text-red-500">-{change.removedLines ?? 0}</span>
          </span>
        )}
        {change.state && change.state !== 'normal' && (
          <span className="ml-1 shrink-0 text-[10px] text-amber-500">
            {change.state === 'committed' ? '已提交' : change.state === 'unpreviewable' ? '不可预览' : change.state === 'external_modified' ? '外部修改' : '冲突'}
          </span>
        )}
      </Button>
      {canRevert && (
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 size-7 shrink-0"
          title="撤销此文件"
          onClick={(event) => { event.stopPropagation(); onRevert() }}
        >
          <Undo2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

function UnifiedDiffPane({ lines }: { lines: CodingDiffLine[] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/20">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">逐行变更</div>
      <pre className="max-h-[calc(100vh-7rem)] overflow-auto p-0 text-xs leading-5">
        <code>
          {lines.map((line, index) => (
            <div
              key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
              className={cn(
                'grid grid-cols-[3.25rem_3.25rem_minmax(0,1fr)] px-2',
                line.type === 'added' ? 'bg-emerald-500/15 text-emerald-950 dark:text-emerald-100' :
                  line.type === 'removed' ? 'bg-red-500/15 text-red-950 dark:text-red-100' : 'text-foreground/75',
              )}
            >
              <span className="select-none border-r border-border/50 pr-2 text-right text-muted-foreground/60">{line.oldLine ?? ''}</span>
              <span className="select-none border-r border-border/50 pr-2 text-right text-muted-foreground/60">{line.newLine ?? ''}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words pl-2"><span className="select-none opacity-60">{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>{line.text || ' '}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

function DiffPane({ title, content, tone }: { title: string; content: string; tone: 'added' | 'removed' }) {
  return (
    <div className={cn(
      'min-w-0 overflow-hidden rounded-lg border',
      tone === 'added' ? 'border-emerald-500/25 bg-emerald-500/[0.04]' : 'border-red-500/25 bg-red-500/[0.04]',
    )}>
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-[calc(100vh-7rem)] overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5">{content || '（空文件）'}</pre>
    </div>
  )
}
