/**
 * 右侧面板「Git」tab —— 只读 Git 状态面板。
 *
 * 对齐 ZCode SidePane Git 面板（docs/analysis/P2-git-codeviewer.md §1）：
 *  - 结构 = 来源下拉 + 刷新按钮 + 虚拟化变更列表（estimateSize 32 / overscan 14，
 *    measureElement 适配展开后的可变高度）+ 展开式懒加载 diff；
 *  - unstaged 来源合并 unstaged + untracked + conflicted（ZCode gitSourceId 分组）；
 *  - diff 缓存以 revision 失效：刷新后已展开项自动重新拉取；
 *  - 完全只读，无 stage/unstage/commit。
 *
 * v1 偏差（后续跟进）：branch / last-turn 来源、查找（scrollToIndex）、文件 watch
 * 自动刷新未实现，仅手动刷新；diff 以纯文本 +/- 着色渲染（Shiki 可后续接入）。
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitPanelChange, GitPanelDiff, GitPanelStatus } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'
import { fetchGitPanelDiff, fetchGitPanelStatus } from '@/lib/desktop-api/git-panel'

/** v1 仅本地两作用域；branch/last-turn 依赖后端比较数据，暂缓（见文件头偏差）。 */
type GitPanelSource = 'unstaged' | 'staged'

const SOURCE_OPTIONS: Array<{ value: GitPanelSource; label: string }> = [
  { value: 'unstaged', label: '未暂存更改' },
  { value: 'staged', label: '已暂存更改' },
]

const KIND_LETTERS: Record<GitPanelChange['kind'], string> = {
  added: 'A', deleted: 'D', modified: 'M', renamed: 'R', conflicted: 'U',
}

const KIND_LETTER_CLASSES: Record<GitPanelChange['kind'], string> = {
  added: 'text-[color:var(--lume-diff-added-fg)]',
  deleted: 'text-[color:var(--lume-diff-deleted-fg)]',
  modified: 'text-foreground/50',
  renamed: 'text-foreground/50',
  conflicted: 'text-amber-500',
}

/** 展开 diff 的缓存态：loading 占位 / 加载失败 / 正常结果。 */
type LoadedDiff = { state: 'loading' } | { state: 'failed' } | { state: 'done'; diff: GitPanelDiff }

interface GitPanelProps {
  /** 当前会话绑定的项目目录；缺失时显示无项目空态。 */
  workspacePath?: string
}

