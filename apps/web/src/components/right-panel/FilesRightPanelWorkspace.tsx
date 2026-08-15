import { useCallback, useMemo, useRef, useState, useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtom } from 'jotai'
import { PanelLeftClose } from 'lucide-react'
import type { FileEntry, FileRef } from '@lume/shared'
import { rightPanelFileLayoutPreferencesAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RightPanelFilePreview } from './RightPanelFilePreview'
import { UnifiedFileTree } from './UnifiedFileTree'
import { RightPanelMcpResourcePreview } from './RightPanelMcpResourcePreview'
import {
  clearPreviewFileTab,
  fileRefKey,
  openFileTab,
  removeFileRef,
  rightPanelFileTargetKey,
  rightPanelFileTargetRef,
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
  threadId,
  workspace,
  workspaceSlug,
  workspaceProjectPath,
  fileContextId,
  openFunctions,
  onWorkspaceChange,
}: {
  threadId: string
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
  const activeTab = activeFileTabId ? workspace.openTabs.find((tab) => tab.id === activeFileTabId) : undefined
  const previewActiveTab = workspace.previewTab
  const previewTarget = activeTab?.target ?? previewActiveTab?.target ?? null
  const previewRef = previewTarget ? rightPanelFileTargetRef(previewTarget) : null
  const previewEntry = previewRef ? findCachedEntry(workspace.directoryCache as Record<string, FileEntry[]>, previewRef) : undefined
  const showTree = !treeCollapsed && (wide || !preferences.narrowShowsPreview || !previewTarget)
  const treeWidth = useMemo(
    () => clampRightPanelFileTreeWidth(preferences.treeWidth ?? FILE_TREE_DEFAULT_WIDTH, Math.max(containerWidth, 680)),
    [containerWidth, preferences.treeWidth],
  )
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

  // 窄模式树/预览二态：树内单击/双击产生新预览目标（previewTab 或正式 file tab）时切到预览
  const handleWorkspaceChange = useCallback((next: ThreadFileWorkspace | ((current: ThreadFileWorkspace) => ThreadFileWorkspace)) => {
    const current = workspaceRef.current
    const resolved = typeof next === 'function' ? next(current) : next
    workspaceRef.current = resolved
    if (!wide) {
      const previewSet = resolved.previewTab && resolved.previewTab !== current.previewTab
      const tabActivated = resolved.activeItem?.kind === 'file' && resolved.activeItem !== current.activeItem
      if (previewSet || tabActivated) {
        setPreferences((currentPreferences) => ({ ...currentPreferences, narrowShowsPreview: true }))
      }
    }
    onWorkspaceChange(resolved)
  }, [onWorkspaceChange, setPreferences, wide])
  const openFile = useCallback((target: RightPanelFileTarget | FileRef) => {
    handleWorkspaceChange(openFileTab(workspaceRef.current, target, {
      caseInsensitive: /Win/i.test(navigator.platform),
    }))
  }, [handleWorkspaceChange])
  const handleMissing = useCallback((ref: FileRef) => {
    const previewTab = workspaceRef.current.previewTab
    if (previewTab?.ref && fileRefKey(previewTab.ref) === fileRefKey(ref)) {
      if (!wide) setPreferences((current) => ({ ...current, narrowShowsPreview: false }))
      onWorkspaceChange(clearPreviewFileTab(workspaceRef.current))
      return
    }
    onWorkspaceChange(removeFileRef(workspaceRef.current, ref, false, openFunctionsRef.current))
  }, [onWorkspaceChange, setPreferences, wide])
  const previewScopeKey = activeTab?.id ?? (previewTarget ? `temporary:${rightPanelFileTargetKey(previewTarget)}` : 'temporary')
  const handlePreviewScopeChange = useCallback((token: string | null) => {
    onWorkspaceChange((current) => setFilePreviewScope(current, previewScopeKey, token))
  }, [onWorkspaceChange, previewScopeKey])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !wide) return
    event.preventDefault()
    // 捕获指针：预览区承载 iframe/webview（独立文档不冒泡 pointer 事件），
    // 未捕获时光标拖入其区域后 move/up 丢失——拖动冻结且 resizing 卡死
    event.currentTarget.setPointerCapture(event.pointerId)
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
      window.removeEventListener('pointercancel', stop)
    }
    setResizing(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
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
          onWorkspaceChange={handleWorkspaceChange}
          onOpenFile={openFile}
        />
      </div>
      {wide && !treeCollapsed && <div role="separator" aria-orientation="vertical" aria-label="调整文件树宽度" className="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/10" onPointerDown={startResize} />}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !wide && showTree && 'hidden')}>
        {!wide && !showTree && previewTarget && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2.5 text-[11px]">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5"
              title="返回文件树"
              onClick={() => setPreferences((current) => ({ ...current, narrowShowsPreview: false }))}
            >
              <PanelLeftClose size={13} />
            </Button>
            <span className="min-w-0 flex-1 truncate text-foreground/60" title={previewRef ? `${previewRef.source} · ${previewRef.relativePath}` : undefined}>
              {previewRef?.relativePath ?? (previewTarget?.kind === 'mcp-resource' ? previewTarget.resource.name : previewTarget?.kind)}
            </span>
            {previewEntry && !previewEntry.isDirectory && previewRef && (
              <span className="shrink-0 text-[10px] text-foreground/45" title="文件信息">
                {fileType(previewRef.relativePath)}{previewEntry.size !== undefined ? ` · ${formatBytes(previewEntry.size)}` : ''}{previewEntry.modifiedAt ? ` · ${new Date(previewEntry.modifiedAt).toLocaleString()}` : ''}
              </span>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {previewTarget?.kind === 'mcp-resource'
            ? <RightPanelMcpResourcePreview workspaceSlug={previewTarget.workspaceSlug} resource={previewTarget.resource} hideSelfHeader={!wide} />
            : <RightPanelFilePreview
            threadId={threadId}
            fileRef={previewRef}
            lineSelection={activeTab?.lineSelection ?? previewActiveTab?.lineSelection}
            navigationRevision={activeTab?.navigationRevision ?? previewActiveTab?.navigationRevision}
            onOpenFile={openFile}
            onMissing={handleMissing}
            onPreviewScopeChange={handlePreviewScopeChange}
            onEditStart={!activeTab && previewActiveTab ? () => openFile(previewActiveTab.target) : undefined}
            treeCollapsed={treeCollapsed}
            hideSelfHeader={!wide}
            onToggleTree={wide ? () => setPreferences((current) => ({ ...current, treeCollapsed: !treeCollapsed })) : undefined}
          />}
        </div>
      </div>
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
