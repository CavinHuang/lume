import { useCallback, useMemo, useRef, useState, useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtom } from 'jotai'
import { ChevronDown, Copy, ExternalLink, FolderSearch, MoreHorizontal } from 'lucide-react'
import type { FileEntry, FileRef } from '@lume/shared'
import { rightPanelFileLayoutPreferencesAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { openFileRefInSystem, isDesktopRuntime, revealFileRefInSystem, writeClipboardText } from '@/lib/desktop-api'
import { RightPanelFilePreview } from './RightPanelFilePreview'
import { UnifiedFileTree } from './UnifiedFileTree'
import {
  openFileTab,
  fileRefKey,
  removeFileRef,
  setFilePreviewScope,
  type RightPanelFileTarget,
  type ThreadFileWorkspace,
} from './right-panel-files-state'
import type { RightPanelFunction } from './right-panel-state'
import {
  FILE_TREE_DEFAULT_WIDTH,
  clampRightPanelFileTreeWidth,
  getRightPanelFileTreeDragWidth,
  isWideFileWorkspace,
} from './right-panel-layout'

export function FilesRightPanelWorkspace({
  workspace,
  workspaceSlug,
  workspaceProjectPath,
  fileContextId,
  openFunctions,
  onWorkspaceChange,
}: {
  workspace: ThreadFileWorkspace
  workspaceSlug?: string
  workspaceProjectPath?: string
  fileContextId?: string
  openFunctions: RightPanelFunction[]
  onWorkspaceChange: (workspace: ThreadFileWorkspace | ((current: ThreadFileWorkspace) => ThreadFileWorkspace)) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef(workspace)
  const openFunctionsRef = useRef(openFunctions)
  const [containerWidth, setContainerWidth] = useState(0)
  const [preferences, setPreferences] = useAtom(rightPanelFileLayoutPreferencesAtom)
  const [resizing, setResizing] = useState(false)
  const wide = isWideFileWorkspace(containerWidth)
  const treeCollapsed = wide && preferences.treeCollapsed === true
  const activeFileTabId = workspace.activeItem?.kind === 'file' ? workspace.activeItem.tabId : null
  const activeTab = activeFileTabId
    ? workspace.openTabs.find((tab) => tab.id === activeFileTabId)
    : undefined
  const previewRef = activeTab?.ref ?? (wide ? workspace.temporaryPreviewRef : null)
  const showTree = !treeCollapsed && (wide || workspace.activeItem?.kind !== 'file')
  const treeWidth = useMemo(
    () => clampRightPanelFileTreeWidth(preferences.treeWidth ?? FILE_TREE_DEFAULT_WIDTH, Math.max(containerWidth, 680)),
    [containerWidth, preferences.treeWidth],
  )
  const selectedEntry = workspace.selectedRef
    ? findCachedEntry(workspace.directoryCache as Record<string, FileEntry[]>, workspace.selectedRef)
    : undefined
  workspaceRef.current = workspace
  openFunctionsRef.current = openFunctions

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry?.contentRect.width ?? 0))
    observer.observe(element)
    setContainerWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  const openFile = useCallback((ref: RightPanelFileTarget) => onWorkspaceChange(openFileTab(workspaceRef.current, ref, {
    caseInsensitive: /Win/i.test(navigator.platform),
  })), [onWorkspaceChange])
  const handleMissing = useCallback((ref: FileRef) => {
    onWorkspaceChange(removeFileRef(workspaceRef.current, ref, false, openFunctionsRef.current))
  }, [onWorkspaceChange])
  const previewScopeKey = activeTab?.id ?? (previewRef ? `temporary:${fileRefKey(previewRef)}` : 'temporary')
  const handlePreviewScopeChange = useCallback((token: string | null) => {
    onWorkspaceChange((current) => setFilePreviewScope(current, previewScopeKey, token))
  }, [onWorkspaceChange, previewScopeKey])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !wide) return
    event.preventDefault()
    const move = (next: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      setPreferences((current) => ({
        ...current,
        treeWidth: getRightPanelFileTreeDragWidth({ clientX: next.clientX, containerLeft: rect.left, containerWidth: rect.width }),
      }))
    }
    const stop = () => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    setResizing(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <div ref={containerRef} className={cn('flex min-h-0 flex-1 overflow-hidden', resizing && 'select-none cursor-col-resize')}>
      <div
        className={cn('relative min-h-0 shrink-0 border-r border-border/60', !showTree && 'hidden')}
        style={{ width: wide ? treeWidth : '100%' }}
      >
        <UnifiedFileTree
          workspace={workspace}
          workspaceSlug={workspaceSlug}
          workspaceProjectPath={workspaceProjectPath}
          fileContextId={fileContextId}
          openFunctions={openFunctions}
          onWorkspaceChange={onWorkspaceChange}
          onOpenFile={openFile}
        />
        {!wide && workspace.selectedRef && (
          <FileDetailsBar
            fileRef={workspace.selectedRef}
            entry={selectedEntry}
            collapsed={workspace.detailsCollapsed}
            onToggle={() => onWorkspaceChange({ ...workspace, detailsCollapsed: !workspace.detailsCollapsed })}
            onPreview={() => openFile(workspace.selectedRef!)}
          />
        )}
      </div>
      {wide && !treeCollapsed && <div role="separator" aria-orientation="vertical" aria-label="调整文件树宽度" className="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/10" onPointerDown={startResize} />}
      <div className={cn('min-h-0 min-w-0 flex-1', !wide && showTree && 'hidden')}>
        <RightPanelFilePreview
          fileRef={previewRef}
          guardedRef={activeTab?.guardedRef}
          lineSelection={activeTab?.lineSelection}
          navigationRevision={activeTab?.navigationRevision}
          onOpenFile={openFile}
          onMissing={handleMissing}
          onPreviewScopeChange={handlePreviewScopeChange}
          treeCollapsed={treeCollapsed}
          onToggleTree={wide ? () => setPreferences((current) => ({ ...current, treeCollapsed: !treeCollapsed })) : undefined}
        />
      </div>
    </div>
  )
}

