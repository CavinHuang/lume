import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { toast } from 'sonner'
import { useAtom } from 'jotai'
import { type Tab } from '@/atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms'
import { sidecarCall, readTextFile } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import type { FileLinkContext, FileLinkSource } from '@/components/agent/file-link-types'
import { AGENT_IPC_CHANNELS, type FileEntry } from '@lume/shared'
import { normalizeDirectoryEntriesResponse } from '@/components/file-browser/FileBrowser'
import { buildFileTab, upsertTab } from './file-tabs'

interface FilePreviewTabViewProps {
  tab: Tab
}

interface PreviewPayload {
  content: string
  truncated: boolean
}

export function FilePreviewTabView({ tab }: FilePreviewTabViewProps) {
  const [, setTabs] = useAtom(tabsAtom)
  const [, setActiveTabId] = useAtom(activeTabIdAtom)
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enhancedView, setEnhancedView] = useState(true)
  const [treeCollapsed, setTreeCollapsed] = useState(tab.fileSource === 'local')
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const menuRef = useRef<HTMLDivElement | null>(null)

  const filePath = tab.filePath ?? ''
  const canShowTree = tab.fileSource !== 'local'
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(filePath)
  const breadcrumb = useMemo(() => buildBreadcrumb(tab), [tab])
  const openFileInTab = useCallback((nextPath: string) => {
    const nextTab = buildFileTab({
      filePath: nextPath,
      fileSource: tab.fileSource ?? 'workspace',
      ...(tab.workspaceSlug ? { workspaceSlug: tab.workspaceSlug } : {}),
      ...(tab.threadId ? { threadId: tab.threadId } : {}),
      ...(tab.sourcePath ? { sourcePath: tab.sourcePath } : {}),
    })
    setTabs((prev) => upsertTab(prev, nextTab))
    setActiveTabId(nextTab.id)
  }, [setActiveTabId, setTabs, tab.fileSource, tab.sourcePath, tab.threadId, tab.workspaceSlug])

  const loadPreview = useCallback(async () => {
    if (!filePath) return

    setLoading(true)
    setError(null)
    try {
      let result: PreviewPayload
      if (tab.fileSource === 'local') {
        const sourcePath = tab.sourcePath
        if (!sourcePath) throw new Error('本地文件路径缺失')
        result = await readTextFile(sourcePath)
      } else if (tab.fileSource === 'workspace') {
        if (!tab.workspaceSlug) throw new Error('工作区信息缺失')
        result = await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE, {
          workspaceSlug: tab.workspaceSlug,
          path: filePath,
        })
      } else {
        if (!tab.threadId) throw new Error('线程信息缺失')
        result = await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_FILE, {
          ...(tab.workspaceSlug ? { workspaceSlug: tab.workspaceSlug } : {}),
          threadId: tab.threadId,
          path: filePath,
        })
      }

      setContent(result.content)
      setTruncated(result.truncated)
    } catch (nextError) {
      console.error('[FilePreviewTabView] 加载文件内容失败:', nextError)
      setError(nextError instanceof Error ? nextError.message : '加载文件内容失败')
      setContent('')
      setTruncated(false)
    } finally {
      setLoading(false)
    }
  }, [filePath, tab.fileSource, tab.sourcePath, tab.threadId, tab.workspaceSlug])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen])

  const handleOpenExternal = useCallback(async () => {
    try {
      if (tab.fileSource === 'workspace') {
        if (!tab.workspaceSlug) return
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
          workspaceSlug: tab.workspaceSlug,
          path: filePath,
        })
      } else if (tab.fileSource === 'thread') {
        if (!tab.threadId) return
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_FILE, {
          ...(tab.workspaceSlug ? { workspaceSlug: tab.workspaceSlug } : {}),
          threadId: tab.threadId,
          path: filePath,
        })
      } else {
        toast.message('本地文件已在当前页预览')
      }
    } catch (nextError) {
      console.error('[FilePreviewTabView] 用系统应用打开文件失败:', nextError)
      toast.error('打开文件失败')
    }
  }, [filePath, tab.fileSource, tab.threadId, tab.workspaceSlug])

  const fileCtx = useMemo<FileLinkContext>(() => {
    const source: FileLinkSource = (tab.fileSource ?? 'workspace') as FileLinkSource
    const relPath = source === 'local' ? (tab.sourcePath ?? filePath) : filePath
    return { source, relPath, threadId: tab.threadId, workspaceSlug: tab.workspaceSlug }
  }, [filePath, tab.fileSource, tab.sourcePath, tab.threadId, tab.workspaceSlug])

  return (
    <div className="flex min-h-0 flex-1 bg-[#171717] text-white">
      <FileLinkContextMenu context={fileCtx}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-16 items-center justify-between border-b border-white/8 px-6">
          <div className="flex min-w-0 items-center gap-2 text-[15px] text-white/72">
            {breadcrumb.map((segment, index) => (
              <div key={`${segment}-${index}`} className="flex min-w-0 items-center gap-2">
                {index > 0 && <ChevronRight size={16} className="shrink-0 text-white/28" />}
                <span className={cn('truncate', index === breadcrumb.length - 1 && 'font-medium text-white')}>
                  {segment}
                </span>
              </div>
            ))}
          </div>
          <div className="relative flex items-center gap-2" ref={menuRef}>
            {canShowTree && (
              <button
                type="button"
                onClick={() => setTreeCollapsed((value) => !value)}
                className="flex size-10 items-center justify-center rounded-[14px] text-white/72 transition-colors hover:bg-white/7 hover:text-white"
                title={treeCollapsed ? '展开文件树' : '收起文件树'}
              >
                {treeCollapsed ? <PanelRightOpen size={19} /> : <PanelRightClose size={19} />}
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenExternal}
              className="flex size-10 items-center justify-center rounded-[14px] text-white/72 transition-colors hover:bg-white/7 hover:text-white"
              title="用系统应用打开"
            >
              <ExternalLink size={19} />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              className="flex size-10 items-center justify-center rounded-[14px] text-white/72 transition-colors hover:bg-white/7 hover:text-white"
              title="更多"
            >
              <MoreHorizontal size={19} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-[calc(100%+10px)] z-20 w-64 rounded-[22px] border border-white/8 bg-[#2a2a2a] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
                <button
                  type="button"
                  onClick={() => {
                    setEnhancedView((value) => !value)
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left text-[16px] text-white/92 transition-colors hover:bg-white/6"
                >
                  <Braces size={20} className="text-white/72" />
                  {enhancedView ? '禁用增强视图' : '启用增强视图'}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto px-10 py-8">
            {loading ? (
              <PreviewState label="正在加载文件..." />
            ) : error ? (
              <PreviewState label={error} tone="danger" />
            ) : (
              <div className="mx-auto w-full max-w-[920px]">
                <h1 className="mb-4 text-[58px] leading-[1.02] font-semibold tracking-normal text-white">
                  {tab.title}
                </h1>
                {truncated && (
                  <div className="mb-5 rounded-[14px] border border-amber-400/18 bg-amber-300/8 px-4 py-3 text-[13px] text-amber-100/92">
                    文件内容过长，当前仅显示前 512 KB。
                  </div>
                )}
                {enhancedView && isMarkdown ? (
                  <XMarkdown
                    className="x-markdown text-[15px] leading-8 text-white/90"
                    rootClassName="x-markdown-dark"
                  >
                    {content}
                  </XMarkdown>
                ) : (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] bg-white/[0.04] px-5 py-4 font-mono text-[14px] leading-7 text-white/88">
                    {content}
                  </pre>
                )}
              </div>
            )}
          </div>

          {canShowTree && !treeCollapsed && (
            <FileTreeSidebar
              tab={tab}
              selectedPath={filePath}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onOpenFile={openFileInTab}
            />
          )}
        </div>
        </div>
      </FileLinkContextMenu>
    </div>
  )
}

function PreviewState({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'danger' }) {
  return (
    <div className={cn(
      'flex min-h-[240px] items-center justify-center rounded-[20px] border px-6 text-center text-[14px]',
      tone === 'danger'
        ? 'border-red-400/15 bg-red-400/6 text-red-100/88'
        : 'border-white/8 bg-white/[0.03] text-white/58',
    )}>
      {label}
    </div>
  )
}

function FileTreeSidebar({
  tab,
  selectedPath,
  searchQuery,
  onSearchQueryChange,
  onOpenFile,
}: {
  tab: Tab
  selectedPath: string
  searchQuery: string
  onSearchQueryChange: (next: string) => void
  onOpenFile: (path: string) => void
}) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const refreshTick = 0

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      if (tab.fileSource === 'workspace' && tab.workspaceSlug) {
        const result = await sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY, {
          workspaceSlug: tab.workspaceSlug,
        })
        setEntries(normalizeDirectoryEntriesResponse(result))
      } else if (tab.fileSource === 'thread' && tab.threadId) {
        const result = await sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_DIRECTORY, {
          ...(tab.workspaceSlug ? { workspaceSlug: tab.workspaceSlug } : {}),
          threadId: tab.threadId,
        })
        setEntries(normalizeDirectoryEntriesResponse(result))
      }
    } catch (error) {
      console.error('[FilePreviewTabView] 加载文件树失败:', error)
    } finally {
      setLoading(false)
    }
  }, [tab.fileSource, tab.threadId, tab.workspaceSlug])

  useEffect(() => {
    void loadRoot()
  }, [loadRoot, refreshTick])

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/8 bg-[#151515]">
      <div className="px-4 pb-3 pt-4">
        <label className="flex h-11 items-center gap-3 rounded-[16px] border border-white/10 bg-white/[0.03] px-4 text-white/56">
          <Search size={17} />
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="筛选文件..."
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-white/34"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {entries.map((entry) => (
          <PreviewTreeItem
            key={entry.path}
            entry={entry}
            tab={tab}
            depth={0}
            parentRefreshTick={refreshTick}
            selectedPath={selectedPath}
            searchQuery={searchQuery}
            onOpenFile={onOpenFile}
          />
        ))}
        {!loading && entries.length === 0 && (
          <div className="px-4 py-8 text-center text-[13px] text-white/32">暂无文件</div>
        )}
      </div>
    </aside>
  )
}

