import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivitySquare, Check, ChevronRight, Copy, ExternalLink, FileText, FolderOpen, ListTodo, MoreHorizontal, PanelRightClose, Plus, Search } from 'lucide-react'
import { useSetAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'
import { TaskProgressPanel } from './TaskProgressPanel'
import { TracePanel } from './TracePanel'
import { cn } from '@/lib/utils'
import { agentSidePanelViewAtom, type SidePanelView } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from 'react'

type FileTab = 'thread' | 'workspace'
type PanelTabView = Exclude<SidePanelView, null>

const MIN_SIDE_PANEL_WIDTH = 360
const MAX_SIDE_PANEL_WIDTH = 1280
const DEFAULT_SIDE_PANEL_WIDTH = 1040
const SIDE_PANEL_WIDTH_STORAGE_KEY = 'lume-agent-side-panel-width'

interface SidePanelProps {
  threadId: string
  view: SidePanelView
  workspaceSlug?: string
}

interface PreviewPayload {
  content: string
  truncated: boolean
}

export function SidePanel({ threadId, view, workspaceSlug }: SidePanelProps) {
  const setSidePanelViews = useSetAtom(agentSidePanelViewAtom)
  const refreshToken = 0
  const [fileTab, setFileTab] = useState<FileTab>('thread')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewTruncated, setPreviewTruncated] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [fileTreeOpen, setFileTreeOpen] = useState(true)
  const initialPanelView = (view ?? 'files') as PanelTabView
  const [panelTabs, setPanelTabs] = useState<PanelTabView[]>(() => [initialPanelView])
  const [activePanelView, setActivePanelView] = useState<PanelTabView>(initialPanelView)
  const [sidePanelWidth, setSidePanelWidth] = useState(() => readStoredPanelWidth(
    SIDE_PANEL_WIDTH_STORAGE_KEY,
    DEFAULT_SIDE_PANEL_WIDTH,
    MIN_SIDE_PANEL_WIDTH,
  ))
  const [enhancedView, setEnhancedView] = useState(true)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const tabMenuRef = useRef<HTMLDivElement | null>(null)

  const activeSourceLabel = fileTab === 'thread' ? '线程文件' : '工作区共享'
  const breadcrumb = useMemo(() => buildBreadcrumb(activeSourceLabel, selectedPath), [activeSourceLabel, selectedPath])
  const selectedIsMarkdown = selectedPath ? /\.(md|mdx|markdown)$/i.test(selectedPath) : false
  const canActOnSelection = Boolean(selectedPath)
  const selectedTitle = selectedPath ? selectedPath.split('/').filter(Boolean).at(-1) ?? selectedPath : activeSourceLabel

  const startPanelResize = useCallback((
    event: ReactPointerEvent,
    setWidth: Dispatch<SetStateAction<number>>,
    minWidth: number,
  ) => {
    event.preventDefault()
    const maxWidth = getMaxPanelWidth()

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setWidth(clamp(window.innerWidth - moveEvent.clientX, minWidth, maxWidth))
    }

    const stopResize = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }, [])

  useEffect(() => {
    setSelectedPath(null)
    setPreviewContent('')
    setPreviewError(null)
    setPreviewTruncated(false)
    setSearchQuery('')
  }, [fileTab, threadId, workspaceSlug])

  useEffect(() => {
    if (!view) return
    setPanelTabs((prev) => (prev.includes(view) ? prev : [...prev, view]))
    setActivePanelView(view)
  }, [view])

  useEffect(() => {
    writeStoredPanelWidth(SIDE_PANEL_WIDTH_STORAGE_KEY, sidePanelWidth)
  }, [sidePanelWidth])

  useEffect(() => {
    if (!menuOpen && !tabMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (tabMenuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
      setTabMenuOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen, tabMenuOpen])

  useEffect(() => () => {
    if (copyResetRef.current !== null) {
      clearTimeout(copyResetRef.current)
    }
  }, [])

  const loadPreview = useCallback(async () => {
    if (!selectedPath) {
      setPreviewContent('')
      setPreviewError(null)
      setPreviewTruncated(false)
      return
    }

    setPreviewLoading(true)
    setPreviewError(null)
    try {
      let result: PreviewPayload
      if (fileTab === 'workspace') {
        if (!workspaceSlug) throw new Error('请先选择工作区')
        result = await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE, {
          workspaceSlug,
          path: selectedPath,
        })
      } else {
        result = await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_FILE, {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          threadId,
          path: selectedPath,
        })
      }
      setPreviewContent(result.content)
      setPreviewTruncated(result.truncated)
    } catch (error) {
      console.error('[SidePanel] 加载预览失败:', error)
      setPreviewContent('')
      setPreviewTruncated(false)
      setPreviewError(error instanceof Error ? error.message : '加载预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }, [fileTab, selectedPath, threadId, workspaceSlug])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const handleCopyPath = useCallback(async () => {
    if (!selectedPath) return
    try {
      await navigator.clipboard.writeText(selectedPath)
      setCopied(true)
      if (copyResetRef.current !== null) {
        clearTimeout(copyResetRef.current)
      }
      copyResetRef.current = setTimeout(() => {
        setCopied(false)
        copyResetRef.current = null
      }, 3000)
    } catch (error) {
      console.error('[SidePanel] 复制路径失败:', error)
    } finally {
      setMenuOpen(false)
    }
  }, [selectedPath])

  const handleOpenExternally = useCallback(async () => {
    if (!selectedPath) return
    try {
      if (fileTab === 'workspace') {
        if (!workspaceSlug) return
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
          workspaceSlug,
          path: selectedPath,
        })
      } else {
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_FILE, {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          threadId,
          path: selectedPath,
        })
      }
    } catch (error) {
      console.error('[SidePanel] 外部打开文件失败:', error)
    }
  }, [fileTab, selectedPath, threadId, workspaceSlug])

  const activatePanelTab = useCallback((nextView: PanelTabView) => {
    setActivePanelView(nextView)
    setSidePanelViews((prev) => ({ ...prev, [threadId]: nextView }))
  }, [setSidePanelViews, threadId])

  const switchPanelView = useCallback((nextView: PanelTabView) => {
    if (nextView === 'files') {
      setFileTreeOpen(true)
    }
    setPanelTabs((prev) => (prev.includes(nextView) ? prev : [...prev, nextView]))
    setActivePanelView(nextView)
    setSidePanelViews((prev) => ({ ...prev, [threadId]: nextView }))
    setTabMenuOpen(false)
  }, [setSidePanelViews, threadId])

  const closeSidePanel = useCallback(() => {
    setSidePanelViews((prev) => ({ ...prev, [threadId]: null }))
  }, [setSidePanelViews, threadId])

  return (
    <div
      className="relative flex h-full min-w-0 shrink-0 border-l border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[var(--background)] text-[var(--text-1)]"
      style={{ width: sidePanelWidth }}
    >
        <div className="flex min-w-0 flex-1">
          <PanelResizeHandle onPointerDown={(event) => startPanelResize(event, setSidePanelWidth, MIN_SIDE_PANEL_WIDTH)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                  {panelTabs.map((panelView) => {
                    const tab = getPanelTabMeta(panelView, selectedTitle)
                    const isActive = activePanelView === panelView
                    return (
                      <button
                        key={panelView}
                        type="button"
                        onClick={() => activatePanelTab(panelView)}
                        className={cn(
                          'flex h-8 min-w-0 max-w-[180px] items-center gap-2 rounded-md px-3 text-[13px] font-medium text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                          isActive && 'border border-[color:color-mix(in_oklab,var(--border-strong)_44%,transparent)] bg-[var(--surface-1)] text-[var(--text-1)]',
                        )}
                      >
                        {panelView === 'files' && !selectedPath
                          ? <span className="shrink-0 text-[14px] leading-none text-[var(--text-3)]">·</span>
                          : <tab.Icon size={14} className="shrink-0 text-[var(--brand-2)]" />
                        }
                        <span className="truncate">{tab.label}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="relative shrink-0" ref={tabMenuRef}>
                  <button
                    type="button"
                    onClick={() => setTabMenuOpen((value) => !value)}
                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                    title="新开面板标签"
                  >
                    <Plus size={15} />
                  </button>
                  {tabMenuOpen && (
                    <PanelTabMenu currentView={activePanelView} switchPanelView={switchPanelView} />
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[var(--text-3)]">
                {activePanelView === 'files' && (
                  <>
                    <button
                      type="button"
                      disabled={!canActOnSelection}
                      onClick={() => void handleOpenExternally()}
                      className={cn(
                        'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                        !canActOnSelection && 'cursor-not-allowed opacity-35 hover:bg-transparent hover:text-[var(--text-3)]',
                      )}
                      title="用系统应用打开"
                    >
                      <ExternalLink size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFileTreeOpen((value) => !value)}
                      className={cn(
                        'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                        fileTreeOpen && 'bg-[var(--surface-2)] text-[var(--text-1)]',
                      )}
                      title={fileTreeOpen ? '收起文件树' : '展开文件树'}
                    >
                      <FolderOpen size={16} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={closeSidePanel}
                  className="flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                  title="收起右侧面板"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
            </div>

            <div className="flex min-w-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                {activePanelView === 'files' ? (
                  <>
                    <div className="flex h-9 shrink-0 items-center justify-between border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3">
                      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-3)]">
                        {breadcrumb.map((segment, index) => (
                          <div key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1.5">
                            {index > 0 && <ChevronRight size={12} className="shrink-0 text-[var(--text-3)]/60" />}
                            <span className={cn('truncate', index === breadcrumb.length - 1 && 'font-semibold text-[var(--text-1)]')}>{segment}</span>
                          </div>
                        ))}
                      </div>

                      <div className="relative flex items-center" ref={menuRef}>
                        <button
                          type="button"
                          onClick={() => setMenuOpen((value) => !value)}
                          className="flex size-7 items-center justify-center rounded-md text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                          title="更多操作"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menuOpen && (
                          <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-60 rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-[0_18px_42px_-28px_hsl(var(--shadow-panel)/0.42)]">
                            <button
                              type="button"
                              onClick={() => void handleCopyPath()}
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors hover:bg-[var(--surface-2)]"
                            >
                              {copied ? <Check size={17} className="text-[var(--text-3)]" /> : <Copy size={17} className="text-[var(--text-3)]" />}
                              {copied ? '已复制路径' : '复制路径'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEnhancedView((value) => !value)
                                setMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors hover:bg-[var(--surface-2)]"
                            >
                              <span className="text-[16px] text-[var(--text-3)]">{'{}'}</span>
                              {enhancedView ? '禁用增强视图' : '启用增强视图'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-auto">
                      <div className="w-full px-5 py-5">
                        <div className="mb-4">
                          <h2 className="text-[24px] font-semibold leading-tight tracking-normal text-[var(--text-1)]">
                            {selectedPath ? selectedPath.split('/').filter(Boolean).at(-1) ?? selectedPath : activeSourceLabel}
                          </h2>
                        </div>

                        {previewLoading ? (
                          <PreviewState text="正在加载文件预览..." />
                        ) : previewError ? (
                          <PreviewState text={previewError} tone="danger" />
                        ) : !selectedPath ? (
                          <PreviewState text="从右侧文件树选择一个文件开始预览。" />
                        ) : (
                          <>
                            {previewTruncated && (
                              <div className="mb-4 rounded-[14px] border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-200">
                                文件过长，当前仅显示前 512 KB 内容。
                              </div>
                            )}
                            {enhancedView && selectedIsMarkdown ? (
                              <XMarkdown
                                className="x-markdown text-[15px] leading-8 text-[var(--text-1)]"
                              >
                                {previewContent}
                              </XMarkdown>
                            ) : (
                              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[var(--surface-1)] px-4 py-3 font-mono text-[13px] leading-6 text-[var(--text-1)]">
                                {previewContent}
                              </pre>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto">
                    {activePanelView === 'task-progress'
                      ? <TaskProgressPanel threadId={threadId} />
                      : <TracePanel threadId={threadId} />
                    }
                  </div>
                )}
              </div>

              {activePanelView === 'files' && fileTreeOpen && (
                <aside className="flex w-[312px] shrink-0 flex-col border-l border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[var(--background)]">
                  <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
                    <label className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_38%,transparent)] bg-[var(--surface-1)] px-3 text-[var(--text-3)]">
                      <Search size={15} />
                      <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="筛选文件..."
                        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]/70"
                      />
                    </label>
                    <button
                      type="button"
                      className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-1)] text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
                      title="添加文件"
                    >
                      +
                    </button>
                  </div>
                  <div className="shrink-0 px-4 pt-3">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--text-3)]">
                      <button
                        type="button"
                        onClick={() => setFileTab('thread')}
                        className={cn(
                          'rounded-full px-3 py-1.5 transition-colors',
                          fileTab === 'thread' ? 'bg-[var(--surface-2)] text-[var(--text-1)]' : 'hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                        )}
                      >
                        线程
                      </button>
                      <button
                        type="button"
                        onClick={() => setFileTab('workspace')}
                        className={cn(
                          'rounded-full px-3 py-1.5 transition-colors',
                          fileTab === 'workspace' ? 'bg-[var(--surface-2)] text-[var(--text-1)]' : 'hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
                        )}
                      >
                        工作区
                      </button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 pt-3">
                    {fileTab === 'thread' ? (
                      <FileBrowser
                        threadId={threadId}
                        workspaceSlug={workspaceSlug}
                        refreshToken={refreshToken}
                        selectedPath={selectedPath ?? undefined}
                        onOpenFile={setSelectedPath}
                        showHeader={false}
                        searchQuery={searchQuery}
                      />
                    ) : (
                      <WorkspaceFileBrowser
                        workspaceSlug={workspaceSlug}
                        refreshToken={refreshToken}
                        selectedPath={selectedPath ?? undefined}
                        onOpenFile={setSelectedPath}
                        showHeader={false}
                        searchQuery={searchQuery}
                      />
                    )}
                  </div>
                </aside>
              )}
            </div>
          </div>
        </div>
    </div>
  )
}

function buildBreadcrumb(rootLabel: string, selectedPath: string | null): string[] {
  if (!selectedPath) return ['Lume', rootLabel]
  return ['Lume', ...selectedPath.split('/').filter(Boolean)]
}

function getPanelTabMeta(view: PanelTabView, fileLabel: string) {
  if (view === 'task-progress') {
    return { label: 'Task', Icon: ListTodo }
  }
  if (view === 'trace') {
    return { label: 'Trace', Icon: ActivitySquare }
  }
  return { label: fileLabel, Icon: FileText }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getMaxPanelWidth(): number {
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(window.innerWidth - 360, MAX_SIDE_PANEL_WIDTH))
}

function readStoredPanelWidth(key: string, fallback: number, minWidth: number): number {
  if (typeof window === 'undefined') return fallback
  const storedValue = window.localStorage.getItem(key)
  if (!storedValue) return fallback

  const parsedValue = Number(storedValue)
  if (!Number.isFinite(parsedValue)) return fallback

  return clamp(parsedValue, minWidth, getMaxPanelWidth())
}

function writeStoredPanelWidth(key: string, width: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, String(Math.round(width)))
}

function PanelResizeHandle({ onPointerDown }: { onPointerDown: (event: ReactPointerEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group absolute inset-y-0 left-0 z-30 w-2 -translate-x-1 cursor-col-resize"
      title="拖动调整右侧栏宽度"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-[var(--brand)]" />
    </div>
  )
}

function PanelTabMenu({
  currentView,
  switchPanelView,
}: {
  currentView: PanelTabView
  switchPanelView: (nextView: PanelTabView) => void
}) {
  const items: Array<{ view: PanelTabView; label: string; icon: ReactNode }> = [
    { view: 'files', label: '文件夹', icon: <FolderOpen size={16} /> },
    { view: 'task-progress', label: 'Task', icon: <ListTodo size={16} /> },
    { view: 'trace', label: 'Trace', icon: <ActivitySquare size={16} /> },
  ]

  return (
    <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-44 rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-[0_18px_42px_-28px_hsl(var(--shadow-panel)/0.42)]">
      {items.map((item) => (
        <button
          key={item.view}
          type="button"
          onClick={() => switchPanelView(item.view)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--surface-2)]',
            currentView === item.view && 'bg-[color:color-mix(in_oklab,var(--brand)_22%,transparent)] text-[var(--brand-2)]',
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}

function PreviewState({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'danger' }) {
  return (
    <div className={cn(
      'flex min-h-[300px] items-center justify-center rounded-lg border px-6 text-center text-[14px]',
      tone === 'danger'
        ? 'border-red-500/20 bg-red-500/7 text-red-700 dark:text-red-200'
        : 'border-[color:color-mix(in_oklab,var(--border-strong)_38%,transparent)] bg-[var(--surface-1)] text-[var(--text-3)]',
    )}>
      {text}
    </div>
  )
}
