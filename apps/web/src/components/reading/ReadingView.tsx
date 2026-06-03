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
import type { ReadingLibrarySnapshot, ReadingNoteSummary, ReadingSearchResult } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom, tabsAtom, welcomePromptSeedAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  addReadingBook,
  generateReadingShareCard,
  getReadingSnapshot,
  manualGenerateReadingNote,
  searchReadingWeread,
} from '@/lib/desktop-api/reading'
import { cn } from '@/lib/utils'
import {
  buildReadingBookRail,
  buildReadingWereadConnectionPrompt,
  buildReadingNoteNavigation,
  buildReadingSearchItems,
  extendReadingHoverNavUntil,
  shouldShowReadingHoverNav,
} from './reading-view-state'

const readingThemeVars = {
  '--reading-accent': '#9a7444',
  '--reading-bg': 'color-mix(in oklab, var(--background) 96%, #f4ecdf)',
  '--reading-rail': 'color-mix(in oklab, var(--surface-1) 92%, #f4ecdf)',
  '--reading-panel': 'color-mix(in oklab, var(--surface-1) 88%, #f0e5d6)',
  '--reading-card': 'color-mix(in oklab, var(--surface-1) 96%, #fbf6ee)',
  '--reading-soft': 'color-mix(in oklab, var(--surface-2) 88%, #f4ecdf)',
  '--reading-active': 'color-mix(in oklab, #9a7444 16%, var(--surface-1))',
  '--reading-border': 'color-mix(in oklab, var(--border) 80%, #d9cdbb)',
} as CSSProperties