function PreviewTreeItem({
  entry,
  tab,
  depth,
  parentRefreshTick,
  selectedPath,
  searchQuery,
  onOpenFile,
}: {
  entry: FileEntry
  tab: Tab
  depth: number
  parentRefreshTick: number
  selectedPath: string
  searchQuery: string
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 2)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [childrenLoaded, setChildrenLoaded] = useState(false)

  useEffect(() => {
    setOpen(depth < 2)
    setChildren([])
    setChildrenLoaded(false)
  }, [depth, parentRefreshTick])

  const matches = searchQuery.trim().length === 0 || entry.name.toLowerCase().includes(searchQuery.trim().toLowerCase())

  const loadChildren = useCallback(async () => {
    if (!entry.isDirectory) return
    if (childrenLoaded) return

    try {
      if (tab.fileSource === 'workspace' && tab.workspaceSlug) {
        const result = await sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY, {
          workspaceSlug: tab.workspaceSlug,
          path: entry.path,
        })
        setChildren(normalizeDirectoryEntriesResponse(result))
      } else if (tab.fileSource === 'thread' && tab.threadId) {
        const result = await sidecarCall<{ entries: FileEntry[] }>(AGENT_IPC_CHANNELS.LIST_DIRECTORY, {
          ...(tab.workspaceSlug ? { workspaceSlug: tab.workspaceSlug } : {}),
          threadId: tab.threadId,
          path: entry.path,
        })
        setChildren(normalizeDirectoryEntriesResponse(result))
      }
      setChildrenLoaded(true)
    } catch (error) {
      console.error('[FilePreviewTabView] 加载子目录失败:', error)
    }
  }, [childrenLoaded, entry.isDirectory, entry.path, tab.fileSource, tab.threadId, tab.workspaceSlug])

  useEffect(() => {
    if (searchQuery.trim() && entry.isDirectory && !childrenLoaded) {
      void loadChildren()
    }
  }, [childrenLoaded, entry.isDirectory, loadChildren, searchQuery])

  const visibleChildren = useMemo(
    () => children.filter((child) => shouldShowEntry(child, searchQuery)),
    [children, searchQuery],
  )
  const visible = matches || visibleChildren.length > 0

  if (!visible) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (!entry.isDirectory) {
            onOpenFile(entry.path)
            return
          }
          if (!open && !childrenLoaded) {
            void loadChildren()
          }
          setOpen((value) => !value)
        }}
        className={cn(
          'flex h-11 w-full items-center gap-2 rounded-[14px] px-3 text-left text-[15px] text-white/78 transition-colors hover:bg-white/[0.05]',
          !entry.isDirectory && selectedPath === entry.path && 'bg-white/[0.08] text-white',
        )}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        {entry.isDirectory ? (
          <ChevronRight size={16} className={cn('shrink-0 text-white/42 transition-transform', open && 'rotate-90')} />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {entry.isDirectory
          ? (open ? <FolderOpen size={16} className="shrink-0 text-white/56" /> : <Folder size={16} className="shrink-0 text-white/56" />)
          : <FileTypeIcon filename={entry.name} size={16} />
        }
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      {entry.isDirectory && open && visibleChildren.map((child) => (
        <PreviewTreeItem
          key={child.path}
          entry={child}
          tab={tab}
          depth={depth + 1}
          parentRefreshTick={parentRefreshTick}
          selectedPath={selectedPath}
          searchQuery={searchQuery}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  )
}

function shouldShowEntry(entry: FileEntry, searchQuery: string): boolean {
  const query = searchQuery.trim().toLowerCase()
  if (!query) return true
  if (entry.name.toLowerCase().includes(query)) return true
  return Array.isArray(entry.children) && entry.children.some((child) => shouldShowEntry(child, query))
}

function buildBreadcrumb(tab: Tab): string[] {
  if (!tab.filePath) return ['Lume']
  const segments = tab.filePath.split('/').filter(Boolean)
  return ['Lume', ...segments]
}
