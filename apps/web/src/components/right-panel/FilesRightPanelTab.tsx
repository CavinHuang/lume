import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import {
  Braces,
  Copy,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'
import { sidecarCall, writeClipboardText } from '@/lib/desktop-api'
import { openMemorySource, readMemory } from '@/lib/desktop-api/memory'
import { cn } from '@/lib/utils'
import { isImageFile, lumeFileUrl } from './file-preview-utils'
import { FILE_TREE_DEFAULT_WIDTH, getRightPanelFileTreeDragWidth } from './right-panel-layout'
import type { FilesTabState } from './right-panel-state'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface FilesRightPanelTabProps {
  state: FilesTabState
  workspaceSlug?: string
  threadId: string
  onChange: (next: FilesTabState) => void
}

interface PreviewPayload {
  content: string
  truncated: boolean
}

type FilesSource = FilesTabState['source']

export function FilesRightPanelTab({
  state,
  workspaceSlug,
  threadId,
  onChange,
}: FilesRightPanelTabProps) {
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [treeResizing, setTreeResizing] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const selectedPath = state.selectedPath
  const source: FilesSource = state.source === 'workspace' && !workspaceSlug ? 'thread' : state.source
  const canShowTree = source !== 'memory'
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(selectedPath ?? '')
  const isImage = isImageFile(selectedPath ?? '')

  const update = useCallback((patch: Partial<FilesTabState>) => {
    onChange({ ...state, ...patch })
  }, [onChange, state])

  const loadPreview = useCallback(async () => {
    if (!selectedPath) {
      setContent('')
      setTruncated(false)
      setError(null)
      return
    }

    if (isImageFile(selectedPath)) {
      setContent('')
      setTruncated(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = source === 'memory'
        ? await (async () => {
          if (!workspaceSlug) throw new Error('工作区信息缺失')
          const memory = await readMemory({ workspaceSlug, path: selectedPath })
          return { content: memory.text, truncated: false }
        })()
        : source === 'workspace'
          ? await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE, {
          workspaceSlug,
          path: selectedPath,
        })
          : await sidecarCall<PreviewPayload>(AGENT_IPC_CHANNELS.READ_FILE, {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          threadId,
          path: selectedPath,
        })

      setContent(result.content)
      setTruncated(result.truncated)
    } catch (nextError) {
      console.error('[FilesRightPanelTab] 加载文件内容失败:', nextError)
      setContent('')
      setTruncated(false)
      setError(nextError instanceof Error ? nextError.message : '加载文件内容失败')
    } finally {
      setLoading(false)
    }
  }, [selectedPath, source, threadId, workspaceSlug])

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

  const openSelectedFile = useCallback(async () => {
    if (!selectedPath) return
    try {
      if (source === 'workspace') {
        if (!workspaceSlug) return
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, { workspaceSlug, path: selectedPath })
      } else if (source === 'memory') {
        if (!workspaceSlug) return
        await openMemorySource({ workspaceSlug, path: selectedPath })
      } else {
        await sidecarCall(AGENT_IPC_CHANNELS.OPEN_FILE, {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          threadId,
          path: selectedPath,
        })
      }
    } catch (nextError) {
      console.error('[FilesRightPanelTab] 用系统应用打开失败:', nextError)
      toast.error('打开文件失败')
    }
  }, [selectedPath, source, threadId, workspaceSlug])

  const copySelectedPath = useCallback(async () => {
    if (!selectedPath) return
    await writeClipboardText(selectedPath)
    setMenuOpen(false)
  }, [selectedPath])

  const copyFileContent = useCallback(async () => {
    if (!selectedPath) return
    await writeClipboardText(content)
    setMenuOpen(false)
  }, [content, selectedPath])

  const breadcrumbs = useMemo(() => {
    if (!selectedPath) return ['/']
    return selectedPath.split('/').filter(Boolean)
  }, [selectedPath])

  const startTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !state.treeVisible || !canShowTree) return
    event.preventDefault()

    const setWidthFromPointer = (clientX: number) => {
      const rect = bodyRef.current?.getBoundingClientRect()
      if (!rect) return

      update({
        treeWidth: getRightPanelFileTreeDragWidth({
          clientX,
          containerRight: rect.right,
          containerWidth: rect.width,
        }),
      })
    }

    const handlePointerMove = (nextEvent: PointerEvent) => {
      setWidthFromPointer(nextEvent.clientX)
    }

    const stopResize = () => {
      setTreeResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    setTreeResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setWidthFromPointer(event.clientX)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-2 text-[13px] text-foreground/58">
          <FolderOpen size={16} className="shrink-0" />
          {breadcrumbs.map((segment, index) => (
            <span
              key={`${segment}-${index}`}
              className={cn(index === breadcrumbs.length - 1 && 'font-medium text-foreground', 'min-w-0 truncate')}
            >
              {index > 0 ? ` / ${segment}` : segment}
            </span>
          ))}
        </div>

        <div className="relative flex shrink-0 items-center gap-1.5" ref={menuRef}>
          <Button
                variant="ghost"
            type="button"
            disabled={!canShowTree}
            onClick={() => update({ treeVisible: !state.treeVisible })}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            title={state.treeVisible ? '收起文件树' : '展开文件树'}
          >
            {state.treeVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </Button>
          <Button
                variant="ghost"
            type="button"
            disabled={!selectedPath}
            onClick={openSelectedFile}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            title="用系统应用打开"
          >
            <ExternalLink size={16} />
          </Button>
          <Button
                variant="ghost"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title="更多"
          >
            <MoreHorizontal size={16} />
          </Button>
          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-56 rounded-[10px] border border-border/80 bg-background/98 p-2 shadow-[0_18px_55px_-32px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur">
              <MenuButton disabled={!selectedPath} icon={<Copy size={15} />} onClick={copySelectedPath}>
                复制路径
              </MenuButton>
              <MenuButton disabled={!selectedPath || loading || Boolean(error)} icon={<Copy size={15} />} onClick={copyFileContent}>
                复制文件内容
              </MenuButton>
              <MenuButton
                icon={<Braces size={15} />}
                onClick={() => {
                  update({ enhancedView: !state.enhancedView })
                  setMenuOpen(false)
                }}
              >
                {state.enhancedView ? '禁用增强视图' : '启用增强视图'}
              </MenuButton>
            </div>
          )}
        </div>
      </div>

      <div
        className={cn('flex min-h-0 flex-1', treeResizing && 'cursor-col-resize select-none')}
        ref={bodyRef}
      >
        <div className="min-w-0 flex-1 overflow-auto px-7 py-6">
          {!selectedPath ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-foreground/45">
              <FolderOpen size={28} />
              <div className="text-[15px] font-medium text-foreground/75">打开文件</div>
              <div className="text-[13px]">从文件树中选择文件</div>
            </div>
          ) : loading ? (
            <PreviewState label="正在加载文件..." />
          ) : error ? (
            <PreviewState label={error} tone="danger" />
          ) : (
            <div className="mx-auto w-full max-w-[920px]">
              <div className="mb-5 flex items-center gap-2">
                <FileTypeIcon filename={selectedPath} size={18} />
                <h2 className="min-w-0 truncate text-[20px] font-semibold text-foreground">
                  {basename(selectedPath)}
                </h2>
              </div>
              {truncated && (
                <div className="mb-5 rounded-[8px] border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-200">
                  文件内容过长，当前仅显示前 512 KB。
                </div>
              )}
              {isImage ? (
                <img
                  src={lumeFileUrl(selectedPath)}
                  alt={basename(selectedPath)}
                  className="max-h-[72vh] w-auto max-w-full rounded-[8px] border border-border/60 bg-foreground/[0.02] object-contain"
                  onError={(event) => {
                    const img = event.currentTarget
                    img.style.display = 'none'
                    const fallback = document.createElement('div')
                    fallback.className = 'rounded-[8px] border border-border/60 bg-foreground/[0.03] px-4 py-3 text-[13px] text-foreground/55'
                    fallback.textContent = '无法预览此文件'
                    img.parentElement?.appendChild(fallback)
                  }}
                />
              ) : state.enhancedView && isMarkdown ? (
                <XMarkdown className="x-markdown text-[14px] leading-7 text-foreground">
                  {content}
                </XMarkdown>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[8px] bg-foreground/[0.04] px-4 py-3 font-mono text-[13px] leading-6 text-foreground/88">
                  {content}
                </pre>
              )}
            </div>
          )}
        </div>

        {state.treeVisible && canShowTree && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件树宽度"
              title="拖动调整文件树宽度"
              onPointerDown={startTreeResize}
              className={cn(
                'w-2 shrink-0 cursor-col-resize touch-none border-l border-border/60 bg-background transition-colors hover:bg-foreground/10',
                treeResizing && 'bg-foreground/10',
              )}
            />
            <aside
              className="flex shrink-0 flex-col bg-background"
              style={{ width: `clamp(240px, ${state.treeWidth ?? FILE_TREE_DEFAULT_WIDTH}px, min(520px, 55%))` }}
            >
              <div className="border-b border-border/60 px-3 py-3">
                {workspaceSlug && (
                  <div className="lume-segmented mb-2 grid grid-cols-2">
                    <SourceButton active={source === 'thread'} onClick={() => update({ source: 'thread', selectedPath: null })}>
                      线程文件
                    </SourceButton>
                    <SourceButton active={source === 'workspace'} onClick={() => update({ source: 'workspace', selectedPath: null })}>
                      工作区文件
                    </SourceButton>
                  </div>
                )}
                <label className="flex h-9 items-center gap-2 rounded-[8px] border border-border/70 bg-background px-3 text-foreground/52">
                  <Search size={15} />
                  <Input
                    value={state.searchQuery}
                    onChange={(event) => update({ searchQuery: event.target.value })}
                    placeholder="筛选文件..."
                    className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-foreground shadow-none outline-none placeholder:text-foreground/38 focus-visible:ring-0"
                  />
                </label>
              </div>
              <div className="min-h-0 flex-1">
                {source === 'workspace' ? (
                  <WorkspaceFileBrowser
                    workspaceSlug={workspaceSlug}
                    selectedPath={selectedPath ?? undefined}
                    onOpenFile={(path) => update({ selectedPath: path })}
                    showHeader={false}
                    searchQuery={state.searchQuery}
                  />
                ) : (
                  <FileBrowser
                    threadId={threadId}
                    workspaceSlug={workspaceSlug}
                    selectedPath={selectedPath ?? undefined}
                    onOpenFile={(path) => update({ selectedPath: path })}
                    showHeader={false}
                    searchQuery={state.searchQuery}
                  />
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

function MenuButton({
  children,
  disabled,
  icon,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-full items-center justify-start gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
    >
      <span className="text-foreground/58">{icon}</span>
      <span>{children}</span>
    </Button>
  )
}

function SourceButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      onClick={onClick}
      className={cn(
        'lume-segmented-item text-[12px]',
        active ? 'lume-segmented-item-active' : '',
      )}
    >
      {children}
    </Button>
  )
}

function PreviewState({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'danger' }) {
  return (
    <div className={cn(
      'flex min-h-[240px] items-center justify-center rounded-[8px] border px-6 text-center text-[13px]',
      tone === 'danger'
        ? 'border-red-400/18 bg-red-400/6 text-red-700 dark:text-red-200'
        : 'border-border/70 bg-foreground/[0.03] text-foreground/55',
    )}>
      {label}
    </div>
  )
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}