export function ReadingView() {
  const [snapshot, setSnapshot] = useState<ReadingLibrarySnapshot | null>(null)
  const [selectedId, setSelectedId] = useState('__all__')
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchResults, setSearchResults] = useState<ReadingSearchResult[]>([])
  const [addingSearchItemId, setAddingSearchItemId] = useState<string | null>(null)
  const [runningReading, setRunningReading] = useState(false)
  const [hoverNoteId, setHoverNoteId] = useState<string | null>(null)
  const [navVisibleUntil, setNavVisibleUntil] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const noteRefs = useRef<Record<string, HTMLElement | null>>({})
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await getReadingSnapshot())
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

  const rail = useMemo(() => snapshot ? buildReadingBookRail(snapshot) : null, [snapshot])
  const visibleNotes = useMemo(() => {
    if (!snapshot) return []
    if (selectedId === '__all__') return snapshot.notes
    if (selectedId === '__poetry__') return snapshot.notes.filter((note) => note.book?.title.includes('诗') || note.evidence.some((item) => item.sourceKind === 'poetry'))
    return snapshot.notes.filter((note) => note.bookId === selectedId)
  }, [selectedId, snapshot])
  const noteIds = visibleNotes.map((note) => note.id)
  const navigation = buildReadingNoteNavigation(noteIds, hoverNoteId)
  const showNav = hoverNoteId !== null && shouldShowReadingHoverNav(clock, navVisibleUntil)
  const searchItems = useMemo(() => (
    snapshot ? buildReadingSearchItems(searchResults, snapshot.books) : []
  ), [searchResults, snapshot])
  const wereadPrompt = useMemo(() => (
    snapshot ? buildReadingWereadConnectionPrompt(snapshot) : null
  ), [snapshot])
  const canRunReading = (snapshot?.books.length ?? 0) > 0
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
    if (runningReading) return
    setRunningReading(true)
    try {
      const result = await manualGenerateReadingNote({
        trigger: 'manual',
        bookId: selectedId.startsWith('__') ? undefined : selectedId,
        depth: 'seed',
        ...(currentWorkspaceSlug ? { workspaceSlug: currentWorkspaceSlug } : {}),
      })
      await load()
      toast.success(result.message)
    } catch (error) {
      console.error('[ReadingView] 读书任务失败:', error)
      toast.error('读书任务失败')
    } finally {
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

  const saveShareCard = async (note: ReadingNoteSummary) => {
    try {
      const result = await generateReadingShareCard({ noteId: note.id })
      await load()
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

  const stats = snapshot?.stats

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--reading-bg)] text-[var(--text-1)]"
      style={readingThemeVars}
    >
      <aside className="hidden w-[212px] shrink-0 border-r border-[var(--reading-border)] bg-[var(--reading-rail)] px-3 py-4 lg:block">
        <div className="space-y-2">
          {rail?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-[8px] px-2.5 py-2 text-left transition-colors',
                selectedId === item.id
                  ? 'bg-[var(--reading-active)] text-[var(--text-1)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
              )}
            >
              <BookThumb title={item.title} coverUrl={item.coverUrl} muted={item.kind !== 'book'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{item.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-[var(--text-3)]">
                  {item.progressLabel ?? item.subtitle}
                </span>
              </span>
            </button>
          ))}
        </div>

        {rail?.showWereadPrompt && wereadPrompt && (
          <div className="mt-5 rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] p-3">
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
      </aside>

      <ScrollArea className="min-h-0 w-full min-w-0 flex-1">
        <div className="flex min-h-full w-full justify-center">
          <main className="w-full max-w-[980px] px-5 py-7 lg:px-8">
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

          <section className="mt-5 rounded-[8px] bg-[var(--reading-panel)] p-4">
            <div className="mb-3 text-[14px] font-semibold text-[var(--reading-accent)]">Lume 在读</div>
            <div className="grid grid-cols-3 divide-x divide-[var(--reading-border)] border-t border-[var(--reading-border)] pt-4">
              <StatValue value={stats?.readingCount ?? 0} label="在读" />
              <StatValue value={stats?.noteCount ?? 0} label="读书笔记" />
              <StatValue value={stats?.finishedCount ?? 0} label="已读完" />
            </div>
          </section>

          {wereadPrompt && (
            <section className="mt-4 rounded-[8px] bg-[var(--reading-panel)] p-4">
              <div className="text-[15px] font-semibold text-[var(--text-1)]">把你的微信读书也连上来?</div>
              <p className="mt-1 text-[13px] leading-6 text-[var(--text-3)]">
                连接后，Lume 能看到你的书架、划线和想法，聊到相关话题时会自动关联你读过的内容，也能帮你整理别人精彩的书评。
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={openReadingSettings}
                  className="h-9 rounded-[6px] bg-[var(--text-1)] text-[13px] font-medium text-[var(--surface-1)]"
                >
                  去设置
                </button>
                <button
                  type="button"
                  onClick={openReadingSettings}
                  className="h-9 rounded-[6px] bg-[var(--reading-card)] text-[13px] font-medium text-[var(--text-1)]"
                >
                  填入 API Key
                </button>
              </div>
            </section>
          )}

          <div className="my-6 flex items-center gap-4 text-[12px] text-[var(--text-3)]">
            <div className="h-px flex-1 bg-[var(--reading-border)]" />
            <span>读书笔记</span>
            <div className="h-px flex-1 bg-[var(--reading-border)]" />
          </div>

          <div className="space-y-7">
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
                className="rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] p-6 shadow-[0_10px_28px_-24px_rgba(18,22,32,0.32)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-[18px] font-semibold leading-7">{note.book ? `《${note.book.title}》` : note.title}</h2>
                    <div className="mt-1 text-[13px] text-[var(--text-3)]">
                      {[note.book?.author, typeof note.progressPercent === 'number' ? `${Math.round(note.progressPercent)}%` : undefined].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="text-[12px] text-[var(--text-3)]">{formatNoteDate(note.createdAt)}</div>
                </div>

                {note.excerpt && (
                  <blockquote className="mt-5 rounded-[8px] bg-[var(--reading-soft)] px-4 py-3 text-[14px] italic leading-7 text-[var(--text-2)]">
                    “{note.excerpt}”
                  </blockquote>
                )}

                <div className="mt-5 whitespace-pre-wrap text-[15px] leading-8 text-[var(--text-1)]">{note.body}</div>

                {note.tags.length > 0 && (
                  <div className="mt-5 flex flex-wrap gap-2">
                    {note.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-[12px] text-[var(--text-3)]">{tag}</span>
                    ))}
                  </div>
                )}

                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[12px] text-[var(--text-3)]">
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
                  <div className="mt-2 text-right text-[12px] italic text-[var(--text-3)]">以上内容均由 AI 生成，纯属虚构，请注意甄别</div>
                )}
              </article>
            ))}
          </div>
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

function BookThumb({ title, coverUrl, muted }: { title: string; coverUrl?: string; muted?: boolean }) {
  return (
    <span className={cn(
      'flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--surface-2)] text-[13px] font-semibold',
      muted && 'h-9 w-9 rounded-[8px] text-[var(--text-3)]',
    )}>
      {coverUrl ? <img src={coverUrl} alt="" className="h-full w-full object-cover" /> : muted ? <BookOpen size={15} /> : title.slice(0, 1)}
    </span>
  )
}

function StatValue({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="text-[26px] font-semibold leading-none text-[var(--reading-accent)]">{value}</div>
      <div className="mt-2 text-[12px] text-[var(--text-3)]">{label}</div>
    </div>
  )
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
