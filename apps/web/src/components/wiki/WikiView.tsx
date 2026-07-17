import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { ChevronDown, ChevronRight, ExternalLink, FileText, FolderOpen, Import, MessageSquare, RefreshCw, Save, Search, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { WikiChangeDraft, WikiPageRecord, WikiReadResult, WikiSnapshot } from '@lume/shared'
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, tabsAtom } from '@/atoms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { openExternal, openFileDialog, openFolderDialog } from '@/lib/desktop-api'
import { applyWikiDraft, createAskWikiThread, createWikiEditDraft, createWikiImportDraft, getWikiSnapshot, readWikiPage, resolveWikiPending, runWikiLint, searchWiki, undoWikiBatch } from '@/lib/desktop-api/wiki'
import { cn } from '@/lib/utils'
import { defaultAskWikiScope, filterWikiPages } from './wiki-view-state'

export function WikiView() {
  const [snapshot, setSnapshot] = useState<WikiSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WikiReadResult | null>(null)
  const [query, setQuery] = useState('')
  const [resultIds, setResultIds] = useState<string[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [importMode, setImportMode] = useState<'text' | 'url'>('text')
  const [importTitle, setImportTitle] = useState('')
  const [importValue, setImportValue] = useState('')
  const [draft, setDraft] = useState<WikiChangeDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const load = useCallback(async () => {
    const next = await getWikiSnapshot()
    setSnapshot(next)
    setSelectedId((current) => current && next.pages.some((page) => page.id === current) ? current : next.pages[0]?.id ?? null)
  }, [])

  useEffect(() => { void load().catch((error) => toast.error(error instanceof Error ? error.message : 'Wiki 加载失败')) }, [load])
  useEffect(() => {
    if (!selectedId) { setSelected(null); return }
    void readWikiPage(selectedId, { kind: 'all' }).then((next) => {
      setSelected(next); setTitle(next.page.title); setBody(next.page.body)
    }).catch((error) => toast.error(error instanceof Error ? error.message : '页面读取失败'))
  }, [selectedId, snapshot?.generation])

  const visiblePages = useMemo(() => {
    if (!snapshot) return []
    return filterWikiPages(snapshot.pages, resultIds)
  }, [resultIds, snapshot])

  const act = async (run: () => Promise<void>) => {
    setBusy(true)
    try { await run() } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const search = () => void act(async () => {
    if (!query.trim()) { setResultIds(null); return }
    const results = await searchWiki({ query, scope: { kind: 'all' }, maxResults: 50 })
    setResultIds(results.map((item) => item.page.id))
  })
  const save = () => selected && void act(async () => {
    const page = selected.page
    const nextDraft = await createWikiEditDraft({ pageId: page.id, expectedHash: page.hash, title, type: page.frontmatter.type, primaryWorkspaceId: page.frontmatter.primary_workspace_id, associatedWorkspaceIds: page.frontmatter.associated_workspace_ids, aliases: page.frontmatter.aliases, tags: page.frontmatter.tags, body })
    const result = await applyWikiDraft({ draftId: nextDraft.id, expectedRevision: nextDraft.revision, nonce: nextDraft.nonce })
    toast.success('draft' in result ? '变更已进入待审核' : 'Wiki 页面已保存')
    setEditing(false); await load()
  })
  const prepareImport = () => void act(async () => {
    if (!importValue.trim()) throw new Error(importMode === 'url' ? '请输入 URL' : '请输入要沉淀的内容')
    const next = await createWikiImportDraft({ source: importMode === 'url' ? { kind: 'url', url: importValue.trim(), title: importTitle || undefined } : { kind: 'text', text: importValue, title: importTitle || undefined }, title: importTitle || undefined, primaryWorkspaceId: currentWorkspaceId ?? null })
    setDraft(next)
  })
  const preparePickedImport = (kind: 'file' | 'folder') => void act(async () => {
    const path = kind === 'file' ? (await openFileDialog()).files[0]?.sourcePath : (await openFolderDialog()).path
    if (!path) return
    const next = await createWikiImportDraft({ source: kind === 'file' ? { kind: 'file', path } : { kind: 'folder', path }, primaryWorkspaceId: currentWorkspaceId ?? null })
    setDraft(next)
  })
  const confirmImport = () => draft && void act(async () => {
    const result = await applyWikiDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce })
    toast.success('draft' in result ? '导入已进入待审核' : '已沉淀到 Wiki')
    setDraft(null); setImportOpen(false); setImportTitle(''); setImportValue(''); await load()
  })
  const ask = () => void act(async () => {
    const scope = defaultAskWikiScope(selectedId, currentWorkspaceId)
    const { threadId } = await createAskWikiThread(scope)
    setTabs((items) => items.some((tab) => tab.id === threadId) ? items : [...items, { id: threadId, type: 'agent', title: '向 Wiki 提问', threadId }])
    setActiveTabId(threadId)
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 text-[var(--text-1)]">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)]">
        <div className="flex items-center justify-between px-3 py-3"><span className="text-sm font-semibold">知识归宿</span><Button variant="ghost" size="icon-sm" onClick={() => setImportOpen(true)} title="导入"><Import size={15} /></Button></div>
        <ScrollArea className="min-h-0 flex-1 px-2">
          <ScopeLabel label={`收件箱 · ${snapshot?.pages.filter((page) => page.primaryWorkspaceId === null).length ?? 0}`} />
          {workspaces.map((workspace) => <ScopeLabel key={workspace.id} label={`${workspace.name} · ${snapshot?.pages.filter((page) => page.primaryWorkspaceId === workspace.id).length ?? 0}`} />)}
          <ScopeLabel label={`已归档 · ${snapshot?.pages.filter((page) => page.status === 'archived').length ?? 0}`} />
          <div className="mt-5 px-2 text-[11px] uppercase tracking-wide text-[var(--text-3)]">待审核</div>
          {snapshot?.pending.length ? snapshot.pending.map((item) => (
            <div key={item.id} className="mt-2 rounded-lg border border-[var(--border)] p-2 text-xs">
              <div className="font-medium">{item.draft.title}</div><div className="mt-1 text-[var(--text-3)]">{item.reason}</div>
              <div className="mt-2 flex gap-1">{item.requiresRegeneration ? <Badge variant="destructive">需重新编辑</Badge> : <Button size="xs" onClick={() => void act(async () => { await resolveWikiPending(item.id, 'accept'); await load() })}>接受</Button>}<Button size="xs" variant="outline" onClick={() => void act(async () => { await resolveWikiPending(item.id, 'reject'); await load() })}>拒绝</Button></div>
            </div>
          )) : <div className="px-2 py-2 text-xs text-[var(--text-3)]">暂无待审核项</div>}
        </ScrollArea>
      </aside>

      <section className="flex w-[260px] shrink-0 flex-col border-r border-[var(--border)]">
        <div className="flex gap-2 p-3"><Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && search()} placeholder="搜索 Wiki" /><Button variant="outline" size="icon" onClick={search}><Search size={15} /></Button></div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
          {visiblePages.map((page) => <Button key={page.id} variant="ghost" onClick={() => { setSelectedId(page.id); setEditing(false) }} className={cn('mb-1 h-auto w-full justify-start gap-2 px-2 py-2 text-left', selectedId === page.id && 'bg-[var(--surface-2)]')}><FileText size={14} /><span className="min-w-0"><span className="block truncate text-sm">{page.title}</span><span className="block text-[11px] text-[var(--text-3)]">{page.type} · {page.status}</span></span></Button>)}
          {!visiblePages.length && <div className="p-4 text-center text-sm text-[var(--text-3)]">还没有 Wiki 页面</div>}
        </ScrollArea>
      </section>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div className="min-w-0"><div className="truncate font-semibold">{selected?.page.title ?? 'Wiki'}</div>{snapshot && <><div className="text-[11px] text-[var(--text-3)]">Phase {snapshot.capabilities.phase} · {snapshot.pages.length} pages · generation {snapshot.generation}</div><div className="max-w-[520px] truncate text-[11px] text-[var(--text-3)]">{snapshot.semanticCheck.message}</div></>}</div>
          <div className="flex gap-2">{snapshot && <Button variant="outline" size="sm" onClick={() => void openExternal(`obsidian://open?path=${encodeURIComponent(snapshot.rootPath)}`).catch(() => toast.error('未能打开 Obsidian'))}><ExternalLink size={14} />Obsidian</Button>}<Button variant="outline" size="sm" onClick={() => void act(async () => { await runWikiLint(); await load() })}><RefreshCw size={14} />检查</Button><Button variant="outline" size="sm" onClick={ask}><MessageSquare size={14} />向 Wiki 提问</Button>{selected && (editing ? <Button size="sm" onClick={save} disabled={busy}><Save size={14} />保存</Button> : <Button size="sm" onClick={() => setEditing(true)}>编辑 Markdown</Button>)}</div>
        </header>
        {selected ? <div className="flex min-h-0 flex-1">
          <ScrollArea className="min-h-0 min-w-0 flex-1"><article className="mx-auto max-w-[820px] px-7 py-6">{editing ? <div className="space-y-3"><Input value={title} onChange={(event) => setTitle(event.target.value)} /><Textarea value={body} onChange={(event) => setBody(event.target.value)} className="min-h-[560px] font-mono text-sm" /></div> : <XMarkdown>{selected.page.body}</XMarkdown>}</article></ScrollArea>
          {inspectorOpen ? <aside className="w-[280px] shrink-0 border-l border-[var(--border)] p-4"><Button variant="ghost" size="sm" className="mb-3 w-full justify-between" onClick={() => setInspectorOpen(false)}>Inspector <ChevronRight size={14} /></Button><Inspector page={selected.page} read={selected} snapshot={snapshot} onUndo={(batchId) => void act(async () => { await undoWikiBatch(batchId); await load() })} /></aside> : <Button variant="ghost" size="icon-sm" className="m-2" onClick={() => setInspectorOpen(true)}><ChevronDown size={14} /></Button>}
        </div> : <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-3)]">导入一份内容，开始建立你的 Wiki</div>}
      </main>

      <Dialog open={importOpen} onOpenChange={(open) => { setImportOpen(open); if (!open) setDraft(null) }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>导入到 Wiki</DialogTitle></DialogHeader>{draft ? <div className="space-y-3"><div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm">{draft.title}</div>{draft.diffs.map((diff) => <div key={diff.path} className="text-xs"><div className="font-medium">{diff.preview}</div><div className="truncate text-[var(--text-3)]">{diff.path}</div></div>)}<div className="text-xs text-[var(--text-3)]">来源与页面将在确认后作为同一批次写入，可从操作记录撤销。</div></div> : <div className="space-y-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant={importMode === 'text' ? 'default' : 'outline'} onClick={() => setImportMode('text')}>粘贴文本</Button><Button size="sm" variant={importMode === 'url' ? 'default' : 'outline'} onClick={() => setImportMode('url')}>URL</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('file')}><FileText size={14} />文件</Button><Button size="sm" variant="outline" onClick={() => preparePickedImport('folder')}><FolderOpen size={14} />文件夹</Button></div><Input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} placeholder="标题（可选）" />{importMode === 'text' ? <Textarea value={importValue} onChange={(event) => setImportValue(event.target.value)} className="min-h-56" placeholder="粘贴需要长期维护的内容" /> : <Input value={importValue} onChange={(event) => setImportValue(event.target.value)} placeholder="https://…" />}<div className="text-xs text-[var(--text-3)]">主要归宿：{workspaces.find((item) => item.id === currentWorkspaceId)?.name ?? '收件箱'}</div></div>}<DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button><Button onClick={draft ? confirmImport : prepareImport} disabled={busy}>{draft ? '确认写入' : '生成确认单'}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  )
}