function FileDetailsBar({ fileRef, entry, collapsed, onToggle, onPreview }: {
  fileRef: FileRef
  entry?: FileEntry
  collapsed: boolean
  onToggle: () => void
  onPreview: () => void
}) {
  return (
    <div className={cn('absolute inset-x-0 bottom-0 border-t bg-background px-2', collapsed ? 'h-7' : 'h-[72px]')}>
      <div className="flex h-7 items-center gap-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate">{fileRef.source} · {fileRef.relativePath}</span>
        <Button variant="ghost" size="icon-sm" className="size-5" onClick={onToggle}><ChevronDown size={12} className={cn(collapsed && 'rotate-180')} /></Button>
      </div>
      {!collapsed && (
        <div className="flex items-center gap-1">
          <span className="mr-auto truncate text-[10px] text-foreground/45">
            {entry?.isDirectory ? '目录' : fileType(fileRef.relativePath)}
            {entry?.size !== undefined ? ` · ${formatBytes(entry.size)}` : ''}
            {entry?.modifiedAt ? ` · ${new Date(entry.modifiedAt).toLocaleString()}` : ''}
          </span>
          <Button variant="secondary" size="sm" disabled={entry?.isDirectory} onClick={onPreview}>预览</Button>
          <Button variant="ghost" size="sm" disabled={!isDesktopRuntime()} onClick={() => void openFileRefInSystem(fileRef)}><ExternalLink size={13} />系统打开</Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="更多文件操作" />}><MoreHorizontal size={13} /></DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void revealFileRefInSystem(fileRef)}><FolderSearch size={13} />在文件管理器中显示</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void writeClipboardText(fileRef.relativePath)}><Copy size={13} />复制相对路径</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

function findCachedEntry(cache: Record<string, FileEntry[]>, ref: FileRef): FileEntry | undefined {
  return Object.values(cache).flat().find((entry) => entry.ref
    && entry.ref.source === ref.source
    && entry.ref.scopeId === ref.scopeId
    && entry.ref.relativePath === ref.relativePath)
}

function fileType(path: string): string {
  return path.split('.').at(-1)?.toUpperCase() || '文件'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`
  return `${Math.round(size / 1024 / 102.4) / 10} MB`
}
