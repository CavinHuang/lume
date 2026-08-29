import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FilePlus, RefreshCw, Save, X } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import type { ObsidianVaultConfig, ObsidianVaultFileEntry, ObsidianVaultReadResult } from '@lume/shared'
import {
  createObsidianVaultNote,
  deleteObsidianVaultFile,
  getObsidianVaultConfig,
  listObsidianVaultFiles,
  readObsidianVaultFile,
  renameObsidianVaultFile,
  setObsidianVaultFocus,
  writeObsidianVaultFile,
} from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'

interface VaultTreeNode {
  name: string
  path: string
  isFolder: boolean
  children: VaultTreeNode[]
  modifiedAt: number
}

/** 从有界扁平列表（≤5000 条）构建目录树；路径均为正斜杠相对路径。 */
export function buildVaultTree(entries: ObsidianVaultFileEntry[]): VaultTreeNode[] {
  const rootChildren: VaultTreeNode[] = []
  const folderIndex = new Map<string, VaultTreeNode>([['', { name: '', path: '', isFolder: true, children: rootChildren, modifiedAt: 0 }]])
  const ensureFolder = (path: string): VaultTreeNode => {
    const existing = folderIndex.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const parentPath = slash > 0 ? path.slice(0, slash) : ''
    const node: VaultTreeNode = { name: path.slice(slash + 1), path, isFolder: true, children: [], modifiedAt: 0 }
    folderIndex.set(path, node)
    ensureFolder(parentPath).children.push(node)
    return node
  }
  for (const entry of entries) {
    const slash = entry.relativePath.lastIndexOf('/')
    const parent = ensureFolder(slash > 0 ? entry.relativePath.slice(0, slash) : '')
    parent.children.push({ name: entry.name, path: entry.relativePath, isFolder: false, children: [], modifiedAt: entry.modifiedAt })
  }
  const sortNodes = (nodes: VaultTreeNode[]): VaultTreeNode[] => {
    nodes.sort((left, right) => left.isFolder !== right.isFolder ? (left.isFolder ? -1 : 1) : left.name.localeCompare(right.name))
    for (const node of nodes) sortNodes(node.children)
    return nodes
  }
  return sortNodes(rootChildren)
}

/** 树节点扁平化（深度优先），配合 visibleFolders 过滤出可见行。 */
function collectVisibleRows(nodes: VaultTreeNode[], visibleFolders: Set<string>, depth: number, rows: Array<{ node: VaultTreeNode; depth: number }>): void {
  for (const node of nodes) {
    rows.push({ node, depth })
    if (node.isFolder && visibleFolders.has(node.path)) collectVisibleRows(node.children, visibleFolders, depth + 1, rows)
  }
}

