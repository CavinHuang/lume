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
  X,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { XMarkdown } from '@ant-design/x-markdown'
import { WEREAD_KEY_PAGE_URL, type ReadingAddBookInput, type ReadingLibrarySnapshot, type ReadingNoteSummary, type ReadingSearchResult, type ReadingSourceKind } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom, tabsAtom, welcomePromptSeedAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { openExternal, revealPathInSystem, saveFilePathDialog, writeBinaryFile } from '@/lib/desktop-api'
import {
  addReadingBook,
  getReadingSnapshot,
  getWereadBestBookmarks,
  getWereadBookmarks,
  getWereadNotebooks,
  getWereadPublicReviews,
  getWereadReadData,
  getWereadReviews,
  manualGenerateReadingNote,
  searchReadingBooks,
  getWereadShelf,
} from '@/lib/desktop-api/reading'
import { cn } from '@/lib/utils'
import {
  buildReadingBookRail,
  buildManualReadingRunInput,
  buildReadingOverviewStats,
  buildReadingWereadConnectionPrompt,
  buildReadingNoteNavigation,
  buildReadingSearchItems,
  buildShareCardFilename,
  buildWereadNotebookView,
  createDefaultWereadRailGroupState,
  extendReadingHoverNavUntil,
  getWereadTabForSelection,
  formatWereadNotebookBadgeLabel,
  getReadingTaskToastKind,
  normalizeWereadBookmarks,
  normalizeWereadReadDataSummary,
  normalizeWereadReviews,
  shouldStartReadingRun,
  shouldShowReadingHoverNav,
  toggleWereadRailGroup,
  type ReadingRailItem,
  type WereadNotebookBook,
  type WereadRailGroupKey,
  type WereadReadDataSummary,
  type WereadReadingTab,
  type WereadTextItem,
} from './reading-view-state'
import { renderReadingCardElementToPngBase64 } from './reading-card-export'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface WereadBookDetailState {
  loading: boolean
  bookmarks: WereadTextItem[]
  reviews: WereadTextItem[]
  bestBookmarks: WereadTextItem[]
  publicReviews: WereadTextItem[]
  error?: string
}

const readingThemeVars = {
  '--reading-accent': 'var(--brand)',
  '--reading-accent-foreground': 'var(--brand-foreground)',
  '--reading-bg': 'var(--background)',
  '--reading-rail': 'var(--surface-1)',
  '--reading-panel': 'var(--surface-2)',
  '--reading-card': 'var(--surface-1)',
  '--reading-soft': 'var(--surface-2)',
  '--reading-active': 'color-mix(in oklab, var(--brand) 10%, var(--surface-1))',
  '--reading-pill': 'color-mix(in oklab, var(--brand) 8%, var(--surface-1))',
  '--reading-border': 'color-mix(in oklab, var(--border) 52%, transparent)',
  '--reading-serif': '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", STSong, SimSun, serif',
} as CSSProperties

