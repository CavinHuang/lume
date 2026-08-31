/**
 * 右侧面板「Git」tab —— 只读 Git 状态面板。
 *
 * 对齐 ZCode SidePane Git 面板（docs/analysis/P2-git-codeviewer.md §1）：
 *  - 结构 = 来源下拉 + 刷新按钮 + 虚拟化变更列表（estimateSize 32 / overscan 14，
 *    measureElement 适配展开后的可变高度）+ 展开式懒加载 diff；
 *  - unstaged 来源合并 unstaged + untracked + conflicted（ZCode gitSourceId 分组）；
 *  - branch 来源与上游分支比较未推送提交（branchComparison，选项仅在有 tracking
 *    分支时出现，数据按需加载）；
 *  - diff 缓存以 revision 失效：刷新后已展开项自动重新拉取；
 *  - 查找（ZCode KEt）：大小写/空白归一化子串匹配已加载 diff 文本；有查询时自动
 *    批量预加载全部 diff，Enter/prev/next 在命中文件间循环（展开 + scrollToIndex
 *    center）；计数为命中文件粒度（虚拟列表滚动以文件行为单位）；
 *  - 行级菜单（ZCode §1.3）：在文件管理器中显示（桌面）/复制绝对路径/复制相对路径；
 *  - 来源选择跨挂载记忆（ZCode Ujt activeGitSourceId 按 workspace 键控迁移）；
 *  - 完全只读，无 stage/unstage/commit。
 *
 * v1 偏差（后续跟进）：last-turn 来源（ZCode 该构建中恒为空占位，无需移植）、
 * 「在文件树中显示」移交（Lume 文件树 reveal 总线按 thread 绑定，需桥接）；
 * 自动刷新 = main 侧 fs.watch 实时通道（lume:browser-git-dirty 事件）+ 60s 轮询
 * 兜底；diff 以纯文本 +/- 着色渲染（Shiki 可后续接入）。
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, ChevronUp, GitBranch, MoreVertical, RefreshCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitPanelBranchComparison, GitPanelChange, GitPanelDiff, GitPanelSource, GitPanelStatus } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { isDesktopRuntime, revealPathInSystem, writeClipboardText } from '@/lib/desktop-api/native'
import { cn } from '@/lib/utils'
import { fetchGitPanelBranchComparison, fetchGitPanelDiff, fetchGitPanelStatus, onGitPanelDirty, watchGitPanelWorkspace } from '@/lib/desktop-api/git-panel'

/** 本地两作用域固定展示；branch 选项依赖 status.trackingBranchName 动态追加。 */
const BASE_SOURCE_OPTIONS: Array<{ value: GitPanelSource; label: string }> = [
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

/** 大小写/空白归一化（ZCode KEt 同款：子串匹配前双方归一）。 */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ')
}

/** 统计 needle 在 patch 中的非重叠出现次数（0 次或空查询返回 0）。 */
function countPatchMatches(patch: string, query: string): number {
  const haystack = normalizeForSearch(patch)
  const needle = normalizeForSearch(query)
  if (!needle) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = haystack.indexOf(needle, index)
    if (found < 0) break
    count += 1
    index = found + needle.length
  }
  return count
}

interface GitPanelProps {
  /** 当前会话绑定的项目目录；缺失时显示无项目空态。 */
  workspacePath?: string
}

/**
 * 跨挂载来源选择记忆（ZCode Ujt activeGitSourceId 按 workspaceKey 键控的迁移语义：
 * 切换写回/进入恢复；Dd 持久层同为 renderer 内存，reload 即失）。
 */
const sourceByWorkspace = new Map<string, GitPanelSource>()