export function VaultRightPanelWorkspace({ threadId }: { threadId?: string }) {
  const [config, setConfig] = useState<ObsidianVaultConfig | null>(null)
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<ObsidianVaultFileEntry[] | null>(null)
  const [visibleFolders, setVisibleFolders] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<{ path: string; read: ObsidianVaultReadResult } | null>(null)
  const [mode, setMode] = useState<'render' | 'edit'>('render')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const focusSequence = useRef(0)
  const focusThreadRef = useRef(threadId)
  focusThreadRef.current = threadId

  const vaults = useMemo(() => config?.candidates ?? [], [config])
  const activeVault = vaults.find((vault) => vault.path === vaultPath) ?? null
  const tree = useMemo(() => entries ? buildVaultTree(entries) : [], [entries])
  const visibleRows = useMemo(() => {
    const rows: Array<{ node: VaultTreeNode; depth: number }> = []
    collectVisibleRows(tree, visibleFolders, 0, rows)
    return rows
  }, [tree, visibleFolders])
  const dirty = selectedFile !== null && draft !== selectedFile.read.content

  const reportFocus = useCallback((kind: 'file' | 'folder', relativePath: string) => {
    const thread = focusThreadRef.current
    if (!thread || !vaultPath) return
    focusSequence.current += 1
    void setObsidianVaultFocus(thread, vaultPath, { kind, relativePath, sequence: focusSequence.current }).catch(() => undefined)
  }, [vaultPath])

  const loadFiles = useCallback(async (path: string) => {
    try {
      const list = await listObsidianVaultFiles(path)
      setEntries(list)
      setVisibleFolders((current) => {
        const next = new Set(current)
        if (next.size === 0) for (const node of buildVaultTree(list)) if (node.isFolder) next.add(node.path)
        return next
      })
    } catch (cause) {
      setEntries([])
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 首次进入面板：拉配置并选中第一个 vault。禁用/无候选时展示引导空态。
  useEffect(() => {
    let cancelled = false
    void getObsidianVaultConfig()
      .then(async (next) => {
        if (cancelled) return
        setConfig(next)
        if (next.enabled && next.candidates.length > 0) {
          setVaultPath((current) => current ?? next.candidates[0]!.path)
        }
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (vaultPath) void loadFiles(vaultPath)
  }, [vaultPath, loadFiles])

  const openFile = useCallback(async (relativePath: string) => {
    if (!vaultPath) return
    try {
      const read = await readObsidianVaultFile(vaultPath, relativePath)
      setSelectedFile({ path: relativePath, read })
      setDraft(read.content)
      setMode('render')
      setError(null)
      setConflict(false)
      reportFocus('file', relativePath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [reportFocus, vaultPath])

  const toggleFolder = useCallback((path: string) => {
    setVisibleFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (path) reportFocus('folder', path)
  }, [reportFocus])

  const saveDraft = useCallback(async () => {
    if (!vaultPath || !selectedFile) return
    setSaving(true)
    try {
      const result = await writeObsidianVaultFile({
        vaultPath,
        relativePath: selectedFile.path,
        content: draft,
        expectedSha256: selectedFile.read.sha256,
      })
      if (result.ok) {
        setSelectedFile({ path: selectedFile.path, read: { relativePath: result.relativePath, content: draft, sha256: result.sha256, modifiedAt: result.modifiedAt } })
        setMode('render')
        setConflict(false)
        setError(null)
      } else {
        setConflict(true)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [draft, selectedFile, vaultPath])

  const reloadSelected = useCallback(async () => {
    if (!vaultPath || !selectedFile) return
    await openFile(selectedFile.path)
    setConflict(false)
  }, [openFile, selectedFile, vaultPath])

  const createNote = useCallback(async () => {
    if (!vaultPath) return
    try {
      const result = await createObsidianVaultNote(vaultPath)
      await loadFiles(vaultPath)
      if (result.ok) await openFile(result.relativePath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadFiles, openFile, vaultPath])

  const submitRename = useCallback(async () => {
    if (!vaultPath || !renameTarget || !renameName.trim()) return
    try {
      const renamed = await renameObsidianVaultFile({ vaultPath, relativePath: renameTarget, name: renameName })
      setRenameTarget(null)
      await loadFiles(vaultPath)
      if (selectedFile?.path === renameTarget) await openFile(renamed.relativePath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadFiles, openFile, renameName, renameTarget, selectedFile, vaultPath])

  const submitDelete = useCallback(async () => {
    if (!vaultPath || !deleteTarget) return
    try {
      await deleteObsidianVaultFile({ vaultPath, relativePath: deleteTarget })
      setDeleteTarget(null)
      if (selectedFile?.path === deleteTarget) setSelectedFile(null)
      await loadFiles(vaultPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [deleteTarget, loadFiles, selectedFile, vaultPath])

  if (config && (!config.enabled || vaults.length === 0)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-foreground/70">
          {config.enabled ? '未发现 Obsidian Vault' : 'Obsidian Vault 集成已关闭'}
        </p>
        <p className="text-[11px] text-foreground/50">在「设置 → 集成」中开启集成、添加文件夹或安装并打开一次 Obsidian。</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 w-[42%] min-w-[180px] shrink-0 flex-col border-r border-border/60">
        <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
          {vaults.length > 1 ? (
            <Select value={vaultPath ?? ''} onValueChange={(value) => { setVaultPath(value); setEntries(null); setSelectedFile(null) }}>
              <SelectTrigger className="h-7 min-w-0 flex-1 text-[12px]" aria-label="选择 Vault">
                <SelectValue placeholder="选择 Vault" />
              </SelectTrigger>
              <SelectContent>
                {vaults.map((vault) => (
                  <SelectItem key={vault.path} value={vault.path}>{vault.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium text-foreground/80" title={activeVault?.path}>
              {activeVault?.displayName ?? 'Obsidian Vault'}
            </span>
          )}
          <Button variant="ghost" size="icon-sm" className="size-6" title="新建笔记" onClick={() => void createNote()}>
            <FilePlus size={13} />
          </Button>
          <Button variant="ghost" size="icon-sm" className="size-6" title="刷新" onClick={() => vaultPath && void loadFiles(vaultPath)}>
            <RefreshCw size={13} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {entries === null
            ? <p className="px-2 py-3 text-[11px] text-foreground/45">加载中…</p>
            : visibleRows.map(({ node, depth }) => (
              <button
                key={node.path || '/'}
                type="button"
                className={cn(
                  'flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left text-[12px] text-foreground/75 hover:bg-[var(--lume-bg-elevated)]',
                  !node.isFolder && selectedFile?.path === node.path && 'bg-[var(--lume-bg-elevated)] text-foreground',
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                title={node.path}
                onClick={() => node.isFolder ? toggleFolder(node.path) : void openFile(node.path)}
              >
                {node.isFolder
                  ? <ChevronRight size={12} className={cn('shrink-0 text-foreground/40 transition-transform', visibleFolders.has(node.path) && 'rotate-90')} />
                  : <span className="w-3 shrink-0" />}
                <FileTypeIcon filename={node.name} isDirectory={node.isFolder} size={13} />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              </button>
            ))}
          {entries !== null && entries.length === 0 && <p className="px-2 py-3 text-[11px] text-foreground/45">此 Vault 暂无 Markdown 笔记</p>}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex items-center gap-2 border-b border-border/60 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400">
            <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
            <Button variant="ghost" size="icon-sm" className="size-5" title="关闭" onClick={() => setError(null)}><X size={12} /></Button>
          </div>
        )}
        {selectedFile ? (
          <>
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/60" title={selectedFile.path}>{selectedFile.path}</span>
              {conflict && <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">文件已被外部修改</span>}
              {mode === 'render' ? (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { setDraft(selectedFile.read.content); setMode('edit') }}>编辑</Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={saving} onClick={() => void saveDraft()}>
                    <Save size={12} />{dirty ? '保存' : '已保存'}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { setMode('render'); setConflict(false) }}>取消</Button>
                </>
              )}
              {conflict && <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void reloadSelected()}>重新加载</Button>}
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { setRenameTarget(selectedFile.path); setRenameName(defaultRenameName(selectedFile.path)) }}>重命名</Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-red-600 dark:text-red-400" onClick={() => setDeleteTarget(selectedFile.path)}>删除</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {mode === 'edit'
                ? <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="h-full min-h-full resize-none rounded-none border-0 font-mono text-[12.5px] leading-5 focus-visible:ring-0"
                    spellCheck={false}
                    aria-label="编辑笔记"
                  />
                : <XMarkdown className="x-markdown px-4 py-3 text-[13px] leading-6">{selectedFile.read.content}</XMarkdown>}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-foreground/45">
            从左侧选择一篇笔记；在会话中打开的笔记会作为 Vault 焦点提供给 Agent
          </div>
        )}
      </div>
      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名笔记</DialogTitle>
          </DialogHeader>
          <Input value={renameName} onChange={(event) => setRenameName(event.target.value)} aria-label="新名称" autoFocus
            onKeyDown={(event) => { if (event.key === 'Enter') void submitRename() }} />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button size="sm" onClick={() => void submitRename()}>重命名</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="删除笔记？"
        description={deleteTarget ?? ''}
        confirmLabel="删除"
        onConfirm={() => void submitDelete()}
      />
    </div>
  )
}

function defaultRenameName(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? relativePath
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}