export function ReadingView() {
  const [snapshot, setSnapshot] = useState<ReadingLibrarySnapshot | null>(null)
  const [selectedId, setSelectedId] = useState('__all__')
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchResults, setSearchResults] = useState<ReadingSearchResult[]>([])
  const [addingSearchItemId, setAddingSearchItemId] = useState<string | null>(null)
  const [searchModalOpen, setSearchModalOpen] = useState(false)
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
          getWereadReadData('all').catch((error) => {
            console.error('[ReadingView] 微信读书统计加载失败:', error)
            return null
          }),
        ])
        setWereadShelf(shelfResult)
        setWereadNotebooks(notebooksResult)
        setWereadReadData(normalizeWereadReadDataSummary(readDataResult))
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
      const results = await searchReadingBooks({ query, limit: 10 })
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
      const result = await manualGenerateReadingNote(buildManualReadingRunInput({
        selectedId,
        selectedWereadLocalBookId: selectedWereadBook?.localBookId,
        currentWorkspaceSlug,
      }))
      await load()
      const toastKind = getReadingTaskToastKind(result.status)
      if (toastKind === 'error') {
        toast.error(result.message)
      } else if (toastKind === 'warning') {
        toast.warning(result.message)
      } else {
        toast.success(result.message)
      }
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

  const saveShareCard = async (note: ReadingNoteSummary, cardElement?: HTMLElement | null) => {
    try {
      if (!cardElement) {
        toast.error('没有找到要保存的读书卡片')
        return
      }
      const selected = await saveFilePathDialog(buildShareCardFilename(note), [
        { name: 'PNG 图片', extensions: ['png'] },
      ])
      if (!selected.path) return
      const outputPath = ensurePngPath(selected.path)
      const pngBase64 = await renderReadingCardElementToPngBase64(cardElement)
      const result = await writeBinaryFile(outputPath, pngBase64)
      try {
        await revealPathInSystem(result.path)
      } catch (error) {
        console.error('[ReadingView] 定位分享卡片失败:', error)
        toast.warning('读书卡片已保存，但定位文件失败')
        return
      }
      toast.success('读书卡片已保存')
    } catch (error) {
      console.error('[ReadingView] 读书卡片保存失败:', error)
      toast.error(`读书卡片保存失败：${getErrorMessage(error)}`)
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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <aside className="hidden h-full min-h-0 w-[212px] shrink-0 overflow-hidden border-r border-[var(--reading-border)] bg-[var(--reading-rail)] px-3 py-4 lg:block">
            <div className="flex h-full min-h-0 flex-col gap-4">
              <div className="flex shrink-0 flex-col gap-3">
                {rail?.items.map((item) => (
                  <Button
                variant="ghost"
                    key={item.id}
                    type="button"
                    onClick={() => selectReadingItem(item.id)}
                    className={cn(
                      'flex h-auto w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors',
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
                  </Button>
                ))}
              </div>

              {rail?.showWereadPrompt && wereadPrompt && (
                <div className="shrink-0 rounded-[8px] bg-[var(--reading-card)] p-3">
                  <div className="text-[13px] font-semibold text-[var(--text-1)]">{wereadPrompt.title}</div>
                  <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{wereadPrompt.body}</p>
                  <Button
                variant="ghost"
                    type="button"
                    onClick={openReadingSettings}
                    className="mt-2 h-8 w-full rounded-[6px] bg-[var(--brand)] text-[12px] font-medium text-[var(--brand-foreground)]"
                  >
                    {wereadPrompt.actionLabel}
                  </Button>
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
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => setSearchModalOpen(true)}
                    className="flex h-9 items-center gap-2 rounded-[8px] bg-[var(--reading-card)] px-3 text-[13px] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
                  >
                    <Search size={15} />
                    搜索书籍
                  </Button>
                  {canRunReading && (
                    <Button
                variant="ghost"
                      type="button"
                      onClick={handleRunReading}
                      disabled={runningReading}
                      className="flex h-9 items-center gap-2 rounded-[8px] bg-[var(--reading-accent)] px-3 text-[13px] font-medium text-[var(--reading-accent-foreground)] disabled:cursor-wait disabled:opacity-70"
                    >
                      <RefreshCw size={15} className={runningReading ? 'animate-spin' : undefined} />
                      {runningReading ? '正在写' : '写一条'}
                    </Button>
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
                onSaveShareCard={(note, cardElement) => void saveShareCard(note, cardElement)}
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
                      <Button
                variant="ghost"
                        type="button"
                        onClick={() => void openWereadKeyPage()}
                        className="h-9 rounded-[6px] bg-[var(--brand)] text-[13px] font-medium text-[var(--brand-foreground)]"
                      >
                        获取 API KEY
                      </Button>
                      <Button
                variant="ghost"
                        type="button"
                        onClick={openReadingSettings}
                        className="h-9 rounded-[6px] bg-[var(--reading-card)] text-[13px] font-medium text-[var(--text-1)]"
                      >
                        去设置中填入
                      </Button>
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
                    <div className="rounded-[8px] bg-[var(--reading-card)] px-6 py-6 text-center text-[13px] text-[var(--text-3)]">
                      还没有读书笔记
                    </div>
                  )}
                  {visibleNotes.map((note) => (
                    <div
                      key={note.id}
                      onMouseEnter={() => {
                        setHoverNoteId(note.id)
                        setNavVisibleUntil(extendReadingHoverNavUntil(Date.now()))
                        setClock(Date.now())
                      }}
                      className="space-y-2"
                    >
                      <article
                        ref={(element) => { noteRefs.current[note.id] = element }}
                        className="rounded-[8px] bg-[var(--reading-card)] p-5"
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

                        <ReadingNoteBody body={note.body} className="mt-4" />

                        {note.tags.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-1.5">
                            {note.tags.map((tag) => (
                              <span key={tag} className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[11px] text-[var(--text-3)]">{tag}</span>
                            ))}
                          </div>
                        )}

                        <div className="mt-4 text-[11px] text-[var(--text-3)]">
                          <div className="min-w-0 truncate">
                            {note.evidence[0]?.location ? `来源位置 ${note.evidence[0].location}` : '来源已记录'}
                          </div>
                        </div>
                        {note.aiGenerated && (
                          <div className="mt-1.5 text-right text-[11px] italic text-[var(--text-3)]">以上内容均由 AI 生成，纯属虚构，请注意甄别</div>
                        )}
                      </article>
                      <ReadingNoteActions
                        onChat={() => openChatWithNote(note)}
                        onSave={() => void saveShareCard(note, noteRefs.current[note.id])}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </main>
        </div>
      </ScrollArea>
        </div>
      </div>

      {showNav && (
        <div className="fixed right-6 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-[8px] bg-[var(--surface-1)] p-1 shadow-[0_14px_36px_-28px_hsl(var(--lume-shadow-panel)/0.5)]">
          <NavButton title="顶部" onClick={() => scrollToNote(navigation.topId)} icon={<ChevronsUp size={17} />} />
          <NavButton title="上一条" onClick={() => scrollToNote(navigation.previousId)} icon={<ChevronUp size={17} />} />
          <NavButton title="下一条" onClick={() => scrollToNote(navigation.nextId)} icon={<ChevronDown size={17} />} />
          <NavButton title="底部" onClick={() => scrollToNote(navigation.bottomId)} icon={<ChevronsDown size={17} />} />
        </div>
      )}

      {searchModalOpen && (
        <BookSearchModal
          searchDraft={searchDraft}
          searchItems={searchItems}
          addingSearchItemId={addingSearchItemId}
          onSearchDraftChange={setSearchDraft}
          onSearch={handleSearch}
          onAdd={(itemId) => void handleAddSearchItem(itemId)}
          onClose={() => {
            setSearchModalOpen(false)
            setSearchResults([])
            setSearchDraft('')
          }}
        />
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
      <Button
                variant="ghost"
        type="button"
        onClick={onToggle}
        className="mb-2 flex h-6 w-full items-center justify-between rounded-[6px] px-1 text-left text-[12px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
      >
        <span>{title}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </Button>
      {expanded && <div className="flex flex-col gap-1.5">
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
    <Button
                variant="ghost"
      type="button"
      onClick={onSelect}
      className={cn(
        'flex min-h-[64px] w-full items-center justify-start gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors',
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
    </Button>
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
  onSaveShareCard: (note: ReadingNoteSummary, cardElement?: HTMLElement | null) => void
}) {
  const localNoteRefs = useRef<Record<string, HTMLElement | null>>({})
  const loading = detail?.loading
  const bookmarks = detail?.bookmarks ?? []
  const reviews = detail?.reviews ?? []
  const bestBookmarks = detail?.bestBookmarks ?? []
  const publicReviews = detail?.publicReviews ?? []
  const openBook = async () => {
    if (!book.openUrl) return
    try {
      await openExternal(book.openUrl)
    } catch (error) {
      console.error('[ReadingView] 打开微信读书书籍失败:', error)
      toast.error('打开微信读书失败')
    }
  }
  return (
    <section>
      <div className="mx-auto max-w-[760px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold leading-8">《{book.title}》</h2>
            <div className="mt-1 text-[13px] text-[var(--text-3)]">
              {[book.author, `${book.noteCount} 条笔记`, '微信读书', readData?.readDays ? `${readData.readDays} 天阅读` : undefined].filter(Boolean).join(' · ')}
            </div>
          </div>
          {book.openUrl && (
            <Button variant="outline" type="button" onClick={() => void openBook()} className="shrink-0 gap-1.5">
              <BookOpen size={14} />
              打开阅读
            </Button>
          )}
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
                  <Button
                variant="ghost"
                    type="button"
                    onClick={onRunReading}
                    disabled={runningReading}
                    className="mt-4 rounded-[8px] bg-[var(--reading-accent)] px-4 py-2 text-[13px] font-medium text-[var(--reading-accent-foreground)] disabled:opacity-65"
                  >
                    {runningReading ? 'Lume 正在认真读...' : '让 Lume 帮我写一份'}
                  </Button>
                )}
              </div>
            ) : localNotes.map((note) => (
              <div key={note.id} className="space-y-2">
                <article
                  ref={(element) => { localNoteRefs.current[note.id] = element }}
                  className="rounded-[8px] bg-[var(--reading-card)] p-4"
                >
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
                  <ReadingNoteBody body={note.body} className="mt-3" />
                </article>
                <ReadingNoteActions
                  onChat={() => onChatWithNote(note)}
                  onSave={() => onSaveShareCard(note, localNoteRefs.current[note.id])}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function WereadTabButton({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <Button
                variant="ghost"
      type="button"
      onClick={onClick}
      className={cn(
        'h-10 rounded-[7px] text-[13px] font-medium transition-colors',
        active ? 'bg-[var(--reading-active)] text-[var(--text-1)]' : 'text-[var(--text-3)] hover:text-[var(--text-1)]',
      )}
    >
      {label}{typeof count === 'number' && count > 0 ? ` · ${count}` : ''}
    </Button>
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
    <Button
                variant="ghost"
      type="button"
      title={title}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
    >
      {icon}
    </Button>
  )
}

function ReadingNoteActions({ onChat, onSave }: { onChat: () => void; onSave: () => void }) {
  return (
    <div className="flex justify-end gap-3 px-1 text-[11px] text-[var(--text-3)]">
      <Button
                variant="ghost" type="button" onClick={onChat} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
        <MessageSquare size={14} />
        聊一聊
      </Button>
      <Button
                variant="ghost" type="button" onClick={onSave} className="flex items-center gap-1.5 hover:text-[var(--text-1)]">
        <ImageDown size={14} />
        存为图片
      </Button>
    </div>
  )
}

function ReadingNoteBody({ body, className }: { body: string; className?: string }) {
  return (
    <XMarkdown className={cn('reading-note-markdown x-markdown', className)}>
      {body}
    </XMarkdown>
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

function ensurePngPath(path: string): string {
  return path.toLowerCase().endsWith('.png') ? path : `${path}.png`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readSettledPayload(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'fulfilled' ? result.value : null
}

function BookSearchModal({
  searchDraft,
  searchItems,
  addingSearchItemId,
  onSearchDraftChange,
  onSearch,
  onAdd,
  onClose,
}: {
  searchDraft: string
  searchItems: Array<{ id: string; title: string; author?: string; summary?: string; coverUrl?: string; source: ReadingSourceKind; sourceLabel: string; alreadyAdded: boolean; addBookInput: ReadingAddBookInput; rating?: number; ratingCount?: number; readingCount?: number }>
  addingSearchItemId: string | null
  onSearchDraftChange: (value: string) => void
  onSearch: () => void
  onAdd: (itemId: string) => void
  onClose: () => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandingId, setExpandingId] = useState<string | null>(null)
  const [expandedReviews, setExpandedReviews] = useState<Record<string, WereadTextItem[]>>({})

  const handleToggleExpand = async (item: typeof searchItems[number]) => {
    if (expandedId === item.id) {
      setExpandedId(null)
      return
    }
    const bookId = item.addBookInput.source?.externalId
    if (!bookId || item.source !== 'weread') return
    setExpandedId(item.id)
    if (expandedReviews[item.id]) return
    setExpandingId(item.id)
    try {
      const payload = await getWereadPublicReviews(bookId, 'hot', item.title)
      const reviews = normalizeWereadReviews(payload).slice(0, 3)
      setExpandedReviews((prev) => ({ ...prev, [item.id]: reviews }))
    } catch (error) {
      console.error('[BookSearchModal] 加载书评失败:', error)
      setExpandedReviews((prev) => ({ ...prev, [item.id]: [] }))
    } finally {
      setExpandingId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color:color-mix(in_oklab,var(--text-1)_32%,transparent)]" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[520px] flex-col overflow-hidden rounded-[12px] border border-[var(--reading-border)] bg-[var(--reading-panel)] shadow-[0_24px_64px_-28px_hsl(var(--lume-shadow-panel)/0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--reading-border)] px-5 py-4">
          <h2 className="text-[16px] font-semibold text-[var(--text-1)]">搜索书籍</h2>
          <Button
                variant="ghost"
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <X size={16} />
          </Button>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-2 border-b border-[var(--reading-border)] px-5 py-3">
          <div className="flex flex-1 items-center gap-2 rounded-[8px] bg-[var(--reading-card)] px-3 py-2">
            <Search size={14} className="shrink-0 text-[var(--text-3)]" />
            <Input
              value={searchDraft}
              onChange={(e) => onSearchDraftChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSearch() }}
              placeholder="搜索书名或作者..."
              className="min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
              autoFocus
            />
          </div>
          <Button
                variant="ghost"
            type="button"
            onClick={onSearch}
            className="h-9 shrink-0 rounded-[8px] bg-[var(--reading-accent)] px-4 text-[13px] font-medium text-[var(--reading-accent-foreground)] transition-opacity hover:opacity-90"
          >
            搜索
          </Button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {searchItems.length === 0 ? (
            <div className="py-16 text-center text-[14px] text-[var(--text-3)]">输入书名或作者搜索</div>
          ) : (
            <div className="space-y-2">
              {searchItems.map((item) => {
                const canExpand = item.source === 'weread' && Boolean(item.addBookInput.source?.externalId)
                const isExpanded = expandedId === item.id
                const reviews = expandedReviews[item.id]
                const isLoading = expandingId === item.id
                return (
                  <div key={item.id} className="rounded-[8px] bg-[var(--reading-card)]">
                    <div className="group flex items-center gap-3 px-3 py-3">
                      {/* Cover */}
                      <BookThumb title={item.title} coverUrl={item.coverUrl} size="large" />

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold leading-5 text-[var(--text-1)]">{item.title}</div>
                        <div className="mt-0.5 text-[12px] text-[var(--text-3)]">{item.author ?? '未知作者'}</div>
                        {(typeof item.rating === 'number' || typeof item.readingCount === 'number') && (
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-3)]">
                            {typeof item.rating === 'number' && (
                              <>
                                <span className="text-[var(--lume-warning)]">{renderStars(item.rating)}</span>
                                <span className="font-medium text-[var(--text-2)]">{(item.rating / 10).toFixed(1)}</span>
                              </>
                            )}
                            {typeof item.ratingCount === 'number' && item.ratingCount > 0 && (
                              <span>({item.ratingCount}人)</span>
                            )}
                            {typeof item.readingCount === 'number' && item.readingCount > 0 && (
                              <span>· {item.readingCount}人在读</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex shrink-0 items-center gap-1.5 invisible group-hover:visible">
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => onAdd(item.id)}
                          disabled={item.alreadyAdded || addingSearchItemId === item.id}
                          className="flex h-6 items-center gap-1 rounded-[4px] border border-[var(--reading-border)] bg-[var(--reading-card)] px-2 text-[10px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] disabled:cursor-default disabled:opacity-50"
                        >
                          {item.alreadyAdded ? <Check size={10} /> : <Plus size={10} />}
                          {item.alreadyAdded ? '已添加' : '推荐'}
                        </Button>
                        {!item.alreadyAdded && (
                          <Button
                variant="ghost"
                            type="button"
                            onClick={() => onAdd(item.id)}
                            disabled={addingSearchItemId === item.id}
                            className="flex h-6 items-center gap-1 rounded-[4px] border border-[var(--reading-accent)] bg-[var(--reading-card)] px-2 text-[10px] font-medium text-[var(--reading-accent)] transition-colors hover:bg-[var(--reading-accent)] hover:text-[var(--reading-accent-foreground)] disabled:cursor-default disabled:opacity-50"
                          >
                            Lume 评价
                          </Button>
                        )}
                      </div>

                      {/* Expand toggle */}
                      {canExpand && (
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => void handleToggleExpand(item)}
                          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </Button>
                      )}
                    </div>

                    {/* Expanded reviews */}
                    {isExpanded && (
                      <div className="border-t border-[var(--reading-border)] px-3 py-2">
                        {isLoading ? (
                          <div className="py-3 text-center text-[12px] text-[var(--text-3)]">加载书评中...</div>
                        ) : reviews && reviews.length > 0 ? (
                          <div className="space-y-2">
                            {reviews.map((review) => (
                              <div key={review.id} className="rounded-[6px] bg-[var(--reading-panel)] px-3 py-2 [font-family:var(--reading-serif)] text-[12px] leading-[1.8] text-[var(--text-2)]">
                                <div>{review.text}</div>
                                <div className="mt-1 text-[10px] text-[var(--text-3)]">
                                  {[review.authorName, review.totalCount ? `${review.totalCount}人赞同` : undefined].filter(Boolean).join(' · ')}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="py-3 text-center text-[12px] text-[var(--text-3)]">暂无书评</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function renderStars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating / 20)))
  return '★'.repeat(full) + '☆'.repeat(5 - full)
}
