import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { Archive, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Import, Inbox, LoaderCircle, MessageSquare, RefreshCw, Save, Search, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import type { WikiChangeDraft, WikiPageRecord, WikiReadResult, WikiSnapshot } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, tabsAtom } from '@/atoms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { openFileDialog, openFolderDialog, revealPathInSystem } from '@/lib/desktop-api'
import { applyWikiDraft, cancelWikiDraft, createAskWikiThread, createWikiEditDraft, createWikiImportDraft, getWikiCapabilities, getWikiSnapshot, prepareWikiRuntime, readWikiPage, resolveWikiPending, runWikiLint, searchWiki, undoWikiBatch } from '@/lib/desktop-api/wiki'
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
  const [folder, setFolder] = useState<WikiFolderFilter>({ kind: 'all' })
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [importMode, setImportMode] = useState<'text' | 'url'>('text')
  const [importTitle, setImportTitle] = useState('')
  const [importValue, setImportValue] = useState('')
  const [importWorkspaceId, setImportWorkspaceId] = useState(INBOX_DESTINATION)
  const [draft, setDraft] = useState<WikiChangeDraft | null>(null)
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
    }).catch((error) => toast.error(error instanceof Error ? error.message : '页面读取失败'))
  }, [selectedId, snapshot?.generation])

  const visiblePages = useMemo(() => {
    if (!snapshot) return []
    return filterWikiPages(snapshot.pages, resultIds, folder)
  }, [folder, resultIds, snapshot])
  const isDirty = Boolean(editing && selected && (title !== selected.page.title || body !== selected.page.body))

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
    if (selected) { setTitle(selected.page.title); setBody(selected.page.body) }
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
  const search = () => void act(async () => {
    if (!query.trim()) { setResultIds(null); return }
    const results = await searchWiki({ query, scope: { kind: 'all' }, maxResults: 50 })
    setResultIds(results.map((item) => item.page.id))
  })
  const save = () => selected && void act(async () => {
    if (!title.trim()) throw new Error('标题不能为空')
    const page = selected.page
    const nextDraft = await createWikiEditDraft({ pageId: page.id, expectedHash: page.hash, title, type: page.frontmatter.type, primaryWorkspaceId: page.frontmatter.primary_workspace_id, associatedWorkspaceIds: page.frontmatter.associated_workspace_ids, aliases: page.frontmatter.aliases, tags: page.frontmatter.tags, body })
    const result = await applyWikiDraft({ draftId: nextDraft.id, expectedRevision: nextDraft.revision, nonce: nextDraft.nonce })
    toast.success('draft' in result ? '变更已进入待审核' : 'Wiki 页面已保存')
    setEditing(false); await load()
  })
  const prepareImport = () => void act(async () => {
    if (!importValue.trim()) throw new Error(importMode === 'url' ? '请输入 URL' : '请输入要沉淀的内容')
    const next = await createWikiImportDraft({ source: importMode === 'url' ? { kind: 'url', url: importValue.trim(), title: importTitle || undefined } : { kind: 'text', text: importValue, title: importTitle || undefined }, title: importTitle || undefined, primaryWorkspaceId: importWorkspaceId === INBOX_DESTINATION ? null : importWorkspaceId })
    setDraft(next)
  })
  const preparePickedImport = (kind: 'file' | 'folder') => void act(async () => {
    const path = kind === 'file' ? (await openFileDialog()).files[0]?.sourcePath : (await openFolderDialog()).path
    if (!path) return
    const next = await createWikiImportDraft({ source: kind === 'file' ? { kind: 'file', path } : { kind: 'folder', path }, primaryWorkspaceId: importWorkspaceId === INBOX_DESTINATION ? null : importWorkspaceId })
    setDraft(next)
  })
  const confirmImport = () => draft && void act(async () => {
    const result = await applyWikiDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce })
    toast.success('draft' in result ? '导入已进入待审核' : '已沉淀到 Wiki')
    setDraft(null); setImportOpen(false); setImportTitle(''); setImportValue(''); await load()
  })
  const openImport = () => {
    if (!discardEdits()) return
    setImportWorkspaceId(currentWorkspaceId ?? INBOX_DESTINATION)
    setImportOpen(true)
  }
  const resetImportDraft = () => draft && void act(async () => {
    await cancelWikiDraft(draft.id)
    setDraft(null)
  })
  const setImportDialogOpen = (open: boolean) => {
    setImportOpen(open)
    if (!open) {
      if (draft) void cancelWikiDraft(draft.id).catch(() => undefined)
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 text-[var(--text-1)]">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)]">
        <div className="flex items-center justify-between px-3 py-3"><span className="text-sm font-semibold">知识归宿</span><Button variant="ghost" size="icon-sm" onClick={openImport} title="导入知识"><Import size={15} /></Button></div>
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
              <div className="mt-2 flex gap-1">{item.requiresRegeneration ? <Badge variant="destructive">需重新编辑</Badge> : <Button size="xs" disabled={busy || isDirty} onClick={() => void act(async () => { await resolveWikiPending(item.id, 'accept'); await load() })}>接受</Button>}<Button size="xs" variant="outline" disabled={busy || isDirty} onClick={() => void act(async () => { await resolveWikiPending(item.id, 'reject'); await load() })}>拒绝</Button></div>
            </div>
          )) : <div className="px-2 py-2 text-xs text-[var(--text-3)]">暂无待审核项</div>}
        </ScrollArea>
      </aside>

      <section className="flex w-[260px] shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex gap-2 p-3"><div className="relative min-w-0 flex-1"><Input value={query} onChange={(event) => { setQuery(event.target.value); setResultIds(null) }} onKeyDown={(event) => event.key === 'Enter' && search()} placeholder="搜索知识" className="pr-8" />{query && <Button variant="ghost" size="icon-xs" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => { setQuery(''); setResultIds(null) }} title="清除搜索"><X size={13} /></Button>}</div><Button variant="outline" size="icon" onClick={search} disabled={busy} title="搜索"><Search size={15} /></Button></div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
          {visiblePages.map((page) => <Button key={page.id} variant="ghost" onClick={() => selectPage(page.id)} className={cn('mb-1 h-auto w-full justify-start gap-2 px-2 py-2 text-left', selectedId === page.id && 'bg-[var(--surface-2)]')}><FileText size={14} /><span className="min-w-0"><span className="block truncate text-sm">{page.title}</span><span className="block text-[11px] text-[var(--text-3)]">{pageTypeLabel(page.type)}</span></span></Button>)}
          {loading ? <div className="flex items-center justify-center gap-2 p-6 text-sm text-[var(--text-3)]"><LoaderCircle className="animate-spin" size={15} />正在打开 Wiki…</div> : !visiblePages.length && <div className="space-y-3 p-5 text-center"><div className="text-sm text-[var(--text-3)]">{resultIds ? '没有匹配的知识' : '这个归宿还没有内容'}</div>{!resultIds && <Button size="sm" variant="outline" onClick={openImport}><Import size={14} />导入第一份内容</Button>}</div>}
        </ScrollArea>
      </section>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0"><div className="flex items-center gap-2"><div className="truncate font-semibold">{selected?.page.title ?? 'Wiki'}</div>{snapshot && <Badge variant={snapshot.capabilities.phase === 'B' ? 'secondary' : 'outline'} title={snapshot.capabilities.reason}>{snapshot.capabilities.phase === 'B' ? '智能维护已开启' : runtimePreparing || snapshot.capabilities.runtimeStatus === 'preparing' ? <><LoaderCircle className="animate-spin" size={11} />正在准备智能维护</> : '基础安全模式'}</Badge>}</div>{snapshot && <div className="mt-0.5 max-w-[560px] truncate text-[11px] text-[var(--text-3)]">{snapshot.pages.filter((page) => page.status === 'active').length} 条知识 · {snapshot.semanticCheck.message}</div>}</div>
          <div className="flex gap-2">{snapshot && <Button variant="outline" size="sm" onClick={() => void revealPathInSystem(snapshot.rootPath).catch(() => toast.error('打开 Wiki 目录失败'))}><FolderOpen size={14} />打开目录</Button>}<Button variant="outline" size="sm" onClick={() => void act(async () => { await runWikiLint(); await load() })} disabled={busy || isDirty} title={isDirty ? '请先保存或取消当前修改' : undefined}><RefreshCw className={cn(busy && 'animate-spin')} size={14} />检查</Button><Button variant="outline" size="sm" onClick={ask} disabled={busy}><MessageSquare size={14} />向 Wiki 提问</Button>{selected && (editing ? <><Button size="sm" variant="outline" onClick={discardEdits}>取消</Button><Button size="sm" onClick={save} disabled={busy || !isDirty}><Save size={14} />保存</Button></> : <Button size="sm" onClick={() => setEditing(true)}>编辑 Markdown</Button>)}</div>
        </header>
        {selected ? <div className="flex min-h-0 flex-1">
          <ScrollArea className="min-h-0 min-w-0 flex-1"><article className="mx-auto max-w-[820px] px-7 py-6">{editing ? <div className="space-y-3"><Input value={title} onChange={(event) => setTitle(event.target.value)} /><Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-[560px] font-mono text-sm" /></div> : <XMarkdown>{selected.page.body}</XMarkdown>}</article></ScrollArea>
          {inspectorOpen ? <aside className="w-[280px] shrink-0 border-l border-[var(--border)] p-4"><Button variant="ghost" size="sm" className="mb-3 w-full justify-between" onClick={() => setInspectorOpen(false)}>详情 <ChevronRight size={14} /></Button><Inspector page={selected.page} read={selected} snapshot={snapshot} disableMutations={busy || isDirty} onUndo={(batchId) => void act(async () => { await undoWikiBatch(batchId); await load() })} /></aside> : <Button variant="ghost" size="icon-sm" className="m-2" onClick={() => setInspectorOpen(true)} title="打开详情"><ChevronDown size={14} /></Button>}
        </div> : <div className="flex flex-1 items-center justify-center">{loading ? <div className="flex items-center gap-2 text-sm text-[var(--text-3)]"><LoaderCircle className="animate-spin" size={16} />正在加载知识库…</div> : <div className="space-y-3 text-center"><div className="text-sm text-[var(--text-3)]">导入一份内容，开始建立你的 Wiki</div><Button size="sm" onClick={openImport}><Import size={14} />导入内容</Button></div>}</div>}
      </main>

      <Dialog open={importOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>{draft ? '确认沉淀内容' : '导入到 Wiki'}</DialogTitle></DialogHeader>
          {draft ? <div className="space-y-3">
            <div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm font-medium">{draft.title}</div>
            {draft.diffs.map((diff) => <div key={diff.path} className="rounded-md border border-[var(--border)] p-2 text-xs"><div className="font-medium">{diff.preview}</div><div className="mt-1 truncate text-[var(--text-3)]">{diff.path}</div></div>)}
            <div className="text-xs text-[var(--text-3)]">来源与页面会作为同一批次写入，之后可从操作记录撤销。</div>
          </div> : <div className="space-y-3">
            <div className="flex flex-wrap gap-2"><Button size="sm" variant={importMode === 'text' ? 'default' : 'outline'} onClick={() => setImportMode('text')} disabled={busy}>粘贴文本</Button><Button size="sm" variant={importMode === 'url' ? 'default' : 'outline'} onClick={() => setImportMode('url')} disabled={busy}>URL</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('file')} disabled={busy}><FileText size={14} />文件</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('folder')} disabled={busy}><FolderOpen size={14} />文件夹</Button></div>
            <Input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} placeholder="标题（可选）" disabled={busy} />
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
function Inspector({ page, read, snapshot, disableMutations, onUndo }: { page: WikiPageRecord; read: WikiReadResult; snapshot: WikiSnapshot | null; disableMutations: boolean; onUndo: (batchId: string) => void }) {
  const findings = snapshot?.findings.filter((item) => item.pageId === page.id) ?? []
  const batches = snapshot?.recentBatches.filter((item) => item.affectedPageIds.includes(page.id)).slice(0, 8) ?? []
  return <ScrollArea className="h-[calc(100%-40px)]"><div className="space-y-5 text-xs"><section><div className="mb-2 font-semibold">元数据</div><div className="flex flex-wrap gap-1"><Badge variant="secondary">{pageTypeLabel(page.frontmatter.type)}</Badge><Badge variant="outline">版本 {page.revision}</Badge>{page.protected && <Badge variant="destructive">受保护</Badge>}</div></section><section><div className="mb-2 font-semibold">来源</div>{read.sources.length ? read.sources.map((source) => <div key={source.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{source.title}</div><div className="text-[var(--text-3)]">{source.kind} · {source.captureMode}</div>{source.restricted && <div className="mt-1 flex gap-1 text-amber-600"><ShieldAlert size={13} />来源受限</div>}</div>) : <div className="text-[var(--text-3)]">没有来源</div>}</section><section><div className="mb-2 font-semibold">链接</div><div className="text-[var(--text-3)]">{read.links.length} 出链 · {read.backlinks.length} 反向链接</div></section><section><div className="mb-2 font-semibold">版本与操作</div>{batches.length ? batches.map((batch) => <div key={batch.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{batch.origin} · {batch.state}</div><div className="text-[var(--text-3)]">{new Date(batch.createdAt).toLocaleString()}</div>{batch.state === 'committed' && <Button size="xs" variant="outline" className="mt-2" disabled={disableMutations} onClick={() => onUndo(batch.id)}>撤销</Button>}</div>) : <div className="text-[var(--text-3)]">暂无操作记录</div>}</section><section><div className="mb-2 font-semibold">检查结果</div>{findings.length ? findings.map((item) => <div key={item.id} className="mb-2">{item.message}</div>) : <div className="text-[var(--text-3)]">没有结构问题</div>}</section></div></ScrollArea>
}