export function GitPanel({ workspacePath }: GitPanelProps) {
  const [status, setStatus] = useState<GitPanelStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<GitPanelSource>('unstaged')
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set())
  const [diffs, setDiffs] = useState<ReadonlyMap<string, LoadedDiff>>(new Map())
  // ZCode refreshToken 等价：递增触发 status 重载 + diff 缓存失效。
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    // 切换工作区时清空展开与缓存，避免串仓库。
    setExpandedPaths(new Set())
    setDiffs(new Map())
  }, [workspacePath])

  useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    setLoading(true)
    fetchGitPanelStatus(workspacePath)
      .then((result) => { if (!cancelled) setStatus(result) })
      .catch(() => { if (!cancelled) setStatus(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspacePath, revision])

  const changes = useMemo(() => {
    if (!status) return []
    return status.changes.filter((change) => source === 'staged'
      ? change.section === 'staged'
      : change.section !== 'staged')
  }, [status, source])

  const diffKey = useCallback((change: GitPanelChange) => `${change.section}:${change.repoRelativePath}`, [])

  // 展开项懒加载（ZCode §1.4：Set 在途去重 + revision 失效由 refresh 清空缓存实现）。
  useEffect(() => {
    if (!workspacePath) return
    const pending = changes.filter((change) => expandedPaths.has(change.repoRelativePath) && !diffs.has(diffKey(change)))
    if (pending.length === 0) return
    let cancelled = false
    setDiffs((current) => {
      const next = new Map(current)
      for (const change of pending) next.set(diffKey(change), { state: 'loading' })
      return next
    })
    for (const change of pending) {
      void fetchGitPanelDiff(workspacePath, change.repoRelativePath, change.section)
        .then((diff) => {
          if (!cancelled) setDiffs((current) => new Map(current).set(diffKey(change), { state: 'done', diff }))
        })
        .catch(() => {
          if (!cancelled) setDiffs((current) => new Map(current).set(diffKey(change), { state: 'failed' }))
        })
    }
    return () => { cancelled = true }
  }, [changes, diffKey, diffs, expandedPaths, workspacePath])

  const refresh = useCallback(() => {
    setDiffs(new Map())
    setRevision((current) => current + 1)
  }, [])

  const toggleExpanded = useCallback((repoRelativePath: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(repoRelativePath)) next.delete(repoRelativePath)
      else next.add(repoRelativePath)
      return next
    })
  }, [])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: changes.length,
    estimateSize: () => 32,
    overscan: 14,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => `${source}:${changes[index]?.repoRelativePath ?? index}`,
    measureElement: (element) => element.getBoundingClientRect().height,
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--lume-border-subtle)] px-2">
        <Select value={source} onValueChange={(value) => setSource(value === 'staged' ? 'staged' : 'unstaged')}>
          <SelectTrigger size="sm" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status?.isRepository && (
          <span className="flex min-w-0 shrink-0 items-center gap-1 text-xs text-[var(--lume-text-muted)]" title={status.branchName ?? 'detached HEAD'}>
            <GitBranch size={12} className="shrink-0" />
            <span className="max-w-24 truncate">{status.branchName ?? 'detached'}</span>
            {status.ahead > 0 && <span className="text-[color:var(--lume-diff-added-fg)]">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="text-[color:var(--lume-diff-deleted-fg)]">↓{status.behind}</span>}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={refresh}
          disabled={loading || !workspacePath}
          title="刷新"
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      {!workspacePath ? (
        <GitPanelEmpty title="未绑定项目目录" hint="当前会话没有可读取 Git 状态的项目路径" />
      ) : loading && !status ? (
        <div className="flex flex-1 items-center justify-center text-[var(--lume-text-muted)]"><Spinner /></div>
      ) : !status ? (
        <GitPanelEmpty title="无法读取 Git 状态" hint="读取状态时出错，请点击刷新重试" />
      ) : !status.isGitAvailable ? (
        <GitPanelEmpty title="Git 不可用" hint="未找到 git 命令，请确认已安装并加入 PATH" />
      ) : !status.isRepository ? (
        <GitPanelEmpty title="不是 Git 仓库" hint="当前项目目录未初始化 Git" />
      ) : changes.length === 0 ? (
        <GitPanelEmpty
          title={source === 'staged' ? '没有已暂存的更改' : '没有未提交的更改'}
          hint={source === 'staged' ? '使用 git add 暂存文件后会出现在这里' : '工作区与暂存区当前是干净的'}
        />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const change = changes[virtualItem.index]
              if (!change) return null
              const expanded = expandedPaths.has(change.repoRelativePath)
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <GitChangeRow
                    change={change}
                    expanded={expanded}
                    diff={diffs.get(diffKey(change))}
                    onToggle={() => toggleExpanded(change.repoRelativePath)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function GitChangeRow({ change, expanded, diff, onToggle }: {
  change: GitPanelChange
  expanded: boolean
  diff: LoadedDiff | undefined
  onToggle: () => void
}) {
  return (
    <div className="border-b border-[var(--lume-border-subtle)]/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex h-8 w-full items-center gap-1.5 px-2 text-left text-[13px] transition-colors hover:bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,transparent)]"
        title={change.repoRelativePath}
      >
        {expanded
          ? <ChevronDown size={13} className="shrink-0 text-[var(--lume-text-muted)]" />
          : <ChevronRight size={13} className="shrink-0 text-[var(--lume-text-muted)]" />}
        <FileTypeIcon filename={fileNameOf(change.path)} size={14} />
        <span className="min-w-0 flex-1 truncate">{change.path}</span>
        <span className={cn('shrink-0 font-mono text-[11px]', KIND_LETTER_CLASSES[change.kind])} title={change.kind}>
          {KIND_LETTERS[change.kind]}
        </span>
        {change.added !== null && change.added > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-[color:var(--lume-diff-added-fg)]">+{change.added}</span>
        )}
        {change.removed !== null && change.removed > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-[color:var(--lume-diff-deleted-fg)]">−{change.removed}</span>
        )}
      </button>
      {expanded && <GitDiffBody diff={diff} />}
    </div>
  )
}

function GitDiffBody({ diff }: { diff: LoadedDiff | undefined }) {
  if (!diff || diff.state === 'loading') {
    return (
      <div className="flex items-center gap-2 px-7 py-2 text-xs text-[var(--lume-text-muted)]">
        <Spinner className="size-3" />
        加载 diff…
      </div>
    )
  }
  if (diff.state === 'failed') {
    return <div className="px-7 py-2 text-xs text-[color:var(--lume-diff-deleted-fg)]">diff 加载失败</div>
  }
  if (diff.diff.availability === 'binary') {
    return <div className="px-7 py-2 text-xs text-[var(--lume-text-muted)]">二进制文件，不显示文本 diff</div>
  }
  if (!diff.diff.patch) {
    return <div className="px-7 py-2 text-xs text-[var(--lume-text-muted)]">无差异</div>
  }
  return (
    <div className="overflow-x-auto border-t border-[var(--lume-border-subtle)]/60 bg-[color-mix(in_srgb,var(--lume-text-primary)_3%,transparent)]">
      {diff.diff.availability === 'truncated' && (
        <div className="px-7 pt-2 text-xs text-amber-500">差异过大，已截断显示</div>
      )}
      {/* 纯文本 +/- 着色（ZCode 超阈值降级同形态；Shiki 富高亮为后续跟进） */}
      <pre className="w-max min-w-full px-3 py-2 font-mono text-[11px] leading-4">
        {diff.diff.patch.split('\n').map((line, index) => (
          <div key={index} className={diffLineClass(line)}>{line.length > 0 ? line : ' '}</div>
        ))}
      </pre>
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('rename ')) {
    return 'text-[var(--lume-text-muted)]'
  }
  if (line.startsWith('@@')) return 'text-sky-500'
  if (line.startsWith('+')) return 'text-[color:var(--lume-diff-added-fg)]'
  if (line.startsWith('-')) return 'text-[color:var(--lume-diff-deleted-fg)]'
  return 'text-[var(--lume-text-secondary)]'
}

function fileNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index >= 0 ? path.slice(index + 1) : path
}

function GitPanelEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="text-sm font-medium text-[var(--lume-text-secondary)]">{title}</div>
      {hint && <div className="text-xs text-[var(--lume-text-muted)]">{hint}</div>}
    </div>
  )
}
