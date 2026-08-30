import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronsUpDown, CircleHelp, FilePlus, Folder, FolderOpen, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { toast } from 'sonner'
import type { ObsidianVaultConfig, ObsidianVaultFileEntry, ObsidianVaultReadResult } from '@lume/shared'
import {
  addObsidianFolderVault,
  createObsidianManagedVault,
  createObsidianVaultFolder,
  createObsidianVaultNote,
  deleteObsidianVaultFile,
  getObsidianVaultConfig,
  listObsidianVaultFiles,
  openFolderDialog,
  readObsidianVaultFile,
  renameObsidianVaultFile,
  setObsidianVaultFocus,
  writeObsidianVaultFile,
} from '@/lib/desktop-api'
import { obsidianVaultEditorAtom, obsidianVaultOpenRequestAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { VaultLiveMarkdownEditor } from '@/components/obsidian/VaultLiveMarkdownEditor'
import { cn } from '@/lib/utils'

/** 头部「新建笔记」落入收件夹（对齐 Proma 的 inboxPath 语义）。 */
const INBOX_FOLDER = 'Lume Inbox'
const TREE_MIN_WIDTH = 180
const TREE_MAX_WIDTH = 520

interface VaultTreeNode {
  name: string
  path: string
  isFolder: boolean
  children: VaultTreeNode[]
}

/** 从有界扁平列表（≤5000 条）构建目录树；路径均为正斜杠相对路径。 */
export function buildVaultTree(entries: ObsidianVaultFileEntry[]): VaultTreeNode[] {
  const rootChildren: VaultTreeNode[] = []
  const folderIndex = new Map<string, VaultTreeNode>([['', { name: '', path: '', isFolder: true, children: rootChildren }]])
  const ensureFolder = (path: string): VaultTreeNode => {
    const existing = folderIndex.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const parentPath = slash > 0 ? path.slice(0, slash) : ''
    const node: VaultTreeNode = { name: path.slice(slash + 1), path, isFolder: true, children: [] }
    folderIndex.set(path, node)
    ensureFolder(parentPath).children.push(node)
    return node
  }
  for (const entry of entries) {
    const slash = entry.relativePath.lastIndexOf('/')
    const parent = ensureFolder(slash > 0 ? entry.relativePath.slice(0, slash) : '')
    parent.children.push({ name: entry.name, path: entry.relativePath, isFolder: false, children: [] })
  }
  const sortNodes = (nodes: VaultTreeNode[]): VaultTreeNode[] => {
    nodes.sort((left, right) => left.isFolder !== right.isFolder ? (left.isFolder ? -1 : 1) : left.name.localeCompare(right.name, undefined, { numeric: true }))
    for (const node of nodes) sortNodes(node.children)
    return nodes
  }
  return sortNodes(rootChildren)
}

export function allVaultFolderPaths(nodes: VaultTreeNode[]): string[] {
  const paths: string[] = []
  const visit = (folder: VaultTreeNode): void => {
    for (const child of folder.children) {
      if (!child.isFolder) continue
      paths.push(child.path)
      visit(child)
    }
  }
  visit({ name: '', path: '', isFolder: true, children: nodes })
  return paths
}

export function getVaultFolderAncestors(relativePath: string): string[] {
  const ancestors: string[] = []
  let current = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  while (current) {
    ancestors.unshift(current)
    const slash = current.lastIndexOf('/')
    current = slash > 0 ? current.slice(0, slash) : ''
  }
  return ancestors
}

function displayDocumentTitle(filename: string): string {
  return filename.replace(/\.md$/i, '')
}

export function VaultRightPanelWorkspace({ threadId }: { threadId?: string }) {
  const openRequest = useAtomValue(obsidianVaultOpenRequestAtom)
  const setOpenRequest = useSetAtom(obsidianVaultOpenRequestAtom)
  const [editorSnapshot, setEditorSnapshot] = useAtom(obsidianVaultEditorAtom)
  // 仅在首次挂载时读取快照：面板在右面板/全页 tab 之间切换即卸载，
  // 重进时恢复打开的 vault、笔记与草稿（Proma 全局 atoms 语义）。
  const restoredRef = useRef(editorSnapshot)
  const [config, setConfig] = useState<ObsidianVaultConfig | null>(null)
  const [vaultPath, setVaultPath] = useState<string | null>(() => restoredRef.current.vaultPath || null)
  const [entries, setEntries] = useState<ObsidianVaultFileEntry[] | null>(null)
  const [visibleFolders, setVisibleFolders] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<{ path: string; read: ObsidianVaultReadResult } | null>(() => restoredRef.current.selectedFile)
  const [draft, setDraft] = useState(() => restoredRef.current.draft)
  const [saving, setSaving] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [editorReopenVersion, setEditorReopenVersion] = useState(0)
  const [treeAction, setTreeAction] = useState<{ type: 'expand' | 'collapse'; version: number }>({ type: 'collapse', version: 0 })
  const [treeWidth, setTreeWidth] = useState(220)
  const focusSequence = useRef(Date.now())
  const selectedFileRef = useRef(selectedFile)
  const vaultPathRef = useRef(vaultPath)
  const threadRef = useRef(threadId)
  const draftRef = useRef(draft)
  const readRequestRef = useRef(0)
  const externalNoticeRef = useRef<string | null>(null)
  const treeWidthRef = useRef(treeWidth)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  selectedFileRef.current = selectedFile
  vaultPathRef.current = vaultPath
  threadRef.current = threadId
  draftRef.current = draft
  treeWidthRef.current = treeWidth

  const vaults = useMemo(() => config?.candidates ?? [], [config])
  const activeVault = vaults.find((vault) => vault.path === vaultPath) ?? null
  const tree = useMemo(() => entries ? buildVaultTree(entries) : [], [entries])
  const dirty = selectedFile !== null && draft !== selectedFile.read.content

  // 选中文件/焦点文件夹的祖先链自动展开（Proma 同语义）。
  useEffect(() => {
    if (!selectedFile) return
    const ancestors = getVaultFolderAncestors(selectedFile.path)
    if (ancestors.length === 0) return
    setVisibleFolders((current) => {
      const next = new Set(current)
      let changed = false
      for (const path of ancestors) if (!next.has(path)) { next.add(path); changed = true }
      return changed ? next : current
    })
  }, [selectedFile])

  useEffect(() => {
    if (treeAction.version === 0) return
    setVisibleFolders(treeAction.type === 'expand' ? new Set(allVaultFolderPaths(tree)) : new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeAction])

  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  // 打开状态写入全局 atom：tab 切换卸载后重进可恢复 vault、笔记与草稿。
  useEffect(() => {
    setEditorSnapshot({ vaultPath: vaultPath ?? '', selectedFile, draft })
  }, [vaultPath, selectedFile, draft, setEditorSnapshot])

  const reportFocus = useCallback((focus: { kind: 'file' | 'folder'; relativePath: string } | null): void => {
    const thread = threadRef.current
    const vault = vaultPathRef.current
    if (!thread || !vault) return
    const next = focus ? { ...focus, sequence: ++focusSequence.current } : null
    void setObsidianVaultFocus(thread, vault, next).catch(() => undefined)
  }, [])

  // 卸载时清空会话焦点，避免 Agent 带着已关闭的笔记上下文运行。
  useEffect(() => () => {
    const thread = threadRef.current
    const vault = vaultPathRef.current
    if (!thread || !vault) return
    void setObsidianVaultFocus(thread, vault, null).catch(() => undefined)
  }, [])

  const loadFiles = useCallback(async (path: string, showLoading = false): Promise<ObsidianVaultFileEntry[]> => {
    if (showLoading) setEntries(null)
    try {
      const list = await listObsidianVaultFiles(path)
      setEntries((current) => {
        if (current !== null && current.length === list.length
          && current.every((entry, index) => entry.relativePath === list[index]?.relativePath && entry.modifiedAt === list[index]?.modifiedAt)) return current
        return list
      })
      // 外部删除检测：已打开的笔记从列表消失时清空编辑区（Proma 同语义）。
      const selected = selectedFileRef.current
      if (selected && !list.some((entry) => entry.relativePath === selected.path)) {
        ++readRequestRef.current
        setSelectedFile(null)
        setDraft('')
        reportFocus(null)
        toast.message('已打开的笔记不存在')
        return list
      }
      // 外部修改采纳：草稿未动时静默同步磁盘最新内容（shouldAdoptVaultReadContent 语义）。
      if (selected && draftRef.current === selected.read.content) {
        try {
          const fresh = await readObsidianVaultFile(path, selected.path)
          if (selectedFileRef.current?.path === selected.path && fresh.sha256 !== selected.read.sha256) {
            setSelectedFile({ path: selected.path, read: fresh })
            setDraft(fresh.content)
          }
        } catch {
          // 读取失败保持现状；保存时会走 sha256 冲突路径兜底。
        }
      }
      return list
    } catch (cause) {
      setEntries([])
      toast.error(cause instanceof Error ? cause.message : '无法读取 Vault 文件列表')
      return []
    }
  }, [reportFocus])

  const saveDraft = useCallback(async ({ silent = false } = {}): Promise<void> => {
    const selected = selectedFileRef.current
    const vault = vaultPathRef.current
    if (saving || !selected || !vault || draftRef.current === selected.read.content) return
    setSaving(true)
    try {
      const result = await writeObsidianVaultFile({
        vaultPath: vault,
        relativePath: selected.path,
        content: draftRef.current,
        expectedSha256: selected.read.sha256,
      })
      if (result.ok) {
        setSelectedFile({ path: selected.path, read: { relativePath: result.relativePath, content: draftRef.current, sha256: result.sha256, modifiedAt: result.modifiedAt } })
        setConflict(false)
        void loadFiles(vault)
        if (!silent) toast.success('已保存到 Vault')
      } else {
        setConflict(true)
        toast.error('文件已在外部修改，请重新加载后再保存')
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [loadFiles, saving])

  // 自动保存：输入停止 700ms 后静默保存（Proma 同节奏）。
  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => { void saveDraft({ silent: true }) }, 700)
    return () => window.clearTimeout(timer)
  }, [dirty, draft, saveDraft])

  // Cmd/Ctrl + S 立即保存（编辑器聚焦时由 ink-mde 处理，此处兜底全局）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveDraft()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveDraft])

  const flushPendingSave = useCallback(async (): Promise<void> => {
    await saveDraft({ silent: true })
  }, [saveDraft])

  const openFileIn = useCallback(async (vault: string, relativePath: string): Promise<void> => {
    const requestId = ++readRequestRef.current
    setFileLoading(true)
    setSelectedFile({ path: relativePath, read: { relativePath, content: '', sha256: '', modifiedAt: 0 } })
    setDraft('')
    setRenameName(displayDocumentTitle(relativePath.split('/').pop() ?? relativePath))
    setConflict(false)
    try {
      const result = await readObsidianVaultFile(vault, relativePath)
      if (requestId !== readRequestRef.current) return
      setSelectedFile({ path: relativePath, read: result })
      setDraft(result.content)
      setRenameName(displayDocumentTitle(relativePath.split('/').pop() ?? relativePath))
      reportFocus({ kind: 'file', relativePath })
    } catch (cause) {
      if (requestId !== readRequestRef.current) return
      setSelectedFile(null)
      toast.error(cause instanceof Error ? cause.message : '无法打开笔记')
    } finally {
      if (requestId === readRequestRef.current) setFileLoading(false)
    }
  }, [reportFocus])

  const openFile = useCallback(async (relativePath: string): Promise<void> => {
    if (!vaultPath) return
    // 显式点击已选中的笔记是外部写冲突后的恢复路径：不冲洗待存草稿，
    // 直接放弃本地草稿并从磁盘重挂载（Proma 的 reopenVersion 语义）。
    const reopenCurrentFile = selectedFileRef.current?.path === relativePath
    if (!reopenCurrentFile) await flushPendingSave()
    await openFileIn(vaultPath, relativePath)
    if (reopenCurrentFile) setEditorReopenVersion((version) => version + 1)
  }, [flushPendingSave, openFileIn, vaultPath])

  // 编辑区滚轮转发：落在标题栏/留白上的滚动交给 CodeMirror 内容区（Proma 同款）。
  const editorPaneRef = useRef<HTMLDivElement | null>(null)
  const handleEditorPageWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('.vault-ink-mde')) return
    const scroller = editorPaneRef.current?.querySelector<HTMLElement>('.vault-ink-mde .cm-scroller')
    if (!scroller) return
    scroller.scrollTop += event.deltaY
    scroller.scrollLeft += event.deltaX
  }, [])

  // 首次进入面板：拉配置并选中第一个 vault。
  useEffect(() => {
    let cancelled = false
    void getObsidianVaultConfig()
      .then((next) => {
        if (cancelled) return
        setConfig(next)
        if (next.enabled && next.candidates.length > 0) {
          setVaultPath((current) => current ?? next.candidates[0]!.path)
        }
      })
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : '无法读取 Vault 配置'))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // 恢复已打开笔记时不闪文件树加载态。
    if (vaultPath) void loadFiles(vaultPath, !restoredRef.current.selectedFile)
  }, [vaultPath, loadFiles])

  // Agent 工具会绕过本组件直接改写 Vault 文件；只轮询当前打开的笔记、
  // 不扫整棵树，外部改动无需任何操作即反映到编辑器（Proma 同语义）。
  useEffect(() => {
    const relativePath = selectedFile?.path
    const sha256 = selectedFile?.read.sha256
    const vault = vaultPath
    if (!relativePath || !sha256 || !vault) return
    let cancelled = false
    let checking = false
    const checkCurrentFile = async (): Promise<void> => {
      if (checking || cancelled || selectedFileRef.current?.path !== relativePath) return
      checking = true
      try {
        const next = await readObsidianVaultFile(vault, relativePath)
        if (cancelled || selectedFileRef.current?.path !== relativePath || next.sha256 === sha256) return
        // 草稿未动：静默采纳磁盘内容并更新基线。草稿已动：保留旧基线不动——
        // 保存时的 expectedSha256 仍是旧值，必然走冲突路径，由用户选择重开或放弃
        // （Proma 保留旧 saveBase 的语义）；外部 sha 只提示一次。
        if (draftRef.current === selectedFileRef.current?.read.content) {
          setSelectedFile({ path: relativePath, read: next })
          setDraft(next.content)
        } else if (externalNoticeRef.current !== next.sha256) {
          externalNoticeRef.current = next.sha256
          toast.message('笔记已被外部修改；本地草稿未保存')
        }
      } catch {
        // 并发的重命名/删除由既有列表刷新与打开错误路径处理；轻量检查保持静默。
      } finally {
        checking = false
      }
    }
    const timer = window.setInterval(() => { void checkCurrentFile() }, 1_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [selectedFile?.path, selectedFile?.read.sha256, vaultPath])

  // 回合 chip 等外部请求：切 vault 并直接打开目标文件/文件夹。
  useEffect(() => {
    if (!openRequest) return
    setOpenRequest(null)
    const { vaultPath: requestVault, filePath, folderPath } = openRequest
    setVaultPath(requestVault)
    void loadFiles(requestVault)
    if (filePath) void openFileIn(requestVault, filePath)
    else if (folderPath) {
      setVisibleFolders((current) => new Set([...current, ...getVaultFolderAncestors(folderPath), folderPath]))
      if (threadRef.current) {
        focusSequence.current += 1
        void setObsidianVaultFocus(threadRef.current, requestVault, { kind: 'folder', relativePath: folderPath, sequence: focusSequence.current }).catch(() => undefined)
      }
    }
  }, [openRequest, loadFiles, openFileIn, setOpenRequest])

  const toggleFolder = useCallback((path: string): void => {
    setVisibleFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    reportFocus({ kind: 'folder', relativePath: path })
  }, [reportFocus])

  const createNote = useCallback(async (folderPath?: string): Promise<void> => {
    const vault = vaultPathRef.current
    if (!vault) return
    try {
      const result = await createObsidianVaultNote(vault, folderPath ?? INBOX_FOLDER)
      await loadFiles(vault)
      if (result.ok) await openFileIn(vault, result.relativePath)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法创建笔记')
    }
  }, [loadFiles, openFileIn])

  const createFolder = useCallback(async (): Promise<void> => {
    if (newFolderParent === null || !vaultPath) return
    const name = newFolderName.trim()
    if (!name) return
    try {
      await createObsidianVaultFolder(vaultPath, newFolderParent ? `${newFolderParent}/${name}` : name)
      setNewFolderParent(null)
      await loadFiles(vaultPath)
      toast.success(`已创建文件夹 ${name}`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法创建文件夹')
    }
  }, [loadFiles, newFolderName, newFolderParent, vaultPath])

  const submitRename = useCallback(async (): Promise<void> => {
    const selected = selectedFileRef.current
    const vault = vaultPathRef.current
    if (!selected || !vault) return
    const currentName = displayDocumentTitle(selected.path.split('/').pop() ?? selected.path)
    const name = renameName.trim()
    if (!name || name === currentName) {
      setRenameName(currentName)
      return
    }
    try {
      const renamed = await renameObsidianVaultFile({ vaultPath: vault, relativePath: selected.path, name, expectedSha256: selected.read.sha256 })
      await loadFiles(vault)
      await openFileIn(vault, renamed.relativePath)
      toast.success('已重命名笔记')
    } catch (cause) {
      setRenameName(currentName)
      toast.error(cause instanceof Error ? cause.message : '无法重命名笔记')
    }
  }, [loadFiles, openFileIn, renameName])

  const submitDelete = useCallback(async (): Promise<void> => {
    const vault = vaultPathRef.current
    if (!deleteTarget || deleting || !vault) return
    setDeleting(true)
    try {
      const selected = selectedFileRef.current
      const expectedSha256 = selected?.path === deleteTarget ? selected.read.sha256 : undefined
      await deleteObsidianVaultFile({ vaultPath: vault, relativePath: deleteTarget, expectedSha256 })
      if (selected?.path === deleteTarget) {
        ++readRequestRef.current
        setSelectedFile(null)
        setDraft('')
        reportFocus(null)
      }
      setDeleteTarget(null)
      await loadFiles(vault)
      toast.success('已删除 Vault 笔记')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法删除笔记')
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, loadFiles, reportFocus])

  const connectVault = useCallback(async (path: string): Promise<void> => {
    await flushPendingSave()
    ++readRequestRef.current
    setSelectedFile(null)
    setDraft('')
    setEntries(null)
    setVaultPath(path)
    setSwitcherOpen(false)
  }, [flushPendingSave])

  const createManaged = useCallback(async (): Promise<void> => {
    try {
      const next = await createObsidianManagedVault()
      setConfig(next)
      await connectVault(next.candidates.find((candidate) => candidate.isManaged)?.path ?? next.candidates[0]?.path ?? '')
      toast.success('已创建 Lume Vault')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法创建 Lume Vault')
    }
  }, [connectVault])

  const addLocalFolder = useCallback(async (): Promise<void> => {
    try {
      const { path } = await openFolderDialog()
      if (!path) return
      const next = await addObsidianFolderVault(path)
      setConfig(next)
      await connectVault(path)
      toast.success('已添加 Vault 文件夹')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法添加文件夹')
    }
  }, [connectVault])

  const startTreeResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = treeWidthRef.current
    const maxWidth = Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, window.innerWidth - 320))
    const onMove = (moveEvent: PointerEvent): void => {
      setTreeWidth(Math.min(maxWidth, Math.max(TREE_MIN_WIDTH, startWidth + moveEvent.clientX - startX)))
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
  }, [])

  if (config && (!config.enabled || vaults.length === 0)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-foreground/70">
          {config.enabled ? '未发现 Obsidian Vault' : 'Obsidian Vault 集成已关闭'}
        </p>
        <p className="text-[11px] text-foreground/50">在「设置 → 集成」中开启集成、添加文件夹或创建 Lume Vault。</p>
      </div>
    )
  }

  const treeRows: Array<{ node: VaultTreeNode; depth: number }> = []
  const collectRows = (nodes: VaultTreeNode[], depth: number): void => {
    for (const node of nodes) {
      treeRows.push({ node, depth })
      if (node.isFolder && visibleFolders.has(node.path)) collectRows(node.children, depth + 1)
    }
  }
  collectRows(tree, 0)

  return (
    <div className="flex h-full min-h-0">
      <aside className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border/60" style={{ width: treeWidth }}>
        <div className="flex h-9 items-center gap-1 border-b border-border/60 px-2">
          <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium text-foreground/80" title={activeVault?.path}>
            {activeVault?.displayName ?? '选择 Vault'}
          </span>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="size-6" aria-label={treeAction.type === 'expand' ? '全部折叠文件树' : '全部展开文件树'}
              onClick={() => setTreeAction((current) => ({ type: current.type === 'expand' ? 'collapse' : 'expand', version: current.version + 1 }))} />}>
              <ChevronsUpDown size={13} />
            </TooltipTrigger>
            <TooltipContent>{treeAction.type === 'expand' ? '全部折叠' : '全部展开'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="size-6" aria-label="新建笔记" title="在收件夹新建笔记" onClick={() => void createNote()} />}>
              <FilePlus size={13} />
            </TooltipTrigger>
            <TooltipContent>新建笔记（{INBOX_FOLDER}）</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {entries === null
            ? <div className="flex items-center justify-center py-6 text-foreground/45"><Loader2 className="size-4 animate-spin" /></div>
            : treeRows.length === 0
              ? <p className="px-2 py-3 text-[11px] text-foreground/45">没有可显示的 Markdown 笔记</p>
              : treeRows.map(({ node, depth }) => node.isFolder ? (
                <ContextMenu key={node.path}>
                  <ContextMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-expanded={visibleFolders.has(node.path)}
                        onClick={() => toggleFolder(node.path)}
                        className="relative flex w-full items-center gap-1 rounded py-[3px] pr-1.5 text-left text-[12px] text-foreground/75 hover:bg-[var(--lume-bg-elevated)]"
                        style={{ paddingLeft: 6 + depth * 12 }}
                        title={node.path}
                      >
                        <IndentationGuides depth={depth} />
                        <ChevronGlyph expanded={visibleFolders.has(node.path)} />
                        {visibleFolders.has(node.path) ? <FolderOpen size={13} className="shrink-0 text-foreground/50" /> : <Folder size={13} className="shrink-0 text-foreground/50" />}
                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      </button>
                    }
                  />
                  <ContextMenuContent className="z-[9999] w-40 min-w-0 p-0.5">
                    <ContextMenuItem onSelect={() => void createNote(node.path)}>新建笔记</ContextMenuItem>
                    <ContextMenuItem onSelect={() => { setNewFolderParent(node.path); setNewFolderName('') }}>新建文件夹</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ) : (
                <div
                  key={node.path}
                  className={cn(
                    'group relative flex w-full items-center gap-1 rounded py-[3px] pr-1 text-[12px] hover:bg-[var(--lume-bg-elevated)]',
                    selectedFile?.path === node.path ? 'bg-[var(--lume-bg-elevated)] text-foreground' : 'text-foreground/75',
                  )}
                  style={{ paddingLeft: 6 + depth * 12 }}
                >
                  <IndentationGuides depth={depth} />
                  <button
                    type="button"
                    title={node.path}
                    onClick={() => void openFile(node.path)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  >
                    <span className="w-3 shrink-0" />
                    <FileTypeIcon filename={node.name} size={13} />
                    <span className="min-w-0 flex-1 truncate">{displayDocumentTitle(node.name)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除笔记 ${displayDocumentTitle(node.name)}`}
                    onClick={() => setDeleteTarget(node.path)}
                    className="shrink-0 rounded p-0.5 text-foreground/40 opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
        </div>
        <Popover
          open={switcherOpen}
          onOpenChange={(open) => {
            setSwitcherOpen(open)
            // 每次打开时刷新候选：运行中新建 Obsidian vault / 设置里刚添加的文件夹即时可见。
            if (open) { void getObsidianVaultConfig().then(setConfig).catch(() => undefined) }
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="切换 Vault"
                className="flex min-h-8 w-full items-center gap-2 border-t border-border/60 px-2 py-1.5 text-left text-[11px] text-foreground/55 hover:bg-[var(--lume-bg-elevated)]"
              >
                <ChevronsUpDown size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{activeVault?.displayName ?? '选择 Vault'}</span>
              </button>
            }
          />
          <PopoverContent side="top" align="start" className="w-64 p-1.5">
            <p className="px-2 py-1 text-[11px] font-medium text-foreground/55">Vault</p>
            <div className="max-h-56 overflow-y-auto">
              {vaults.map((vault) => (
                <button
                  key={vault.path}
                  type="button"
                  onClick={() => { void connectVault(vault.path) }}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-[var(--lume-bg-elevated)]',
                    vault.path === vaultPath && 'bg-[var(--lume-bg-elevated)]',
                  )}
                >
                  <ObsidianIcon size={13} className="shrink-0 text-foreground/50" />
                  <span className="min-w-0 flex-1 truncate">{vault.displayName}</span>
                  {vault.isManaged && <span className="shrink-0 text-[10px] text-foreground/45">Lume 自建</span>}
                </button>
              ))}
            </div>
            <div className="mt-1 border-t border-border/60 pt-1">
              <button type="button" onClick={() => void createManaged()} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-[var(--lume-bg-elevated)]">
                <Plus size={13} className="shrink-0 text-foreground/50" />创建 Lume Vault
              </button>
              <button type="button" onClick={() => void addLocalFolder()} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-[var(--lume-bg-elevated)]">
                <FolderOpen size={13} className="shrink-0 text-foreground/50" />打开本地仓库
              </button>
            </div>
          </PopoverContent>
        </Popover>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文件树宽度"
          onPointerDown={startTreeResize}
          className="absolute bottom-0 right-0 top-0 z-10 w-2 translate-x-1/2 cursor-col-resize"
        />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedFile ? (
          <div
            ref={editorPaneRef}
            onWheel={handleEditorPageWheel}
            className="vault-note-editor flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <div className="vault-note-editor-titlebar flex min-w-0 items-center gap-2 pt-3">
              <input
                aria-label="重命名笔记"
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onBlur={() => { void submitRename() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    setRenameName(displayDocumentTitle(selectedFile.path.split('/').pop() ?? selectedFile.path))
                    event.currentTarget.blur()
                  }
                }}
                className="h-8 min-w-0 flex-1 bg-transparent px-0 text-[17px] font-semibold leading-tight text-foreground outline-none"
              />
              {conflict && (
                <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px] text-amber-600 dark:text-amber-400" onClick={() => void openFile(selectedFile.path)}>
                  <RotateCcw size={12} />重新加载
                </Button>
              )}
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="size-7" aria-label="Vault 使用帮助" onClick={() => setHelpOpen(true)} />}>
                  <CircleHelp size={14} />
                </TooltipTrigger>
                <TooltipContent>使用帮助（自动保存；Cmd/Ctrl + S 立即保存）</TooltipContent>
              </Tooltip>
            </div>
            <div className="min-h-0 flex-1">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-[11px] text-foreground/45">
                  <Loader2 className="size-3.5 animate-spin" />正在加载笔记
                </div>
              ) : (
                <VaultLiveMarkdownEditor
                  key={`${selectedFile.path}:${editorReopenVersion}`}
                  vaultPath={vaultPath ?? ''}
                  relativePath={selectedFile.path}
                  value={draft}
                  onChange={setDraft}
                  onSave={() => { void saveDraft() }}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-foreground/45">
            从左侧选择一篇笔记；在会话中打开的笔记会作为 Vault 焦点提供给 Agent
          </div>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="删除 Vault 笔记？"
        description={deleteTarget ? `“${deleteTarget}”将从 Vault 中永久删除，此操作无法撤销。` : ''}
        confirmLabel="删除"
        onConfirm={() => void submitDelete()}
      />
      <Dialog open={newFolderParent !== null} onOpenChange={(open) => { if (!open) setNewFolderParent(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>在{newFolderParent ? ` ${newFolderParent}` : ' Vault 根目录'}中创建文件夹。</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createFolder() }}
            placeholder="文件夹名称"
            aria-label="文件夹名称"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setNewFolderParent(null)}>取消</Button>
            <Button size="sm" disabled={!newFolderName.trim()} onClick={() => void createFolder()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>在 Lume 中使用 Obsidian Vault</DialogTitle>
            <DialogDescription>Lume 直接读写本机已授权的 Markdown Vault；这些笔记也会继续保留在 Obsidian 中。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-[13px] leading-6 text-foreground/70">
            <section>
              <p className="font-medium text-foreground">切换与管理 Vault</p>
              <p>点击左下角 Vault 名称可切换已发现的 Vault、创建 Lume Vault 或打开本地仓库。</p>
            </section>
            <section>
              <p className="font-medium text-foreground">浏览与新建笔记</p>
              <p>点击文件夹展开或收起；顶部按钮一键展开/折叠全部，拖动分隔线调整文件树宽度。右键文件夹可在该目录新建笔记或文件夹。</p>
            </section>
            <section>
              <p className="font-medium text-foreground">编辑与自动保存</p>
              <p>输入停止 700ms 后自动保存；Cmd/Ctrl + S 立即保存。直接编辑标题并按 Enter 或移开焦点即可重命名。</p>
            </section>
            <section>
              <p className="font-medium text-foreground">Agent 协作</p>
              <p>会话中打开的笔记会作为 Vault 焦点提供给 Agent；回复后可通过上下文 chip 跳回笔记。</p>
            </section>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={() => setHelpOpen(false)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ChevronGlyph({ expanded }: { expanded: boolean }): React.ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={cn('shrink-0 text-foreground/40 transition-transform', expanded && 'rotate-90')}
      aria-hidden="true"
    >
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 缩进参考线：与各级父文件夹的箭头中心对齐（Proma 树的同款装饰）。 */
function IndentationGuides({ depth }: { depth: number }): React.ReactElement {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-border/50"
          style={{ left: 11 + level * 12 }}
        />
      ))}
    </>
  )
}