function ScopeLabel({ label }: { label: string }) { return <div className="rounded-md px-2 py-1.5 text-xs text-[var(--text-2)]">{label}</div> }
function Inspector({ page, read, snapshot, onUndo }: { page: WikiPageRecord; read: WikiReadResult; snapshot: WikiSnapshot | null; onUndo: (batchId: string) => void }) {
  const findings = snapshot?.findings.filter((item) => item.pageId === page.id) ?? []
  const batches = snapshot?.recentBatches.filter((item) => item.affectedPageIds.includes(page.id)).slice(0, 8) ?? []
  return <ScrollArea className="h-[calc(100%-40px)]"><div className="space-y-5 text-xs"><section><div className="mb-2 font-semibold">元数据</div><div className="flex flex-wrap gap-1"><Badge variant="secondary">{page.frontmatter.type}</Badge><Badge variant="outline">rev {page.revision}</Badge>{page.protected && <Badge variant="destructive">protected</Badge>}</div></section><section><div className="mb-2 font-semibold">来源</div>{read.sources.length ? read.sources.map((source) => <div key={source.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{source.title}</div><div className="text-[var(--text-3)]">{source.kind} · {source.captureMode}</div>{source.restricted && <div className="mt-1 flex gap-1 text-amber-600"><ShieldAlert size={13} />来源受限</div>}</div>) : <div className="text-[var(--text-3)]">没有来源</div>}</section><section><div className="mb-2 font-semibold">链接</div><div className="text-[var(--text-3)]">{read.links.length} 出链 · {read.backlinks.length} 反向链接</div></section><section><div className="mb-2 font-semibold">版本与操作</div>{batches.length ? batches.map((batch) => <div key={batch.id} className="mb-2 rounded-md border border-[var(--border)] p-2"><div>{batch.origin} · {batch.state}</div><div className="text-[var(--text-3)]">{new Date(batch.createdAt).toLocaleString()}</div>{batch.state === 'committed' && <Button size="xs" variant="outline" className="mt-2" onClick={() => onUndo(batch.id)}>撤销</Button>}</div>) : <div className="text-[var(--text-3)]">暂无操作记录</div>}</section><section><div className="mb-2 font-semibold">检查结果</div>{findings.length ? findings.map((item) => <div key={item.id} className="mb-2">{item.message}</div>) : <div className="text-[var(--text-3)]">没有结构问题</div>}</section></div></ScrollArea>
}
