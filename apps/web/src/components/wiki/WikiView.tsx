import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { Archive, ChevronRight, FileText, Folder, FolderOpen, Import, Inbox, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeftOpen, PanelRightOpen, RefreshCw, Save, Search, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import type { WikiPageRecord, WikiPageType, WikiPrivacyImpactPreview, WikiProposalSummaryV1, WikiReadResult, WikiSnapshot, WikiSourceRef } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, tabsAtom } from '@/atoms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { openExternal, openFileDialog, openFolderDialog, revealPathInSystem } from '@/lib/desktop-api'
import { applyWikiDraft, cancelWikiDraft, createAskWikiThread, createWikiEditDraft, createWikiImportDraft, createWikiPrivacyPurgeDraft, getWikiCapabilities, getWikiSnapshot, prepareWikiRuntime, previewWikiPrivacyPurge, readWikiPage, resolveWikiPending, runWikiLint, searchWiki, undoWikiBatch } from '@/lib/desktop-api/wiki'
import { cn } from '@/lib/utils'
import { countWikiPages, defaultAskWikiScope, filterWikiPages, type WikiFolderFilter } from './wiki-view-state'

const INBOX_DESTINATION = '__inbox__'

export function WikiView() {
  const [snapshot, setSnapshot] = useState<WikiSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WikiReadResult | null>(null)
  const [query, setQuery] = useState('')
  const [resultIds, setResultIds] = useState<string[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchRequestRef = useRef(0)
  const [folder, setFolder] = useState<WikiFolderFilter>({ kind: 'all' })
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pageType, setPageType] = useState<WikiPageType>('topic')
  const [primaryWorkspaceId, setPrimaryWorkspaceId] = useState(INBOX_DESTINATION)
  const [associatedWorkspaceIds, setAssociatedWorkspaceIds] = useState<string[]>([])
  const [aliases, setAliases] = useState('')
  const [tags, setTags] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [leftPanelsOpen, setLeftPanelsOpen] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [importMode, setImportMode] = useState<'text' | 'url'>('text')
  const [importTitle, setImportTitle] = useState('')
  const [importValue, setImportValue] = useState('')
  const [importWorkspaceId, setImportWorkspaceId] = useState(INBOX_DESTINATION)
  const [importPageType, setImportPageType] = useState<WikiPageType>('source')
  const [draft, setDraft] = useState<WikiProposalSummaryV1 | null>(null)
  const [busy, setBusy] = useState(false)
  const [runtimePreparing, setRuntimePreparing] = useState(true)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const load = useCallback(async () => {
    try {
      const next = await getWikiSnapshot()
      setSnapshot(next)
      setSelectedId((current) => current && next.pages.some((page) => page.id === current) ? current : next.pages.find((page) => page.status === 'active')?.id ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load().catch((error) => toast.error(error instanceof Error ? error.message : 'Wiki 加载失败')) }, [load])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const applyCapabilities = (capabilities: WikiSnapshot['capabilities']) => {
      if (!active) return
      setSnapshot((current) => current ? { ...current, capabilities } : current)
      const preparing = capabilities.runtimeStatus === 'preparing'
      setRuntimePreparing(preparing)
      if (preparing) timer = setTimeout(() => void getWikiCapabilities().then(applyCapabilities).catch(() => setRuntimePreparing(false)), 2_000)
    }
    void prepareWikiRuntime().then(applyCapabilities).catch(() => setRuntimePreparing(false))
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (!selectedId) { setSelected(null); return }
    void readWikiPage(selectedId, { kind: 'all' }).then((next) => {
      setSelected(next); setTitle(next.page.title); setBody(next.page.body)
      setPageType(next.page.frontmatter.type)
      setPrimaryWorkspaceId(next.page.frontmatter.primary_workspace_id ?? INBOX_DESTINATION)
      setAssociatedWorkspaceIds(next.page.frontmatter.associated_workspace_ids)
      setAliases(next.page.frontmatter.aliases.join(', '))
      setTags(next.page.frontmatter.tags.join(', '))
    }).catch((error) => toast.error(error instanceof Error ? error.message : '页面读取失败'))
  }, [selectedId, snapshot?.generation])

  const visiblePages = useMemo(() => {
    if (!snapshot) return []
    return filterWikiPages(snapshot.pages, resultIds, folder)
  }, [folder, resultIds, snapshot])
  const isDirty = Boolean(editing && selected && (
    title !== selected.page.title || body !== selected.page.body || pageType !== selected.page.frontmatter.type
    || (primaryWorkspaceId === INBOX_DESTINATION ? null : primaryWorkspaceId) !== selected.page.frontmatter.primary_workspace_id
    || associatedWorkspaceIds.join('\0') !== selected.page.frontmatter.associated_workspace_ids.join('\0')
    || parseList(aliases).join('\0') !== selected.page.frontmatter.aliases.join('\0')
    || parseList(tags).join('\0') !== selected.page.frontmatter.tags.join('\0')
  ))

  useEffect(() => {
    if (isDirty || (selectedId && visiblePages.some((page) => page.id === selectedId))) return
    setSelectedId(visiblePages[0]?.id ?? null)
  }, [isDirty, selectedId, visiblePages])

  const act = async (run: () => Promise<void>) => {
    setBusy(true)
    try { await run() } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const discardEdits = () => {
    if (isDirty && !window.confirm('当前页面还有未保存修改，继续后会丢失。')) return false
    setEditing(false)
    if (selected) {
      setTitle(selected.page.title); setBody(selected.page.body); setPageType(selected.page.frontmatter.type)
      setPrimaryWorkspaceId(selected.page.frontmatter.primary_workspace_id ?? INBOX_DESTINATION)
      setAssociatedWorkspaceIds(selected.page.frontmatter.associated_workspace_ids)
      setAliases(selected.page.frontmatter.aliases.join(', ')); setTags(selected.page.frontmatter.tags.join(', '))
    }
    return true
  }
  const selectFolder = (next: WikiFolderFilter) => {
    if (!discardEdits()) return
    setFolder(next)
  }
  const selectPage = (pageId: string) => {
    if (pageId === selectedId || !discardEdits()) return
    setSelectedId(pageId)
  }
  const search = () => {
    const requestId = ++searchRequestRef.current
    void act(async () => {
      const normalizedQuery = query.trim()
      if (!normalizedQuery) { setResultIds(null); return }
      setSearching(true)
      try {
        const results = await searchWiki({ query: normalizedQuery, scope: { kind: 'all' }, maxResults: 50 })
        if (requestId === searchRequestRef.current) setResultIds([...new Set(results.map((item) => item.page.id))])
      } finally {
        setSearching(false)
      }
    })
  }
  const save = () => selected && void act(async () => {
    if (!title.trim()) throw new Error('标题不能为空')
    const page = selected.page
    const nextDraft = await createWikiEditDraft({
      pageId: page.id, expectedHash: page.hash, title, type: pageType,
      primaryWorkspaceId: primaryWorkspaceId === INBOX_DESTINATION ? null : primaryWorkspaceId,
      associatedWorkspaceIds, aliases: parseList(aliases), tags: parseList(tags), body,
    })
    const result = await applyWikiDraft(nextDraft.draftId)
    toast.success('draft' in result ? '变更已进入待审核' : 'Wiki 页面已保存')
    setEditing(false); await load()
  })
  const prepareImport = () => void act(async () => {
    if (!importValue.trim()) throw new Error(importMode === 'url' ? '请输入 URL' : '请输入要沉淀的内容')
    const next = await createWikiImportDraft({ source: importMode === 'url' ? { kind: 'url', url: importValue.trim(), title: importTitle || undefined } : { kind: 'text', text: importValue, title: importTitle || undefined }, title: importTitle || undefined, pageType: importPageType, primaryWorkspaceId: importWorkspaceId === INBOX_DESTINATION ? null : importWorkspaceId })
    setDraft(next)
  })
  const preparePickedImport = (kind: 'file' | 'folder') => void act(async () => {
    const path = kind === 'file' ? (await openFileDialog()).files[0]?.sourcePath : (await openFolderDialog()).path
    if (!path) return
    const next = await createWikiImportDraft({ source: kind === 'file' ? { kind: 'file', path } : { kind: 'folder', path }, pageType: importPageType, primaryWorkspaceId: importWorkspaceId === INBOX_DESTINATION ? null : importWorkspaceId })
    setDraft(next)
  })
  const confirmImport = () => draft && void act(async () => {
    const result = await applyWikiDraft(draft.draftId)
    toast.success('draft' in result ? '导入已进入待审核' : '已沉淀到 Wiki')
    setDraft(null); setImportOpen(false); setImportTitle(''); setImportValue(''); await load()
  })
  const openImport = () => {
    if (!discardEdits()) return
    setImportWorkspaceId(currentWorkspaceId ?? INBOX_DESTINATION)
    setImportOpen(true)
  }
  const resetImportDraft = () => draft && void act(async () => {
    await cancelWikiDraft(draft.draftId)
    setDraft(null)
  })
  const setImportDialogOpen = (open: boolean) => {
    setImportOpen(open)
    if (!open) {
      if (draft) void cancelWikiDraft(draft.draftId).catch(() => undefined)
      setDraft(null)
      setImportTitle('')
      setImportValue('')
    }
  }
  const ask = () => void act(async () => {
    const scope = defaultAskWikiScope(selectedId, currentWorkspaceId)
    const { threadId } = await createAskWikiThread(scope)
    setTabs((items) => items.some((tab) => tab.id === threadId) ? items : [...items, { id: threadId, type: 'agent', title: '向 Wiki 提问', threadId }])
    setActiveTabId(threadId)
  })
  const openObsidian = () => snapshot && void openExternal(`obsidian://open?path=${encodeURIComponent(snapshot.rootPath)}`).catch(() => toast.error('未能打开 Obsidian，请确认已安装并注册 URI'))
  const openWikiFolder = () => snapshot && void revealPathInSystem(snapshot.rootPath).catch(() => toast.error('打开 Wiki 目录失败'))
  const checkWiki = () => void act(async () => { await runWikiLint(); await load() })
  const isDark = useIsDark()
  const editActions = selected && (editing ? <><Button size="sm" variant="outline" onClick={discardEdits}>取消</Button><Button size="sm" onClick={save} disabled={busy || !isDirty}><Save size={14} />保存</Button></> : <Button size="sm" onClick={() => setEditing(true)}>编辑 Markdown</Button>)

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 text-[var(--text-1)]">
      {leftPanelsOpen && <>
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)]">
        <div className="flex items-center justify-between px-3 py-3"><span className="text-sm font-semibold">知识归宿</span><div className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" onClick={openImport} title="导入知识"><Import size={15} /></Button><Button variant="ghost" size="icon-sm" onClick={() => setLeftPanelsOpen(false)} title="收起左侧面板" aria-label="收起左侧面板"><ChevronRight size={15} /></Button></div></div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <ScopeButton icon={<Folder size={14} />} label="全部知识" count={snapshot ? countWikiPages(snapshot.pages, { kind: 'all' }) : 0} active={folder.kind === 'all'} onClick={() => selectFolder({ kind: 'all' })} />
          <ScopeButton icon={<Inbox size={14} />} label="收件箱" count={snapshot ? countWikiPages(snapshot.pages, { kind: 'inbox' }) : 0} active={folder.kind === 'inbox'} onClick={() => selectFolder({ kind: 'inbox' })} />
          <div className="mt-4 px-2 text-[11px] uppercase tracking-wide text-[var(--text-3)]">工作区归宿</div>
          {workspaces.map((workspace) => <ScopeButton key={workspace.id} icon={<FolderOpen size={14} />} label={workspace.name} count={snapshot ? countWikiPages(snapshot.pages, { kind: 'workspace', workspaceId: workspace.id }) : 0} active={folder.kind === 'workspace' && folder.workspaceId === workspace.id} onClick={() => selectFolder({ kind: 'workspace', workspaceId: workspace.id })} />)}
          {!workspaces.length && <div className="px-2 py-2 text-xs text-[var(--text-3)]">暂无工作区</div>}
          <ScopeButton icon={<Archive size={14} />} label="已归档" count={snapshot ? countWikiPages(snapshot.pages, { kind: 'archived' }) : 0} active={folder.kind === 'archived'} onClick={() => selectFolder({ kind: 'archived' })} />
          <div className="mt-5 px-2 text-[11px] uppercase tracking-wide text-[var(--text-3)]">待审核</div>
          {snapshot?.pending.length ? snapshot.pending.map((item) => (
            <div key={item.id} className="mt-2 rounded-lg border border-[var(--border)] p-2 text-xs">
              <div className="font-medium">{item.draft.title}</div><div className="mt-1 text-[var(--text-3)]">{item.reason}</div>
              <div className="mt-2 flex gap-1">{item.requiresRegeneration ? <Badge variant="destructive">需重新编辑</Badge> : <Button size="xs" disabled={busy || isDirty} onClick={() => void act(async () => { await resolveWikiPending(item, 'accept'); await load() })}>接受</Button>}<Button size="xs" variant="outline" disabled={busy || isDirty} onClick={() => void act(async () => { await resolveWikiPending(item, 'reject'); await load() })}>拒绝</Button></div>
            </div>
          )) : <div className="px-2 py-2 text-xs text-[var(--text-3)]">暂无待审核项</div>}
        </ScrollArea>
      </aside>

      <section className="flex w-[260px] shrink-0 flex-col border-r border-[var(--border)]">
        <form className="flex gap-2 p-3" onSubmit={(event) => { event.preventDefault(); search() }}><div className="relative min-w-0 flex-1"><Input value={query} onChange={(event) => { searchRequestRef.current += 1; setQuery(event.target.value); setResultIds(null) }} placeholder="搜索知识" className="pr-8" aria-label="搜索知识" />{query && <Button type="button" variant="ghost" size="icon-xs" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => { searchRequestRef.current += 1; setQuery(''); setResultIds(null) }} title="清除搜索" aria-label="清除搜索"><X size={13} /></Button>}</div><Button type="submit" variant="outline" size="icon" disabled={busy || !query.trim()} title="搜索" aria-label="搜索">{searching ? <LoaderCircle className="animate-spin" size={15} /> : <Search size={15} />}</Button></form>
        {(searching || resultIds !== null) && <div className="px-3 pb-1 text-[11px] text-[var(--text-3)]">{searching ? '搜索中…' : `找到 ${visiblePages.length} 条知识`}</div>}
        <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
          {visiblePages.map((page) => <Button key={page.id} variant="ghost" onClick={() => selectPage(page.id)} className={cn('mb-1 h-auto w-full justify-start gap-2 px-2 py-2 text-left', selectedId === page.id && 'bg-[var(--surface-2)]')}><FileText size={14} /><span className="min-w-0"><span className="block truncate text-sm">{page.title}</span><span className="block text-[11px] text-[var(--text-3)]">{pageTypeLabel(page.type)}</span></span></Button>)}
          {loading ? <div className="flex items-center justify-center gap-2 p-6 text-sm text-[var(--text-3)]"><LoaderCircle className="animate-spin" size={15} />正在打开 Wiki…</div> : !visiblePages.length && <div className="space-y-3 p-5 text-center"><div className="text-sm text-[var(--text-3)]">{resultIds ? '没有匹配的知识' : '这个归宿还没有内容'}</div>{!resultIds && <Button size="sm" variant="outline" onClick={openImport}><Import size={14} />导入第一份内容</Button>}</div>}
        </ScrollArea>
      </section>
      </>}

      {!leftPanelsOpen && (
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute left-2 top-1/2 z-30 -translate-y-1/2 bg-[var(--surface-1)] shadow-sm"
          onClick={() => setLeftPanelsOpen(true)}
          title="展开左侧面板"
          aria-label="展开左侧面板"
        >
          <PanelLeftOpen size={15} />
        </Button>
      )}

      <main className="wiki-main flex min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><div className="truncate font-semibold">{selected?.page.title ?? 'Wiki'}</div>{snapshot && <Badge className="hidden sm:inline-flex" variant={snapshot.capabilities.phase === 'B' ? 'secondary' : 'outline'} title={snapshot.capabilities.reason}>{snapshot.capabilities.phase === 'B' ? '智能维护已开启' : runtimePreparing || snapshot.capabilities.runtimeStatus === 'preparing' ? <><LoaderCircle className="animate-spin" size={11} />正在准备智能维护</> : '基础安全模式'}</Badge>} {snapshot && <Badge className="hidden sm:inline-flex" variant="outline">{snapshot.searchMode === 'hybrid' ? '混合检索' : '全文检索'}</Badge>}</div>{snapshot && <div className="mt-0.5 max-w-[560px] truncate text-[11px] text-[var(--text-3)]">{snapshot.pages.filter((page) => page.status === 'active').length} 条知识 · {snapshot.semanticCheck.message}</div>}</div>
          <div className="wiki-main-actions flex shrink-0 items-center gap-2">{snapshot && <><Button variant="outline" size="sm" onClick={openObsidian}>在 Obsidian 打开</Button><Button variant="outline" size="sm" onClick={openWikiFolder}><FolderOpen size={14} />打开目录</Button></>}<Button variant="outline" size="sm" onClick={checkWiki} disabled={busy || isDirty} title={isDirty ? '请先保存或取消当前修改' : undefined}><RefreshCw className={cn(busy && 'animate-spin')} size={14} />检查</Button><Button variant="outline" size="sm" onClick={ask} disabled={busy}><MessageSquare size={14} />向 Wiki 提问</Button>{editActions}</div>
          <div className="wiki-main-actions-compact flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="更多操作" title="更多操作" />}><MoreHorizontal size={15} /></DropdownMenuTrigger>
              <DropdownMenuContent>
                {snapshot && <><DropdownMenuItem onSelect={openObsidian}>在 Obsidian 打开</DropdownMenuItem><DropdownMenuItem onSelect={openWikiFolder}><FolderOpen size={14} />打开目录</DropdownMenuItem></>}
                <DropdownMenuItem onSelect={checkWiki} disabled={busy || isDirty}><RefreshCw size={14} />检查</DropdownMenuItem>
                <DropdownMenuItem onSelect={ask} disabled={busy}><MessageSquare size={14} />向 Wiki 提问</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {editActions}
          </div>
        </header>
        {selected ? <div className="relative flex min-h-0 flex-1">
          <ScrollArea className="min-h-0 min-w-0 flex-1"><article className="mx-auto max-w-[820px] px-7 py-6">{editing ? <div className="space-y-3">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="页面标题" />
            <div className="grid grid-cols-2 gap-3"><Select value={pageType} onValueChange={(value) => value && setPageType(value as WikiPageType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['source', 'topic', 'decision', 'synthesis'] as const).map((type) => <SelectItem key={type} value={type}>{pageTypeLabel(type)}</SelectItem>)}</SelectContent></Select><Select value={primaryWorkspaceId} onValueChange={(value) => value && setPrimaryWorkspaceId(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={INBOX_DESTINATION}>收件箱</SelectItem>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select></div>
            <Input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="别名，用逗号分隔" />
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" />
            <div className="rounded-md border border-[var(--border)] p-3"><div className="mb-2 text-xs text-[var(--text-3)]">关联工作区</div><div className="flex flex-wrap gap-2">{workspaces.filter((workspace) => workspace.id !== primaryWorkspaceId).map((workspace) => <Button key={workspace.id} type="button" size="xs" variant={associatedWorkspaceIds.includes(workspace.id) ? 'secondary' : 'outline'} onClick={() => setAssociatedWorkspaceIds((items) => items.includes(workspace.id) ? items.filter((id) => id !== workspace.id) : [...items, workspace.id])}>{workspace.name}</Button>)}</div></div>
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-[560px] font-mono text-sm" />
          </div> : <XMarkdown className="wiki-page-markdown x-markdown text-[15px] leading-7 text-[var(--text-1)]" rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}>{selected.page.body}</XMarkdown>}</article></ScrollArea>
          {inspectorOpen ? <aside className="w-[280px] shrink-0 border-l border-[var(--border)] p-4"><Button variant="ghost" size="sm" className="mb-3 w-full justify-between" onClick={() => setInspectorOpen(false)}>详情 <ChevronRight size={14} /></Button><Inspector page={selected.page} read={selected} snapshot={snapshot} disableMutations={busy || isDirty} onUndo={(batchId) => void act(async () => { await undoWikiBatch(batchId); await load() })} onReload={load} /></aside> : <Button variant="outline" size="icon-sm" className="absolute right-2 top-2 z-20 bg-[var(--surface-1)] shadow-sm" onClick={() => setInspectorOpen(true)} title="展开详情" aria-label="展开详情"><PanelRightOpen size={15} /></Button>}
        </div> : <div className="flex flex-1 items-center justify-center">{loading ? <div className="flex items-center gap-2 text-sm text-[var(--text-3)]"><LoaderCircle className="animate-spin" size={16} />正在加载知识库…</div> : <div className="space-y-3 text-center"><div className="text-sm text-[var(--text-3)]">导入一份内容，开始建立你的 Wiki</div><Button size="sm" onClick={openImport}><Import size={14} />导入内容</Button></div>}</div>}
      </main>

      <Dialog open={importOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>{draft ? '确认沉淀内容' : '导入到 Wiki'}</DialogTitle></DialogHeader>
          {draft ? <div className="space-y-3">
            <div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm font-medium">{draft.title}</div>
            {draft.boundedDiffPreviews.map((diff) => <div key={`${diff.pageId}:${diff.path}`} className="rounded-md border border-[var(--border)] p-2 text-xs"><div className="font-medium">{diff.preview}</div><div className="mt-1 truncate text-[var(--text-3)]">{diff.path}</div></div>)}
            <div className="text-xs text-[var(--text-3)]">来源与页面会作为同一批次写入，之后可从操作记录撤销。</div>
          </div> : <div className="space-y-3">
            <div className="flex flex-wrap gap-2"><Button size="sm" variant={importMode === 'text' ? 'default' : 'outline'} onClick={() => setImportMode('text')} disabled={busy}>粘贴文本</Button><Button size="sm" variant={importMode === 'url' ? 'default' : 'outline'} onClick={() => setImportMode('url')} disabled={busy}>URL</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('file')} disabled={busy}><FileText size={14} />文件</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('folder')} disabled={busy}><FolderOpen size={14} />文件夹</Button></div>
            <Input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} placeholder="标题（可选）" disabled={busy} />
            <Select value={importPageType} onValueChange={(value) => value && setImportPageType(value as WikiPageType)} disabled={busy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['source', 'topic', 'decision', 'synthesis'] as const).map((type) => <SelectItem key={type} value={type}>{pageTypeLabel(type)}</SelectItem>)}</SelectContent></Select>
            {importMode === 'text' ? <Textarea value={importValue} onChange={(event) => setImportValue(event.target.value)} className="min-h-56" placeholder="粘贴需要长期维护的内容" disabled={busy} /> : <Input value={importValue} onChange={(event) => setImportValue(event.target.value)} placeholder="https://…" disabled={busy} />}
            <div className="flex items-center justify-between gap-3"><span className="text-xs text-[var(--text-3)]">保存到</span><Select value={importWorkspaceId} onValueChange={(value) => value && setImportWorkspaceId(value)} disabled={busy}><SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={INBOX_DESTINATION}>收件箱</SelectItem>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select></div>
          </div>}
          <DialogFooter>{draft && <Button variant="ghost" onClick={resetImportDraft} disabled={busy}>返回修改</Button>}<Button variant="outline" onClick={() => setImportDialogOpen(false)} disabled={busy}>取消</Button><Button onClick={draft ? confirmImport : prepareImport} disabled={busy}>{busy ? '处理中…' : draft ? '确认写入' : '生成确认单'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ScopeButton({ icon, label, count, active, onClick }: { icon: ReactNode; label: string; count: number; active: boolean; onClick: () => void }) {
  return <Button variant="ghost" onClick={onClick} className={cn('mt-1 h-8 w-full justify-start gap-2 px-2 text-xs font-normal', active && 'bg-[var(--surface-2)] font-medium')}><span className="text-[var(--text-3)]">{icon}</span><span className="min-w-0 flex-1 truncate text-left">{label}</span><span className="tabular-nums text-[var(--text-3)]">{count}</span></Button>
}
function pageTypeLabel(type: WikiPageRecord['type']): string {
  return { source: '来源', topic: '主题', decision: '决策', synthesis: '综合' }[type]
}
function parseList(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
}
function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
  )
}
function Inspector({ page, read, snapshot, disableMutations, onUndo, onReload }: { page: WikiPageRecord; read: WikiReadResult; snapshot: WikiSnapshot | null; disableMutations: boolean; onUndo: (batchId: string) => void; onReload: () => Promise<void> }) {
  const findings = snapshot?.findings.filter((item) => item.pageId === page.id) ?? []
  const batches = snapshot?.recentBatches.filter((item) => item.affectedPageIds.includes(page.id) && !item.irreversible).slice(0, 8) ?? []
  return <ScrollArea className="h-[calc(100%-40px)]"><div className="space-y-5 text-xs"><section><div className="mb-2 font-semibold">元数据</div><div className="flex flex-wrap gap-1"><Badge variant="secondary">{pageTypeLabel(page.frontmatter.type)}</Badge><Badge variant="outline">版本 {page.revision}</Badge>{page.protected && <Badge variant="destructive">受保护</Badge>}</div></section><section><div className="mb-2 font-semibold">来源</div>{read.sources.length ? read.sources.map((source) => <div key={source.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{source.title}</div><div className="text-[var(--text-3)]">{source.kind} · {source.captureMode}</div>{source.restricted && <div className="mt-1 flex gap-1 text-amber-600"><ShieldAlert size={13} />来源受限</div>}<PrivacyPurgeButton source={source} disabled={disableMutations} onReload={onReload} /></div>) : <div className="text-[var(--text-3)]">没有来源</div>}</section><section><div className="mb-2 font-semibold">链接</div><div className="text-[var(--text-3)]">{read.links.length} 出链 · {read.backlinks.length} 反向链接</div></section><section><div className="mb-2 font-semibold">版本与操作</div>{batches.length ? batches.map((batch) => <div key={batch.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{batch.origin} · {batch.state}</div><div className="text-[var(--text-3)]">{new Date(batch.createdAt).toLocaleString()}</div>{batch.diffs.filter((diff) => diff.pageId === page.id).map((diff) => <div key={`${batch.id}:${diff.path}`} className="mt-1 rounded bg-[var(--surface-2)] px-2 py-1 text-[var(--text-3)]">{diff.preview}</div>)}{batch.state === 'committed' && <Button size="xs" variant="outline" className="mt-2" disabled={disableMutations} onClick={() => onUndo(batch.id)}>撤销</Button>}</div>) : <div className="text-[var(--text-3)]">暂无操作记录</div>}</section><section><div className="mb-2 font-semibold">检查结果</div>{findings.length ? findings.map((item) => <div key={item.id} className="mb-2">{item.message}</div>) : <div className="text-[var(--text-3)]">没有结构问题</div>}</section></div></ScrollArea>
}

function PrivacyPurgeButton({ source, disabled, onReload }: { source: WikiSourceRef; disabled: boolean; onReload: () => Promise<void> }) {
  const [preview, setPreview] = useState<WikiPrivacyImpactPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try { setPreview(await previewWikiPrivacyPurge({ kind: 'source', sourceId: source.id })) }
    catch (error) { toast.error(error instanceof Error ? error.message : '无法分析清除影响') }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const draft = await createWikiPrivacyPurgeDraft({ selector: preview.selector })
      await applyWikiDraft(draft.draftId)
      toast.success('永久清除草案已进入待审核，请在待审核区再次确认')
      setPreview(null)
      await onReload()
    } catch (error) { toast.error(error instanceof Error ? error.message : '无法创建清除草案') }
    finally { setBusy(false) }
  }
  return <><Button size="xs" variant="ghost" className="mt-2 text-red-600" disabled={disabled || busy} onClick={() => void open()}>彻底清除…</Button><Dialog open={Boolean(preview)} onOpenChange={(value) => !value && setPreview(null)}><DialogContent><DialogHeader><DialogTitle>确认隐私清除影响</DialogTitle></DialogHeader>{preview && <div className="space-y-2 text-sm"><div>将清除 {preview.sourceIds.length} 个来源，并影响 {preview.pageIds.length} 个页面。</div><div>相关 staging {preview.stagingDraftIds.length} 项，历史快照 {preview.snapshotBatchIds.length} 批。</div>{preview.sharedPayloads.some((item) => item.retainedSourceIds.length > 0) && <div className="rounded-md bg-amber-50 p-2 text-amber-800">共享 payload 仍有其他 provenance 使用，只会删除当前来源，不会误删共享正文。</div>}<div className="text-xs text-[var(--text-3)]">确认后先生成高风险草案；还需在待审核区二次确认才会永久删除。</div></div>}<DialogFooter><Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>取消</Button><Button variant="destructive" onClick={() => void confirm()} disabled={busy}>生成永久清除草案</Button></DialogFooter></DialogContent></Dialog></>
}