export function GitPanel({ workspacePath }: GitPanelProps) {
  const [status, setStatus] = useState<GitPanelStatus | null>(null)
  const [branchComparison, setBranchComparison] = useState<GitPanelBranchComparison | null>(null)
  const [loading, setLoading] = useState(false)
  // 进入恢复（ZCode Ad(a).activeGitSourceId；branch 失效回落由下方既有 effect 承担）。
  const [source, setSource] = useState<GitPanelSource>(
    () => sourceByWorkspace.get(workspacePath ?? '') ?? 'unstaged',
  )
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set())
  const [diffs, setDiffs] = useState<ReadonlyMap<string, LoadedDiff>>(new Map())
  // ZCode refreshToken 等价：递增触发 status 重载 + diff 缓存失效。
  const [revision, setRevision] = useState(0)
  // 查找态（ZCode KEt）：开启查找条 + 查询词 + 当前命中文件游标。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)

  // 有 tracking 分支才出现 branch 选项，标签带上游名（ZCode sourceOptions 动态生成等效）。
  const sourceOptions = useMemo(() => {
    if (!status?.trackingBranchName) return BASE_SOURCE_OPTIONS
    return [...BASE_SOURCE_OPTIONS, { value: 'branch' as const, label: `分支差异（${status.trackingBranchName}）` }]
  }, [status?.trackingBranchName])

  // 自动刷新双通道：主 = main 侧 fs.watch（lume:browser-git-watch 注册工作区，
  // 变更 60s 防抖回发 lume:browser-git-dirty），到此递增 revision 即重载 status
  // 并失效 diff 缓存（ZCode GitAutoRefresh → onRefreshGit 等效）。
  useEffect(() => {
    const unlisten = onGitPanelDirty(() => setRevision((current) => current + 1))
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [])

  // 告知 main 当前工作区路径以启动 watch（main 不感知 projectPath，与
  // terminal-create 的 cwd 同一道传递面；同时只 watch 一个工作区，新路径替换旧监听）。
  useEffect(() => {
    if (!workspacePath) return
    void watchGitPanelWorkspace(workspacePath).catch(() => undefined)
  }, [workspacePath])

  // 兜底：60s 轮询（与 ZCode 防抖值一致；watch 通道失效时仍能收敛）。
  useEffect(() => {
    if (!workspacePath) return
    const timer = setInterval(() => setRevision(r => r + 1), 60_000)
    return () => clearInterval(timer)
  }, [workspacePath])

  useEffect(() => {
    // 切换工作区时清空展开与缓存，避免串仓库。
    setExpandedPaths(new Set())
    setDiffs(new Map())
    setBranchComparison(null)
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

  // 分支比较按需加载：仅 branch 来源时请求（ZCode includeBranchComparison 仅 git tab 打开时请求的懒加载等效）。
  useEffect(() => {
    if (!workspacePath || source !== 'branch') return
    let cancelled = false
    setLoading(true)
    fetchGitPanelBranchComparison(workspacePath)
      .then((result) => { if (!cancelled) setBranchComparison(result) })
      .catch(() => { if (!cancelled) setBranchComparison(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspacePath, source, revision])

  // 上游分支消失（切分支/删除 upstream）时回落 unstaged（ZCode activeGitSourceId 校验等效）。
  useEffect(() => {
    if (source === 'branch' && status !== null && !status.trackingBranchName) setSource('unstaged')
  }, [source, status])

  // 切换写回（ZCode Ujt 的 jd(e, {activeGitSourceId}) 等效：按工作区记住最新选择）。
  useEffect(() => {
    sourceByWorkspace.set(workspacePath ?? '', source)
  }, [source, workspacePath])

  const changes = useMemo(() => {
    if (source === 'branch') return branchComparison?.changes ?? []
    if (!status) return []
    return status.changes.filter((change) => source === 'staged'
      ? change.section === 'staged'
      : change.section !== 'staged')
  }, [status, branchComparison, source])

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

  // branch 数据未就绪时占位，避免切换来源瞬间闪空态文案。
  const branchNotLoaded = source === 'branch' && loading && !branchComparison
  const branchUnavailable = source === 'branch' && branchComparison !== null && !branchComparison.available

  // 查找激活（有非空查询词）时批量预加载全部 diff（ZCode KEt：有查询自动批量预加载）。
  const searchActive = searchOpen && searchQuery.trim().length > 0
  useEffect(() => {
    if (!searchActive || !workspacePath) return
    const pending = changes.filter((change) => !diffs.has(diffKey(change)))
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
  }, [searchActive, changes, diffKey, diffs, workspacePath])

  // 命中表：按列表顺序保留含命中的文件（计数来自已加载完成的 diff 文本）。
  const matchedEntries = useMemo(() => {
    if (!searchActive) return [] as Array<{ index: number; count: number }>
    return changes
      .map((change, index) => {
        const loaded = diffs.get(diffKey(change))
        const count = loaded?.state === 'done' && loaded.diff.patch
          ? countPatchMatches(loaded.diff.patch, searchQuery)
          : 0
        return { index, count }
      })
      .filter((entry) => entry.count > 0)
  }, [changes, diffKey, diffs, searchActive, searchQuery])

  // 查询/命中表变化时游标归位。
  useEffect(() => { setMatchCursor(0) }, [searchQuery, matchedEntries.length])

  const goToMatch = useCallback((cursor: number) => {
    if (matchedEntries.length === 0) return
    const wrapped = ((cursor % matchedEntries.length) + matchedEntries.length) % matchedEntries.length
    setMatchCursor(wrapped)
    const entry = matchedEntries[wrapped]
    const change = changes[entry.index]
    if (!change) return
    setExpandedPaths((current) => new Set(current).add(change.repoRelativePath))
    virtualizer.scrollToIndex(entry.index, { align: 'center' })
  }, [changes, matchedEntries, virtualizer])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setMatchCursor(0)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--lume-border-subtle)] px-2">
        <Select value={source} onValueChange={(value) => {
          if (value === 'unstaged' || value === 'staged' || value === 'branch') setSource(value)
        }}>
          <SelectTrigger size="sm" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sourceOptions.map((option) => (
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
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          disabled={!status?.isRepository || changes.length === 0}
          title={searchOpen ? '关闭查找' : '在差异中查找'}
        >
          <Search size={13} className={cn(searchOpen && 'text-[var(--lume-text-primary)]')} />
        </Button>
      </div>

      {searchOpen && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--lume-border-subtle)] px-2">
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="在差异中查找（大小写/空白不敏感）"
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goToMatch(matchCursor + (event.shiftKey ? -1 : 1))
              }
              if (event.key === 'Escape') closeSearch()
            }}
          />
          {searchActive && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--lume-text-muted)]" title="命中文件 / 命中文件总数">
              {matchedEntries.length ? `${matchCursor + 1}/${matchedEntries.length}` : '无命中'}
            </span>
          )}
          <Button variant="ghost" size="icon-xs" type="button" onClick={() => goToMatch(matchCursor - 1)} disabled={matchedEntries.length === 0} title="上一个命中（Shift+Enter）">
            <ChevronUp size={13} />
          </Button>
          <Button variant="ghost" size="icon-xs" type="button" onClick={() => goToMatch(matchCursor + 1)} disabled={matchedEntries.length === 0} title="下一个命中（Enter）">
            <ChevronDown size={13} />
          </Button>
          <Button variant="ghost" size="icon-xs" type="button" onClick={closeSearch} title="关闭查找">
            <X size={13} />
          </Button>
        </div>
      )}

      {!workspacePath ? (
        <GitPanelEmpty title="未绑定项目目录" hint="当前会话没有可读取 Git 状态的项目路径" />
      ) : (loading && !status) || branchNotLoaded ? (
        <div className="flex flex-1 items-center justify-center text-[var(--lume-text-muted)]"><Spinner /></div>
      ) : !status ? (
        <GitPanelEmpty title="无法读取 Git 状态" hint="读取状态时出错，请点击刷新重试" />
      ) : !status.isGitAvailable ? (
        <GitPanelEmpty title="Git 不可用" hint="未找到 git 命令，请确认已安装并加入 PATH" />
      ) : !status.isRepository ? (
        <GitPanelEmpty title="不是 Git 仓库" hint="当前项目目录未初始化 Git" />
      ) : changes.length === 0 ? (
        <GitPanelEmpty
          title={branchUnavailable
            ? '当前分支没有上游分支'
            : source === 'staged' ? '没有已暂存的更改' : source === 'branch' ? '没有领先上游分支的提交' : '没有未提交的更改'}
          hint={branchUnavailable
            ? 'git push -u 设置 upstream 后可在此比较未推送的提交'
            : source === 'staged' ? '使用 git add 暂存文件后会出现在这里' : source === 'branch' ? '当前分支与上游分支内容一致' : '工作区与暂存区当前是干净的'}
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
  const desktop = isDesktopRuntime()
  const copyPath = (text: string) => { void writeClipboardText(text).catch(() => undefined) }
  return (
    <div className="border-b border-[var(--lume-border-subtle)]/60">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[13px] transition-colors hover:bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,transparent)]"
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
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                className="mr-1 self-center"
                title="文件操作"
                onClick={(event) => event.stopPropagation()}
              />
            )}
          >
            <MoreVertical size={13} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {desktop && (
              <DropdownMenuItem onSelect={() => void revealPathInSystem(change.path).catch(() => undefined)}>
                在文件管理器中显示
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => copyPath(change.path)}>复制绝对路径</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copyPath(change.repoRelativePath)}>复制相对路径</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
