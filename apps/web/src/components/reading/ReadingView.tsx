import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Check,
  ImageDown,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { WEREAD_KEY_PAGE_URL, type ReadingLibrarySnapshot, type ReadingNoteSummary, type ReadingSearchResult } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom, tabsAtom, welcomePromptSeedAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { openExternal, revealPathInSystem } from '@/lib/desktop-api'
import {
  addReadingBook,
  generateReadingShareCard,
  getReadingSnapshot,
  getWereadBestBookmarks,
  getWereadBookmarks,
  getWereadNotebooks,
  getWereadPublicReviews,
  getWereadReadData,
  getWereadReviews,
  manualGenerateReadingNote,
  searchReadingWeread,
  getWereadShelf,
} from '@/lib/desktop-api/reading'
import { cn } from '@/lib/utils'
import {
  buildReadingBookRail,
  buildReadingOverviewStats,
  buildReadingWereadConnectionPrompt,
  buildReadingNoteNavigation,
  buildReadingSearchItems,
  buildWereadNotebookView,
  createDefaultWereadRailGroupState,
  extendReadingHoverNavUntil,
  getWereadTabForSelection,
  formatWereadNotebookBadgeLabel,
  normalizeWereadBookmarks,
  normalizeWereadReviews,
  shouldStartReadingRun,
  shouldShowReadingHoverNav,
  toggleWereadRailGroup,
  type ReadingRailItem,
  type WereadNotebookBook,
  type WereadRailGroupKey,
  type WereadReadingTab,
  type WereadTextItem,
} from './reading-view-state'

interface WereadBookDetailState {
  loading: boolean
  bookmarks: WereadTextItem[]
  reviews: WereadTextItem[]
  bestBookmarks: WereadTextItem[]
  publicReviews: WereadTextItem[]
  error?: string
}

interface WereadReadDataSummary {
  totalReadTime?: number
  readDays?: number
}

const readingThemeVars = {
  '--reading-accent': '#9a7444',
  '--reading-bg': 'color-mix(in oklab, var(--background) 96%, #f4ecdf)',
  '--reading-rail': 'color-mix(in oklab, var(--surface-1) 92%, #f4ecdf)',
  '--reading-panel': 'color-mix(in oklab, var(--surface-1) 88%, #f0e5d6)',
  '--reading-card': 'color-mix(in oklab, var(--surface-1) 96%, #fbf6ee)',
  '--reading-soft': 'color-mix(in oklab, var(--surface-2) 88%, #f4ecdf)',
  '--reading-active': 'color-mix(in oklab, #9a7444 16%, var(--surface-1))',
  '--reading-pill': 'color-mix(in oklab, #9a7444 14%, var(--surface-1))',
  '--reading-border': 'color-mix(in oklab, var(--border) 80%, #d9cdbb)',
  '--reading-serif': '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", STSong, SimSun, serif',
} as CSSProperties

