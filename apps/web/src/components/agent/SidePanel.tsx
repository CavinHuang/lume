import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, MoreHorizontal, Search } from 'lucide-react'
import { useAtom } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'
import { TaskProgressPanel } from './TaskProgressPanel'
import { TracePanel } from './TracePanel'
import { SourceCodePreview } from './SourceCodePreview'
import { cn } from '@/lib/utils'
import { agentFileTreeOpenAtom, type SidePanelView } from '@/atoms'
import { sidecarCall, writeClipboardText } from '@/lib/desktop-api'
import { readMemory } from '@/lib/desktop-api/memory'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
type FileTab = 'thread' | 'workspace' | 'memory'
type PanelTabView = Exclude<SidePanelView, null>

const MIN_SIDE_PANEL_WIDTH = 360
const MAX_SIDE_PANEL_WIDTH = 1280
const DEFAULT_SIDE_PANEL_WIDTH = 1040
const SIDE_PANEL_WIDTH_STORAGE_KEY = 'lume-agent-side-panel-width'

interface SidePanelProps {
  threadId: string
  view: SidePanelView
  open?: boolean
  workspaceSlug?: string
  threadFilePathToPreview?: string
  threadFilePreviewKey?: number
  memoryFilePathToPreview?: string
  memoryFilePreviewKey?: number
}

interface PreviewPayload {
  content: string
  truncated: boolean
}

