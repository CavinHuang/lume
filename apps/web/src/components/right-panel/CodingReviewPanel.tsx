import { useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronDown, History, Loader2, Undo2, X } from 'lucide-react'
import { highlightToTokens } from '@lume/ui'
import type { HighlightToken } from '@lume/ui'
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
  const totalAdded = visibleChanges.reduce((sum, change) => sum + (change.addedLines ?? 0), 0)
  const totalRemoved = visibleChanges.reduce((sum, change) => sum + (change.removedLines ?? 0), 0)

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
      if (!cancelled) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message.includes('unsupported renderer sidecar method')
          ? '当前桌面端未加载 Coding diff RPC，请重启 Lume 后重试。'
          : message || '无法加载 Coding diff')
      }
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
    <section className="flex min-h-0 flex-1 flex-col bg-[#181818] text-[#e8e8e8]" aria-label="Coding 变更审核">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
        <div className="flex size-7 items-center justify-center rounded-md border border-white/15 text-[#a8a8a8]"><span className="text-sm">✎</span></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">已编辑的文件 <ChevronDown className="ml-1 inline size-3.5 text-white/50" /></div>
          <div className="text-[11px] text-white/45">本次 Coding Turn · {visibleChanges.length} 个文件 <span className="ml-2 text-emerald-300">+{totalAdded}</span> <span className="ml-1 text-red-300">-{totalRemoved}</span></div>
        </div>
        {state.onRevertRun && (
          <Button variant="ghost" size="sm" className="text-white/65 hover:bg-white/10 hover:text-white" disabled={reverting} onClick={() => void revertRun()} title="撤销本次 Coding Run">
            {reverting ? <Loader2 className="animate-spin" /> : <Undo2 />}
            撤销本次
          </Button>
        )}
        {state.onRewindTurn && (
          <Button variant="ghost" size="sm" className="text-white/65 hover:bg-white/10 hover:text-white" disabled={rewinding} onClick={() => void rewindTurn()} title="恢复文件并删除此 Turn 之后的会话消息">
            {rewinding ? <Loader2 className="animate-spin" /> : <History />}
            回退会话
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className="text-white/60 hover:bg-white/10 hover:text-white" onClick={onClose} title="关闭审核面板" aria-label="关闭审核面板">
          <X />
        </Button>
      </header>
      {pendingRewind && (
        <div className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">
          存在未完成的回退事务（{pendingRewind.operationId.slice(0, 8)}…，{pendingRewind.status}）。请检查已恢复和冲突文件后再继续。
          {pendingRewind.error && <div className="mt-1 break-words opacity-80">{pendingRewind.error}</div>}
        </div>
      )}
      <nav className="flex h-11 shrink-0 items-end gap-5 border-b border-white/[0.08] px-4" aria-label="Coding 变更范围">
        {([
          ['session', '会话文件'],
          ['workspace', '工作区文件'],
          ['changes', '文件改动'],
        ] as const).map(([value, label]) => (
          <Button
            key={value}
            variant="ghost"
            size="sm"
            className={cn('h-10 rounded-none border-b-2 px-0 text-xs', activeTab === value ? 'border-white text-white' : 'border-transparent text-white/45 hover:text-white/80')}
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
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] px-4 py-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选文件"
          aria-label="筛选 Coding 文件"
          className="h-8 min-w-0 flex-1 border-white/15 bg-white/[0.06] text-xs text-white placeholder:text-white/35 focus-visible:ring-white/20"
        />
        <span className="shrink-0 text-[11px] text-white/45">
          {reviewStatus?.unseenPaths.length ?? 0} 个未查看
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs text-white/75 hover:bg-white/10 hover:text-white"
          onClick={() => reviewStatusAction({ type: 'complete', threadId, paths: state.changes.map((change) => change.path) })}
        >
          {reviewStatus?.completed ? <><Check className="mr-1 size-3.5" />已审核</> : '审核完成'}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,0.36fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-auto border-r border-white/[0.08] p-2">
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
        <div className="min-w-0 min-h-0 overflow-auto bg-[#111111] p-3">
          {loading ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-white/45"><Loader2 className="mr-2 size-4 animate-spin" />正在加载 diff…</div>
          ) : error ? (
            <div className="m-3 rounded-md border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200">{error}</div>
          ) : review ? (
            review.lines.length > 0 ? <UnifiedDiffPane lines={review.lines} path={review.path} /> : (
              <div className="grid min-h-40 gap-3 xl:grid-cols-2">
                <DiffPane title="修改前" content={review.oldContent} tone="removed" />
                <DiffPane title="修改后" content={review.newContent} tone="added" />
              </div>
            )
          ) : (
            <div className="flex min-h-32 items-center justify-center text-sm text-white/40">选择文件查看变更</div>
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
      'mb-1 flex min-h-11 w-full items-center rounded-md border border-transparent',
      selected ? 'border-white/10 bg-white/[0.10] text-white' : 'text-white/55 hover:bg-white/[0.05]',
    )}>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-w-0 flex-1 justify-start rounded-md px-2 py-2 text-left text-xs font-normal text-inherit hover:bg-transparent hover:text-white"
        onClick={onClick}
      >
        <span className={cn(
          'mr-2 shrink-0 text-[10px] font-semibold uppercase',
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

function UnifiedDiffPane({ lines, path }: { lines: CodingDiffLine[]; path: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-white/[0.10] bg-[#1b1b1b] shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2 text-xs font-medium text-white/55">
        <span>逐行变更</span><span className="text-[10px] text-white/30">统一 diff</span>
      </div>
      <pre className="max-h-[calc(100vh-7rem)] overflow-auto p-0 text-xs leading-5">
        <code>
          {lines.map((line, index) => (
            <div
              key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
              className={cn(
                'grid grid-cols-[3.25rem_3.25rem_minmax(0,1fr)] px-2',
                line.type === 'added' ? 'bg-[#12351f] text-[#b6f4c6]' :
                  line.type === 'removed' ? 'bg-[#3b1d1b] text-[#ffb8b0]' : 'text-white/65',
              )}
            >
              <span className="select-none border-r border-white/[0.08] pr-2 text-right text-white/25">{line.oldLine ?? ''}</span>
              <span className="select-none border-r border-white/[0.08] pr-2 text-right text-white/25">{line.newLine ?? ''}</span>
              <DiffSyntaxLine line={line} language={languageForPath(path)} />
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

function DiffSyntaxLine({ line, language }: { line: CodingDiffLine; language: string }) {
  const highlighted = useMemo(() => highlightToTokens({ code: line.text, language, theme: 'github-dark' }), [line.text, language])
  const tokens: HighlightToken[] = highlighted?.lines[0] ?? []
  const tokenLength = tokens.reduce((sum, token) => sum + token.content.length, 0)
  return (
    <span className="min-w-0 whitespace-pre-wrap break-words pl-2">
      <span className="mr-1 select-none opacity-50">{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
      {tokens.map((token, index) => <span key={index} style={token.color ? { color: token.color } : undefined}>{token.content}</span>)}
      {tokenLength < line.text.length && line.text.slice(tokenLength)}
      {line.text.length === 0 && ' '}
    </span>
  )
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension === 'tsx' ? 'tsx'
    : extension === 'ts' ? 'typescript'
      : extension === 'jsx' ? 'jsx'
        : extension === 'js' ? 'javascript'
          : extension === 'json' ? 'json'
            : extension === 'css' ? 'css'
              : extension === 'html' ? 'html'
                : extension === 'md' ? 'markdown'
                  : extension === 'py' ? 'python'
                    : extension === 'sh' || extension === 'bash' ? 'shellscript'
                      : 'text'
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