export function ReadingView() {
  const [snapshot, setSnapshot] = useState<ReadingLibrarySnapshot | null>(null)
  const [selectedId, setSelectedId] = useState('__all__')
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchResults, setSearchResults] = useState<ReadingSearchResult[]>([])
  const [addingSearchItemId, setAddingSearchItemId] = useState<string | null>(null)
  const [runningReading, setRunningReading] = useState(false)
  const [wereadShelf, setWereadShelf] = useState<unknown>(null)
  const [wereadNotebooks, setWereadNotebooks] = useState<unknown>(null)
  const [wereadReadData, setWereadReadData] = useState<WereadReadDataSummary | null>(null)
  const [wereadDetails, setWereadDetails] = useState<Record<string, WereadBookDetailState>>({})
  const [wereadTab, setWereadTab] = useState<WereadReadingTab>('mine')
  const [hoverNoteId, setHoverNoteId] = useState<string | null>(null)
  const [navVisibleUntil, setNavVisibleUntil] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const noteRefs = useRef<Record<string, HTMLElement | null>>({})
  const runningReadingRef = useRef(false)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const nextSnapshot = await getReadingSnapshot()
      setSnapshot(nextSnapshot)
      if (nextSnapshot.wereadConnection.connected) {
        const [shelfResult, notebooksResult, readDataResult] = await Promise.all([
          getWereadShelf().catch((error) => {
            console.error('[ReadingView] 微信读书书架加载失败:', error)
            return null
          }),
          getWereadNotebooks().catch((error) => {
            console.error('[ReadingView] 微信读书笔记本加载失败:', error)
            return null
          }),
          getWereadReadData('monthly').catch((error) => {
            console.error('[ReadingView] 微信读书统计加载失败:', error)
            return null
          }),
        ])
        setWereadShelf(shelfResult)
        setWereadNotebooks(notebooksResult)
        setWereadReadData(readWereadReadDataSummary(readDataResult))
      } else {
        setWereadShelf(null)
        setWereadNotebooks(null)
        setWereadReadData(null)
        setWereadDetails({})
      }
    } catch (error) {
      console.error('[ReadingView] 加载失败:', error)
      toast.error('读书数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!navVisibleUntil) return
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [navVisibleUntil])

  const wereadView = useMemo(() => (
    snapshot?.wereadConnection.connected
      ? buildWereadNotebookView({ shelf: wereadShelf, notebooks: wereadNotebooks, snapshot })
      : null
  ), [snapshot, wereadNotebooks, wereadShelf])
  const rail = useMemo(() => snapshot ? buildReadingBookRail(snapshot, wereadView?.summary) : null, [snapshot, wereadView?.summary])
  const overviewStats = useMemo(() => snapshot ? buildReadingOverviewStats(snapshot) : null, [snapshot])
  const selectedWereadBook = useMemo(() => (
    wereadView?.books.find((book) => book.id === selectedId) ?? null
  ), [selectedId, wereadView])
  const selectReadingItem = useCallback((nextId: string) => {
    setWereadTab((currentTab) => getWereadTabForSelection(currentTab, selectedId, nextId))
    setSelectedId(nextId)
  }, [selectedId])

  useEffect(() => {
    if (!selectedWereadBook) return
    const bookId = selectedWereadBook.bookId
    const current = wereadDetails[bookId]
    if (current?.loading || current?.bookmarks || current?.reviews || current?.bestBookmarks || current?.publicReviews) return

    setWereadDetails((previous) => ({
      ...previous,
      [bookId]: {
        loading: true,
        bookmarks: [],
        reviews: [],
        bestBookmarks: [],
        publicReviews: [],
      },
    }))

    void Promise.allSettled([
      getWereadBookmarks(bookId),
      getWereadReviews(bookId),
      getWereadBestBookmarks(bookId, selectedWereadBook.title),
      getWereadPublicReviews(bookId, 'hot', selectedWereadBook.title),
    ]).then(([bookmarksResult, reviewsResult, bestResult, publicReviewsResult]) => {
      const bookmarksPayload = readSettledPayload(bookmarksResult)
      const reviewsPayload = readSettledPayload(reviewsResult)
      const bestPayload = readSettledPayload(bestResult)
      const publicReviewsPayload = readSettledPayload(publicReviewsResult)
      const personalFailed = bookmarksResult.status === 'rejected' && reviewsResult.status === 'rejected'
      for (const result of [bookmarksResult, reviewsResult, bestResult, publicReviewsResult]) {
        if (result.status === 'rejected') console.error('[ReadingView] 微信读书局部数据加载失败:', result.reason)
      }
      setWereadDetails((previous) => ({
        ...previous,
        [bookId]: {
          loading: false,
          bookmarks: normalizeWereadBookmarks(bookmarksPayload),
          reviews: normalizeWereadReviews(reviewsPayload),
          bestBookmarks: normalizeWereadBookmarks(bestPayload),
          publicReviews: normalizeWereadReviews(publicReviewsPayload),
          ...(personalFailed ? { error: '微信读书个人笔记加载失败' } : {}),
        },
      }))
    }).catch((error) => {
      console.error('[ReadingView] 微信读书笔记加载失败:', error)
      setWereadDetails((previous) => ({
        ...previous,
        [bookId]: {
          loading: false,
          bookmarks: [],
          reviews: [],
          bestBookmarks: [],
          publicReviews: [],
          error: getErrorMessage(error),
        },
      }))
    })
  }, [selectedWereadBook, wereadDetails])

  const visibleNotes = useMemo(() => {
    if (!snapshot) return []
    if (selectedWereadBook) {
      return snapshot.notes.filter((note) =>
        (selectedWereadBook.localBookId && note.bookId === selectedWereadBook.localBookId)
        || note.evidence.some((item) => item.sourceKind === 'weread' && item.sourceId === selectedWereadBook.bookId)
      )
    }
    if (selectedId === '__all__') return snapshot.notes
    if (selectedId === '__poetry__') return snapshot.notes.filter((note) => note.book?.title.includes('诗') || note.evidence.some((item) => item.sourceKind === 'poetry'))
    return snapshot.notes.filter((note) => note.bookId === selectedId)
  }, [selectedId, selectedWereadBook, snapshot])
  const noteIds = visibleNotes.map((note) => note.id)
  const navigation = buildReadingNoteNavigation(noteIds, hoverNoteId)
  const showNav = hoverNoteId !== null && shouldShowReadingHoverNav(clock, navVisibleUntil)
  const searchItems = useMemo(() => (
    snapshot ? buildReadingSearchItems(searchResults, snapshot.books) : []
  ), [searchResults, snapshot])
  const wereadPrompt = useMemo(() => (
    snapshot ? buildReadingWereadConnectionPrompt(snapshot) : null
  ), [snapshot])
  const canRunReading = selectedWereadBook
    ? Boolean(selectedWereadBook.localBookId)
    : (snapshot?.books.length ?? 0) > 0
  const currentWorkspaceSlug = useMemo(() => (
    workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug
  ), [currentWorkspaceId, workspaces])

  const handleSearch = async () => {
    const query = searchDraft.trim()
    if (!query) return
    try {
      const results = await searchReadingWeread({ query, limit: 5 })
      setSearchResults(results)
      toast.success(results.length > 0 ? `找到 ${results.length} 本书` : '没有找到匹配书籍')
    } catch (error) {
      console.error('[ReadingView] 搜索失败:', error)
      toast.error('搜索失败')
    }
  }

  const handleAddSearchItem = async (itemId: string) => {
    const item = searchItems.find((candidate) => candidate.id === itemId)
    if (!item || item.alreadyAdded) return
    setAddingSearchItemId(itemId)
    try {
      const book = await addReadingBook(item.addBookInput)
      setSelectedId(book.id)
      setSearchResults([])
      setSearchDraft('')
      await load()
      toast.success('已加入书架')
    } catch (error) {
      console.error('[ReadingView] 添加书籍失败:', error)
      toast.error('添加书籍失败')
    } finally {
      setAddingSearchItemId(null)
    }
  }

  const handleRunReading = async () => {
    if (!shouldStartReadingRun(runningReading, runningReadingRef.current)) return
    runningReadingRef.current = true
    setRunningReading(true)
    try {
      const targetBookId = selectedWereadBook?.localBookId ?? (selectedId.startsWith('__') || selectedId.startsWith('weread:') ? undefined : selectedId)
      const result = await manualGenerateReadingNote({
        trigger: 'manual',
        ...(targetBookId ? { bookId: targetBookId } : {}),
        depth: 'seed',
        ...(currentWorkspaceSlug ? { workspaceSlug: currentWorkspaceSlug } : {}),
      })
      await load()
      toast.success(result.message)
    } catch (error) {
      console.error('[ReadingView] 读书任务失败:', error)
      toast.error('读书任务失败')
    } finally {
      runningReadingRef.current = false
      setRunningReading(false)
    }
  }

  const openChatWithNote = (note: ReadingNoteSummary) => {
    setWelcomePromptSeed(`想和 Lume 聊聊这条读书笔记：reading-note:${note.id}。只需要带着这个轻量上下文进入聊天，不要复制整篇笔记。`)
    setTabs((previous) => {
      const workspaceId = currentWorkspaceId ?? undefined
      const existing = previous.find((tab) => tab.id === '__welcome__')
      if (existing) {
        return previous.map((tab) => tab.id === '__welcome__' ? { ...tab, workspaceId } : tab)
      }
      return [{ id: '__welcome__', type: 'welcome' as const, title: '新会话', workspaceId }, ...previous]
    })
    setActiveTabId('__welcome__')
  }

  const openReadingSettings = () => {
    const settingsId = '__settings__'
    setSettingsInitialTab('reading')
    setTabs((previous) => (
      previous.some((tab) => tab.id === settingsId)
        ? previous
        : [...previous, { id: settingsId, type: 'settings' as const, title: '设置' }]
    ))
    setActiveTabId(settingsId)
  }

  const openWereadKeyPage = async () => {
    try {
      await openExternal(WEREAD_KEY_PAGE_URL)
    } catch (error) {
      console.error('[ReadingView] 打开微信读书 API Key 页面失败:', error)
      toast.error('打开微信读书页面失败')
    }
  }

  const saveShareCard = async (note: ReadingNoteSummary) => {
    try {
      const result = await generateReadingShareCard({ noteId: note.id })
      await load()
      if (result.path) {
        try {
          await revealPathInSystem(result.path)
        } catch (error) {
          console.error('[ReadingView] 定位分享卡片失败:', error)
          toast.warning('分享卡片已生成，但定位文件失败')
          return
        }
      }
      toast.success(result.path ? '分享卡片已生成' : '已准备分享卡片')
    } catch (error) {
      console.error('[ReadingView] 分享卡片生成失败:', error)
      toast.error('分享卡片生成失败')
    }
  }

  const scrollToNote = (id: string | null) => {
    if (!id) return
    noteRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setHoverNoteId(id)
    setNavVisibleUntil(extendReadingHoverNavUntil(Date.now()))
  }

  if (loading && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[var(--background)] text-[13px] text-[var(--text-3)]">
        正在整理读书笔记
      </div>
    )
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--reading-bg)] text-[var(--text-1)]"
      style={readingThemeVars}
    >
      <aside className="hidden h-full min-h-0 w-[212px] shrink-0 overflow-hidden border-r border-[var(--reading-border)] bg-[var(--reading-rail)] px-3 py-4 lg:block">
        <div className="flex h-full min-h-0 flex-col gap-4">
          <div className="shrink-0 space-y-2">
            {rail?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectReadingItem(item.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors',
                  selectedId === item.id
                    ? 'bg-[var(--reading-active)] text-[var(--text-1)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                )}
              >
                <BookThumb title={item.title} coverUrl={item.coverUrl} muted={item.kind !== 'book'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-normal">{item.title}</span>
                  <ReadingRailItemMeta item={item} />
                </span>
              </button>
            ))}
          </div>

          {rail?.showWereadPrompt && wereadPrompt && (
            <div className="shrink-0 rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] p-3">
              <div className="text-[13px] font-semibold text-[var(--text-1)]">{wereadPrompt.title}</div>
              <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{wereadPrompt.body}</p>
              <button
                type="button"
                onClick={openReadingSettings}
                className="mt-2 h-8 w-full rounded-[6px] bg-[var(--text-1)] text-[12px] font-medium text-[var(--surface-1)]"
              >
                {wereadPrompt.actionLabel}
              </button>
            </div>
          )}

          {wereadView?.books.length ? (
            <WereadRail
              books={wereadView.books}
              selectedId={selectedId}
              summary={wereadView.summary}
              onSelect={selectReadingItem}
            />
          ) : null}
        </div>
      </aside>

      <ScrollArea className="min-h-0 w-full min-w-0 flex-1">
        <div className="flex min-h-full w-full justify-center">
          <main className="w-full max-w-[980px] px-5 py-7 lg:px-8">
            {!selectedWereadBook && (
              <div className="flex items-center justify-between gap-4">
                <h1 className="text-[21px] font-semibold tracking-normal">一起读书</h1>
                <div className="flex items-center gap-2">
                  <div className="relative hidden md:block">
                    <div className="flex h-9 items-center gap-2 rounded-[8px] bg-[var(--reading-card)] px-3">
                      <Search size={15} className="text-[var(--text-3)]" />
                      <input
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') void handleSearch() }}
                        placeholder="搜索书籍"
                        className="w-[132px] bg-transparent text-[13px] outline-none placeholder:text-[var(--text-3)]"
                      />
                    </div>
                    {searchItems.length > 0 && (
                      <div className="absolute right-0 top-11 z-40 w-[360px] overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_18px_42px_-26px_rgba(18,22,32,0.42)]">
                        {searchItems.map((item) => (
                          <div key={item.id} className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0">
                            <BookThumb title={item.title} coverUrl={item.coverUrl} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-semibold text-[var(--text-1)]">{item.title}</div>
                              <div className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">{item.author ?? '未知作者'}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleAddSearchItem(item.id)}
                              disabled={item.alreadyAdded || addingSearchItemId === item.id}
                              className="flex size-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)] disabled:cursor-default disabled:opacity-60"
                              title={item.alreadyAdded ? '已在书架' : '加入书架'}
                            >
                              {item.alreadyAdded ? <Check size={15} /> : <Plus size={15} />}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {canRunReading && (
                    <button
                      type="button"
                      onClick={handleRunReading}
                      disabled={runningReading}
                      className="flex h-9 items-center gap-2 rounded-[8px] bg-[var(--reading-accent)] px-3 text-[13px] font-medium text-white disabled:cursor-wait disabled:opacity-70"
                    >
                      <RefreshCw size={15} className={runningReading ? 'animate-spin' : undefined} />
                      {runningReading ? '正在写' : '写一条'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {selectedWereadBook ? (
              <WereadBookPanel
                book={selectedWereadBook}
                detail={wereadDetails[selectedWereadBook.bookId]}
                localNotes={visibleNotes}
                readData={wereadReadData}
                tab={wereadTab}
                runningReading={runningReading}
                onTabChange={setWereadTab}
                onRunReading={() => void handleRunReading()}
                onChatWithNote={openChatWithNote}
                onSaveShareCard={(note) => void saveShareCard(note)}
              />
            ) : (
              <>
                <section className="mt-5 rounded-[8px] bg-[var(--reading-panel)] p-4">
                  <div className="mb-3 text-[14px] font-semibold text-[var(--reading-accent)]">Lume 在读</div>
                  <div className="grid grid-cols-3 divide-x divide-[var(--reading-border)] border-t border-[var(--reading-border)] pt-4">
                    <StatValue value={overviewStats?.readingCount ?? 0} label="在读" />
                    <StatValue value={overviewStats?.noteCount ?? 0} label="读书笔记" />
                    <StatValue value={overviewStats?.finishedCount ?? 0} label="已读完" />
                  </div>
                </section>

                {wereadView && snapshot?.wereadConnection.connected && (
                  <section className="mt-4 rounded-[8px] bg-[var(--reading-panel)] p-4">
                    <div className="mb-3 text-[14px] font-semibold text-[var(--text-3)]">我的微信读书</div>
                    <div className="grid grid-cols-5 divide-x divide-[var(--reading-border)] border-t border-[var(--reading-border)] pt-4">
                      <StatValue value={wereadView.summary.readingCount} label="在读" />
                      <StatValue value={wereadView.summary.finishedCount} label="已读完" />
                      <StatValue value={wereadView.summary.highlightCount + wereadView.summary.thoughtCount} label="划线/想法" />
                      <StatValue value={formatWereadReadHours(wereadReadData?.totalReadTime)} label="累计阅读" />
                      <StatValue value={wereadReadData?.readDays ?? 0} label="阅读天数" />
                    </div>
                  </section>
                )}

                {wereadPrompt && (
                  <section className="mt-4 rounded-[8px] bg-[var(--reading-panel)] p-4">
                    <div className="text-[15px] font-semibold text-[var(--text-1)]">把你的微信读书也连上来?</div>
                    <p className="mt-1 text-[13px] leading-6 text-[var(--text-3)]">
                      连接后，Lume 能看到你的书架、划线和想法，聊到相关话题时会自动关联你读过的内容，也能帮你整理别人精彩的书评。
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => void openWereadKeyPage()}
                        className="h-9 rounded-[6px] bg-[var(--text-1)] text-[13px] font-medium text-[var(--surface-1)]"
                      >
                        获取 API KEY
                      </button>
                      <button
                        type="button"
                        onClick={openReadingSettings}
                        className="h-9 rounded-[6px] bg-[var(--reading-card)] text-[13px] font-medium text-[var(--text-1)]"
                      >
                        去设置中填入
                      </button>
                    </div>
                  </section>
                )}

                <div className="my-6 flex items-center gap-4 text-[12px] text-[var(--text-3)]">
                  <div className="h-px flex-1 bg-[var(--reading-border)]" />
                  <span>读书笔记</span>
                  <div className="h-px flex-1 bg-[var(--reading-border)]" />
                </div>

                <div className="space-y-5">
                  {visibleNotes.length === 0 && (
                    <div className="rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] px-6 py-6 text-center text-[13px] text-[var(--text-3)]">
                      还没有读书笔记
                    </div>
                  )}
                  {visibleNotes.map((note) => (
                    <article
                      key={note.id}
                      ref={(element) => { noteRefs.current[note.id] = element }}
                      onMouseEnter={() => {
                        setHoverNoteId(note.id)
                        setNavVisibleUntil(extendReadingHoverNavUntil(Date.now()))
                        setClock(Date.now())
                      }}
                      className="rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] p-5 shadow-[0_10px_28px_-24px_rgba(18,22,32,0.32)]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h2 className="[font-family:var(--reading-serif)] text-[16px] font-medium leading-6">{note.book ? `《${note.book.title}》` : note.title}</h2>
                          <div className="mt-1 text-[12px] text-[var(--text-3)]">
                            {[note.book?.author, typeof note.progressPercent === 'number' ? `${Math.round(note.progressPercent)}%` : undefined].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div className="text-[12px] text-[var(--text-3)]">{formatNoteDate(note.createdAt)}</div>
                      </div>

                      {note.excerpt && (
                        <blockquote className="mt-4 rounded-[8px] bg-[var(--reading-soft)] px-3.5 py-2.5 [font-family:var(--reading-serif)] text-[13px] italic leading-6 text-[var(--text-2)]">
                          “{note.excerpt}”
                        </blockquote>
                      )}

                      <div className="mt-4 whitespace-pre-wrap [font-family:var(--reading-serif)] text-[13.5px] leading-[1.85] text-[var(--text-1)]">{note.body}</div>

                      {note.tags.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-1.5">
                          {note.tags.map((tag) => (
                            <span key={tag} className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[11px] text-[var(--text-3)]">{tag}</span>
                          ))}
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11px] text-[var(--text-3)]">
                        <div className="min-w-0 flex-1 truncate">
                          {note.evidence[0]?.location ? `来源位置 ${note.evidence[0].location}` : '来源已记录'}
                        </div>
                        <div className="flex items-center gap-3">
                          <button type="button" onClick={() => openChatWithNote(note)} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
                            <MessageSquare size={14} />
                            聊一聊
                          </button>
                          <button type="button" onClick={() => void saveShareCard(note)} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
                            <ImageDown size={14} />
                            存为图片
                          </button>
                        </div>
                      </div>
                      {note.aiGenerated && (
                        <div className="mt-1.5 text-right text-[11px] italic text-[var(--text-3)]">以上内容均由 AI 生成，纯属虚构，请注意甄别</div>
                      )}
                    </article>
                  ))}
                </div>
              </>
            )}
          </main>
        </div>
      </ScrollArea>

      {showNav && (
        <div className="fixed right-6 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-[0_18px_40px_-28px_rgba(18,22,32,0.42)]">
          <NavButton title="顶部" onClick={() => scrollToNote(navigation.topId)} icon={<ChevronsUp size={17} />} />
          <NavButton title="上一条" onClick={() => scrollToNote(navigation.previousId)} icon={<ChevronUp size={17} />} />
          <NavButton title="下一条" onClick={() => scrollToNote(navigation.nextId)} icon={<ChevronDown size={17} />} />
          <NavButton title="底部" onClick={() => scrollToNote(navigation.bottomId)} icon={<ChevronsDown size={17} />} />
        </div>
      )}
    </div>
  )
}

function WereadRail({
  books,
  selectedId,
  summary,
  onSelect,
}: {
  books: WereadNotebookBook[]
  selectedId: string
  summary: {
    localNoteCount: number
    highlightCount: number
    readingCount: number
    finishedCount: number
  }
  onSelect: (id: string) => void
}) {
  const [expandedGroups, setExpandedGroups] = useState(createDefaultWereadRailGroupState)
  const readingBooks = books.filter((book) => book.status === 'reading')
  const finishedBooks = books.filter((book) => book.status === 'finished')
  const toggleGroup = (key: WereadRailGroupKey) => {
    setExpandedGroups((previous) => toggleWereadRailGroup(previous, key))
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-t border-[var(--reading-border)]" />
      <div className="mt-1 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <WereadRailGroup
          title={`在读 · ${summary.readingCount}`}
          books={readingBooks}
          selectedId={selectedId}
          expanded={expandedGroups.reading}
          onToggle={() => toggleGroup('reading')}
          onSelect={onSelect}
        />
        <WereadRailGroup
          title={`已读完 · ${summary.finishedCount}`}
          books={finishedBooks}
          selectedId={selectedId}
          expanded={expandedGroups.finished}
          onToggle={() => toggleGroup('finished')}
          onSelect={onSelect}
        />
      </div>
    </div>
  )
}

function WereadRailGroup({
  title,
  books,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  title: string
  books: WereadNotebookBook[]
  selectedId: string
  expanded: boolean
  onToggle: () => void
  onSelect: (id: string) => void
}) {
  if (books.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="mb-2 flex h-6 w-full items-center justify-between rounded-[6px] px-1 text-left text-[12px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
      >
        <span>{title}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && <div className="space-y-1.5">
        {books.map((book) => (
          <WereadRailBookButton
            key={book.id}
            book={book}
            selected={selectedId === book.id}
            onSelect={() => onSelect(book.id)}
          />
        ))}
      </div>}
    </div>
  )
}

function WereadRailBookButton({
  book,
  selected,
  onSelect,
}: {
  book: WereadNotebookBook
  selected: boolean
  onSelect: () => void
}) {
  const badgeLabel = formatWereadNotebookBadgeLabel(book.noteCount)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex min-h-[64px] w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors',
        selected
          ? 'bg-[var(--reading-active)] text-[var(--text-1)]'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
      )}
    >
      <BookThumb title={book.title} coverUrl={book.coverUrl} size="large" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] font-normal leading-[18px]">{book.title}</span>
        {badgeLabel && (
          <span className="mt-1 inline-flex max-w-full rounded-full bg-[var(--reading-pill)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--reading-accent)]">
            {badgeLabel}
          </span>
        )}
      </span>
      {book.progressLabel && (
        <span className="shrink-0 text-[12px] text-[var(--text-3)]">{book.progressLabel}</span>
      )}
    </button>
  )
}

function WereadBookPanel({
  book,
  detail,
  localNotes,
  readData,
  tab,
  runningReading,
  onTabChange,
  onRunReading,
  onChatWithNote,
  onSaveShareCard,
}: {
  book: WereadNotebookBook
  detail?: WereadBookDetailState
  localNotes: ReadingNoteSummary[]
  readData: WereadReadDataSummary | null
  tab: WereadReadingTab
  runningReading: boolean
  onTabChange: (tab: WereadReadingTab) => void
  onRunReading: () => void
  onChatWithNote: (note: ReadingNoteSummary) => void
  onSaveShareCard: (note: ReadingNoteSummary) => void
}) {
  const loading = detail?.loading
  const bookmarks = detail?.bookmarks ?? []
  const reviews = detail?.reviews ?? []
  const bestBookmarks = detail?.bestBookmarks ?? []
  const publicReviews = detail?.publicReviews ?? []
  return (
    <section>
      <div className="mx-auto max-w-[760px]">
        <div>
          <h2 className="text-[20px] font-semibold leading-8">《{book.title}》</h2>
          <div className="mt-1 text-[13px] text-[var(--text-3)]">
            {[book.author, `${book.noteCount} 条笔记`, '微信读书', readData?.readDays ? `${readData.readDays} 天阅读` : undefined].filter(Boolean).join(' · ')}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 overflow-hidden rounded-[8px] bg-[var(--reading-panel)] p-1">
          <WereadTabButton active={tab === 'mine'} onClick={() => onTabChange('mine')} label="我的笔记" count={book.noteCount} />
          <WereadTabButton active={tab === 'popular'} onClick={() => onTabChange('popular')} label="他人精华" />
          <WereadTabButton active={tab === 'notes'} onClick={() => onTabChange('notes')} label="读书笔记" count={localNotes.length} />
        </div>

        {tab === 'mine' && (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[8px] bg-[var(--reading-panel)] p-4">
                <div className="text-[25px] font-semibold leading-none text-[var(--reading-accent)]">{book.highlightCount}</div>
                <div className="mt-2 text-[13px] text-[var(--text-3)]">划线</div>
              </div>
              <div className="rounded-[8px] bg-[var(--reading-panel)] p-4">
                <div className="text-[25px] font-semibold leading-none text-[var(--reading-accent)]">{book.thoughtCount}</div>
                <div className="mt-2 text-[13px] text-[var(--text-3)]">想法</div>
              </div>
            </div>
            {loading && <WereadEmptyText text="正在读取微信读书笔记" />}
            {detail?.error && <WereadEmptyText text={detail.error} />}
            {!loading && !detail?.error && bookmarks.length === 0 && reviews.length === 0 && (
              <WereadEmptyText text="这本书还没有划线和想法" />
            )}
            <WereadTextList items={bookmarks} />
            {reviews.length > 0 && <div className="pt-1 text-[13px] font-semibold text-[var(--text-3)]">我的想法</div>}
            <WereadTextList items={reviews} alignDate />
          </div>
        )}

        {tab === 'popular' && (
          <div className="mt-4 space-y-4">
            {loading && <WereadEmptyText text="正在读取他人精华" />}
            {!loading && bestBookmarks.length === 0 && publicReviews.length === 0 && (
              <WereadEmptyText text="暂无他人划线和评价" />
            )}
            {bestBookmarks.length > 0 && <div className="text-[13px] font-semibold text-[var(--text-3)]">热门划线</div>}
            <WereadTextList items={bestBookmarks} showTotal />
            {publicReviews.length > 0 && <div className="pt-1 text-[13px] font-semibold text-[var(--text-3)]">书友评价</div>}
            <WereadTextList items={publicReviews} showAuthor showTotal />
          </div>
        )}

        {tab === 'notes' && (
          <div className="mt-4 space-y-4">
            {localNotes.length === 0 ? (
              <div className="rounded-[8px] bg-[var(--reading-panel)] px-5 py-7 text-center">
                <div className="text-[13px] text-[var(--text-3)]">还没有读书笔记</div>
                {book.localBookId && (
                  <button
                    type="button"
                    onClick={onRunReading}
                    disabled={runningReading}
                    className="mt-4 rounded-[8px] bg-[var(--reading-accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-65"
                  >
                    {runningReading ? 'Lume 正在认真读...' : '让 Lume 帮我写一份'}
                  </button>
                )}
              </div>
            ) : localNotes.map((note) => (
              <article key={note.id} className="rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="[font-family:var(--reading-serif)] text-[15px] font-medium leading-6">{note.title}</h3>
                    <div className="mt-1 text-[12px] text-[var(--text-3)]">
                      {[note.book?.author ?? book.author, formatNoteDate(note.createdAt)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
                {note.excerpt && (
                  <blockquote className="mt-3 rounded-[8px] bg-[var(--reading-soft)] px-3.5 py-2.5 [font-family:var(--reading-serif)] text-[12.5px] italic leading-6 text-[var(--text-2)]">
                    “{note.excerpt}”
                  </blockquote>
                )}
                <div className="mt-3 whitespace-pre-wrap [font-family:var(--reading-serif)] text-[13px] leading-[1.85]">{note.body}</div>
                <div className="mt-3 flex justify-end gap-3 text-[11px] text-[var(--text-3)]">
                  <button type="button" onClick={() => onChatWithNote(note)} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
                    <MessageSquare size={14} />
                    聊一聊
                  </button>
                  <button type="button" onClick={() => onSaveShareCard(note)} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
                    <ImageDown size={14} />
                    存为图片
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function WereadTabButton({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-10 rounded-[7px] text-[13px] font-medium transition-colors',
        active ? 'bg-[var(--reading-active)] text-[var(--text-1)]' : 'text-[var(--text-3)] hover:text-[var(--text-1)]',
      )}
    >
      {label}{typeof count === 'number' && count > 0 ? ` · ${count}` : ''}
    </button>
  )
}

function WereadTextList({
  items,
  alignDate,
  showAuthor,
  showTotal,
}: {
  items: WereadTextItem[]
  alignDate?: boolean
  showAuthor?: boolean
  showTotal?: boolean
}) {
  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.id}>
          {item.chapterTitle && <div className="mb-1.5 text-[11px] text-[var(--text-3)]">{item.chapterTitle}</div>}
          <div className="rounded-[8px] bg-[var(--reading-panel)] px-3.5 py-3 [font-family:var(--reading-serif)] text-[13px] leading-[1.85] text-[var(--text-1)]">
            <div>{item.text}</div>
            {(item.createdAt || item.authorName || item.totalCount) && (
              <div className={cn('mt-2 text-[11px] text-[var(--text-3)]', alignDate && 'text-right')}>
                {[
                  showAuthor ? item.authorName : undefined,
                  showTotal && typeof item.totalCount === 'number' ? `${item.totalCount} 人划线` : undefined,
                  item.createdAt ? formatWereadDate(item.createdAt) : undefined,
                ].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function WereadEmptyText({ text }: { text: string }) {
  return (
    <div className="rounded-[8px] bg-[var(--reading-panel)] px-5 py-6 text-center text-[13px] text-[var(--text-3)]">
      {text}
    </div>
  )
}

function BookThumb({
  title,
  coverUrl,
  muted,
  size = 'normal',
}: {
  title: string
  coverUrl?: string
  muted?: boolean
  size?: 'normal' | 'large'
}) {
  return (
    <span className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] text-[12px] font-normal',
      size === 'large' ? 'h-[50px] w-9' : 'h-11 w-8',
      muted && 'h-8 w-8 rounded-[8px] text-[var(--text-3)]',
    )}>
      {coverUrl ? <img src={coverUrl} alt="" className="h-full w-full object-cover" /> : muted ? <BookOpen size={15} /> : title.slice(0, 1)}
    </span>
  )
}

function ReadingRailItemMeta({ item }: { item: ReadingRailItem }) {
  if (item.kind === 'book') {
    return (
      <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-3)]">
        {item.subtitle && <span className="min-w-0 truncate">{item.subtitle}</span>}
        {item.progressLabel && <span className="shrink-0">{item.progressLabel}</span>}
      </span>
    )
  }
  return (
    <span className="mt-0.5 block truncate text-[11px] text-[var(--text-3)]">
      {item.subtitle}
    </span>
  )
}

function StatValue({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="text-center">
      <div className="text-[26px] font-semibold leading-none text-[var(--reading-accent)]">{value}</div>
      <div className="mt-2 text-[12px] text-[var(--text-3)]">{label}</div>
    </div>
  )
}

function formatWereadReadHours(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '0h'
  return `${Math.round(seconds / 3600)}h`
}

function NavButton({ title, icon, onClick }: { title: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
    >
      {icon}
    </button>
  )
}

function formatNoteDate(value: number): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function formatWereadDate(value: number): string {
  const timestamp = value < 100_000_000_000 ? value * 1000 : value
  const date = new Date(timestamp)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function readWereadReadDataSummary(payload: unknown): WereadReadDataSummary | null {
  if (!isRecord(payload)) return null
  return {
    ...(readNumber(payload.totalReadTime) ? { totalReadTime: readNumber(payload.totalReadTime) } : {}),
    ...(readNumber(payload.readDays) ? { readDays: readNumber(payload.readDays) } : {}),
  }
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readSettledPayload(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'fulfilled' ? result.value : null
}
