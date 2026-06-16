import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
import { cn } from '@/lib/utils'
import type { FilesTabState } from './right-panel-state'

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
  const menuRef = useRef<HTMLDivElement | null>(null)
  const selectedPath = state.selectedPath
  const source: FilesSource = state.source === 'workspace' && workspaceSlug ? 'workspace' : 'thread'
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(selectedPath ?? '')

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

    setLoading(true)
    setError(null)
    try {
      const result = source === 'workspace'
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
          <button
            type="button"
            onClick={() => update({ treeVisible: !state.treeVisible })}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title={state.treeVisible ? '收起文件树' : '展开文件树'}
          >
            {state.treeVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <button
            type="button"
            disabled={!selectedPath}
            onClick={openSelectedFile}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            title="用系统应用打开"
          >
            <ExternalLink size={16} />
          </button>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex size-8 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title="更多"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-56 rounded-[10px] border border-border/80 bg-background/98 p-2 shadow-[0_18px_55px_rgba(0,0,0,0.16)] backdrop-blur">
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

      <div className="flex min-h-0 flex-1">
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
              {state.enhancedView && isMarkdown ? (
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

        {state.treeVisible && (
          <aside className="flex w-[320px] shrink-0 flex-col border-l border-border/60 bg-background">
            <div className="border-b border-border/60 px-3 py-3">
              {workspaceSlug && (
                <div className="mb-2 grid grid-cols-2 rounded-[8px] bg-foreground/[0.04] p-1">
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
                <input
                  value={state.searchQuery}
                  onChange={(event) => update({ searchQuery: event.target.value })}
                  placeholder="筛选文件..."
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/38"
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
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
    >
      <span className="text-foreground/58">{icon}</span>
      <span>{children}</span>
    </button>
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
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 rounded-[6px] text-[12px] font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-foreground/52 hover:text-foreground',
      )}
    >
      {children}
    </button>
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