export function SidePanel({
  threadId,
  view,
  open = true,
  workspaceSlug,
  threadFilePathToPreview,
  threadFilePreviewKey,
  memoryFilePathToPreview,
  memoryFilePreviewKey,
}: SidePanelProps) {
  const [fileTreeOpenByThread, setFileTreeOpenByThread] = useAtom(agentFileTreeOpenAtom)
  const refreshToken = 0
  const [fileTab, setFileTab] = useState<FileTab>('thread')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewTruncated, setPreviewTruncated] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const fileTreeOpen = fileTreeOpenByThread[threadId] ?? false
  const initialPanelView = (view ?? 'files') as PanelTabView
  const [activePanelView, setActivePanelView] = useState<PanelTabView>(initialPanelView)
  const [sidePanelWidth, setSidePanelWidth] = useState(() => readStoredPanelWidth(
    SIDE_PANEL_WIDTH_STORAGE_KEY,
    DEFAULT_SIDE_PANEL_WIDTH,
    MIN_SIDE_PANEL_WIDTH,
  ))
  const [enhancedView, setEnhancedView] = useState(true)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const activeSourceLabel = fileTab === 'thread' ? '线程文件' : fileTab === 'workspace' ? '工作区共享' : '记忆文件'
  const breadcrumb = useMemo(() => buildBreadcrumb(activeSourceLabel, selectedPath), [activeSourceLabel, selectedPath])
  const selectedIsMarkdown = selectedPath ? /\.(md|mdx|markdown)$/i.test(selectedPath) : false

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
    if (threadFilePathToPreview && fileTab === 'thread') return
    if (memoryFilePathToPreview && fileTab === 'memory') return
    setSelectedPath(null)
    setPreviewContent('')
    setPreviewError(null)
    setPreviewTruncated(false)
    setSearchQuery('')
  }, [fileTab, threadId, workspaceSlug, threadFilePathToPreview, memoryFilePathToPreview])

  useEffect(() => {
    if (!view) return
    setActivePanelView(view)
  }, [view])

  useEffect(() => {
    if (!threadFilePathToPreview) return
    setFileTab('thread')
    setSelectedPath(threadFilePathToPreview)
    setPreviewError(null)
    setPreviewTruncated(false)
    setSearchQuery('')
  }, [threadFilePathToPreview, threadFilePreviewKey, threadId])

  useEffect(() => {
    if (!memoryFilePathToPreview) return
    setFileTab('memory')
    setSelectedPath(memoryFilePathToPreview)
    setPreviewError(null)
    setPreviewTruncated(false)
    setSearchQuery('')
    setFileTreeOpenByThread((prev) => ({ ...prev, [threadId]: false }))
  }, [memoryFilePathToPreview, memoryFilePreviewKey, setFileTreeOpenByThread, threadId])

  useEffect(() => {
    writeStoredPanelWidth(SIDE_PANEL_WIDTH_STORAGE_KEY, sidePanelWidth)
  }, [sidePanelWidth])

  useEffect(() => {
    if (!menuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen])

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
      if (fileTab === 'memory') {
        if (!workspaceSlug) throw new Error('请先选择工作区')
        const memory = await readMemory({
          workspaceSlug,
          path: selectedPath,
        })
        result = {
          content: memory.text,
          truncated: false,
        }
      } else if (fileTab === 'workspace') {
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
      await writeClipboardText(selectedPath)
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

  return (
    <div
      className={cn(
        'relative flex h-full min-w-0 shrink-0 overflow-hidden border-l bg-[var(--background)] text-[var(--text-1)] transition-[width,opacity,transform,border-color] duration-[220ms] ease-out',
        open
          ? 'translate-x-0 border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] opacity-100'
          : 'translate-x-3 border-transparent opacity-0',
      )}
      style={{ width: open ? sidePanelWidth : 0 }}
    >
        <div className="flex h-full shrink-0" style={{ width: sidePanelWidth }}>
          <PanelResizeHandle onPointerDown={(event) => startPanelResize(event, setSidePanelWidth, MIN_SIDE_PANEL_WIDTH)} />
          <div className="flex min-w-0 flex-1 flex-col">

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
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => setMenuOpen((value) => !value)}
                          className="flex size-7 items-center justify-center rounded-md text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-(--text-1)"
                          title="更多操作"
                        >
                          <MoreHorizontal size={16} />
                        </Button>
                        {menuOpen && (
                          <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-60 rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-[0_18px_42px_-28px_hsl(var(--shadow-panel)/0.42)] ">
                            <Button
                variant="ghost"
                              type="button"
                              onClick={() => void handleCopyPath()}
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors hover:bg-[var(--surface-2)] justify-start"
                            >
                              {copied ? <Check size={17} className="text-[var(--text-3)]" /> : <Copy size={17} className="text-[var(--text-3)]" />}
                              {copied ? '已复制路径' : '复制路径'}
                            </Button>
                            <Button
                variant="ghost"
                              type="button"
                              onClick={() => {
                                setEnhancedView((value) => !value)
                                setMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors hover:bg-[var(--surface-2)] justify-start "
                            >
                              <span className="text-[16px] text-[var(--text-3)]">{'{}'}</span>
                              {enhancedView ? '禁用增强视图' : '启用增强视图'}
                            </Button>
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
                              <SourceCodePreview content={previewContent} path={selectedPath} />
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

              {activePanelView === 'files' && fileTab !== 'memory' && (
                <aside
                  className={cn(
                    'flex shrink-0 flex-col overflow-hidden bg-[var(--background)] transition-[width,opacity,border-color] duration-200 ease-out',
                    fileTreeOpen
                      ? 'w-[312px] border-l border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] opacity-100'
                      : 'w-0 border-l border-transparent opacity-0 pointer-events-none',
                  )}
                >
                  <div className="flex min-h-0 w-[312px] flex-1 flex-col">
                    <div className="flex shrink-0 items-center px-4 pt-0">
                      <label className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_38%,transparent)] bg-[var(--surface-1)] px-3 text-[var(--text-3)]">
                        <Search size={15} />
                        <Input
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder="筛选文件..."
                          className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)]/70 focus-visible:ring-0"
                        />
                      </label>
                    </div>
                    <div className="shrink-0 px-4 pt-1">
                      <div className="lume-segmented flex items-center gap-1">
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => setFileTab('thread')}
                          className={cn(
                            'lume-segmented-item px-3 text-[12px]',
                            fileTab === 'thread' ? 'lume-segmented-item-active' : '',
                          )}
                        >
                          线程
                        </Button>
                        <Button
                variant="ghost"
                          type="button"
                          onClick={() => setFileTab('workspace')}
                          className={cn(
                            'lume-segmented-item px-3 text-[12px]',
                            fileTab === 'workspace' ? 'lume-segmented-item-active' : '',
                          )}
                        >
                          工作区
                        </Button>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 pt-1">
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
