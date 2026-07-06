import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Folder, RefreshCw } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileTypeIcon } from './FileTypeIcon'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { cn } from '@/lib/utils'
import { sidecarCall } from '@/lib/desktop-api'
import type { FileEntry } from '@lume/shared'

import { Button } from '@/components/ui/button'
interface FileBrowserProps {
  threadId: string
  workspaceSlug?: string
  refreshToken?: number
  selectedPath?: string
  onOpenFile?: (path: string) => void
  showHeader?: boolean
  searchQuery?: string
}

export function normalizeDirectoryEntriesResponse(
  response: { entries?: FileEntry[] } | FileEntry[] | undefined | null
): FileEntry[] {
  if (Array.isArray(response)) {
    return response
  }
  return response?.entries ?? []
}

export function FileBrowser({
  threadId,
  workspaceSlug,
  refreshToken = 0,
  selectedPath,
  onOpenFile,
  showHeader = true,
  searchQuery = '',
}: FileBrowserProps) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [rootTick, setRootTick] = useState(0)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const r = await sidecarCall<{ entries: FileEntry[] }>('agent:list-directory', {
        ...(workspaceSlug ? { workspaceSlug } : {}),
        threadId,
      })
      setEntries(normalizeDirectoryEntriesResponse(r))
    } catch (err) {
      console.error('[FileBrowser] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug, threadId])

  useEffect(() => {
    loadRoot()
  }, [loadRoot, refreshToken])

  const handleRefresh = () => {
    setRootTick((t) => t + 1)
    loadRoot()
  }

  return (
    <div className="flex flex-col h-full">
      {showHeader && (
        <div className="flex items-center justify-between border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3 py-2.5">
          <span className="text-[12px] font-medium text-[var(--text-3)]">文件浏览器</span>
          <Button
                variant="ghost"
            onClick={handleRefresh}
            className="rounded p-1 text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
            title="刷新"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0">
        <div className={cn('py-2', showHeader ? 'px-2' : 'px-4')}>
          {entries.filter((entry) => matchesSearch(entry, searchQuery)).map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              depth={0}
              threadId={threadId}
              workspaceSlug={workspaceSlug}
              parentRefreshTick={rootTick}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              searchQuery={searchQuery}
              largeRows={!showHeader}
            />
          ))}
          {!loading && entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-[var(--text-3)]">目录为空</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function FileTreeItem({
  entry,
  depth,
  threadId,
  workspaceSlug,
  parentRefreshTick,
  selectedPath,
  onOpenFile,
  searchQuery,
  largeRows,
}: {
  entry: FileEntry
  depth: number
  threadId: string
  workspaceSlug?: string
  parentRefreshTick: number
  selectedPath?: string
  onOpenFile?: (path: string) => void
  searchQuery: string
  largeRows: boolean
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [childrenLoaded, setChildrenLoaded] = useState(false)

  useEffect(() => {
    setOpen(false)
    setChildren([])
    setChildrenLoaded(false)
  }, [parentRefreshTick])

  const toggle = async () => {
    if (!entry.isDirectory) {
      onOpenFile?.(entry.path)
      return
    }
    if (!open && !childrenLoaded) {
      try {
        const r = await sidecarCall<{ entries: FileEntry[] }>('agent:list-directory', {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          threadId,
          path: entry.path,
        })
        setChildren(normalizeDirectoryEntriesResponse(r))
        setChildrenLoaded(true)
      } catch (err) {
        console.error('[FileBrowser] 加载子目录失败:', err)
      }
    }
    setOpen((v) => !v)
  }

  if (!matchesSearch(entry, searchQuery) && children.every((child) => !matchesSearch(child, searchQuery))) {
    return null
  }

  const rowButton = (
    <Button
                variant="ghost"
      onClick={toggle}
      className={cn(
        'w-full flex h-9 items-center justify-start gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--surface-2)]',
        !largeRows && 'h-auto gap-1.5 rounded-lg py-1',
        !entry.isDirectory && selectedPath === entry.path && 'bg-[color:color-mix(in_oklab,var(--brand)_26%,transparent)] text-[var(--brand-2)]',
      )}
      style={{ paddingLeft: `${8 + depth * (largeRows ? 16 : 12)}px` }}
    >
      {entry.isDirectory
        ? <ChevronRight size={largeRows ? 16 : 12} className={cn('text-[var(--text-3)] transition-transform flex-shrink-0', open && 'rotate-90')} />
        : <span className={cn('flex-shrink-0', largeRows ? 'w-4' : 'w-3')} />
      }
      {entry.isDirectory
        ? <Folder size={largeRows ? 17 : 13} className="text-[var(--text-3)] flex-shrink-0" />
        : <FileTypeIcon filename={entry.name} size={largeRows ? 16 : 13} />
      }
      <span
        className={cn('truncate text-[var(--text-2)]', largeRows ? 'text-[13px]' : 'text-[12px]', !entry.isDirectory && selectedPath === entry.path && 'text-[var(--brand-2)]')}
        onClick={(event) => {
          if (entry.isDirectory || !onOpenFile) return
          event.stopPropagation()
          onOpenFile(entry.path)
        }}
      >
        {entry.name}
      </span>
    </Button>
  )

  return (
    <div>
      {entry.isDirectory
        ? rowButton
        : (
          <FileLinkContextMenu
            context={{ source: 'thread', relPath: entry.path, threadId, workspaceSlug }}
            onPreview={() => onOpenFile?.(entry.path)}
          >
            {rowButton}
          </FileLinkContextMenu>
        )}
      {open && children.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          threadId={threadId}
          workspaceSlug={workspaceSlug}
          parentRefreshTick={parentRefreshTick}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          searchQuery={searchQuery}
          largeRows={largeRows}
        />
      ))}
    </div>
  )
}

function matchesSearch(entry: FileEntry, searchQuery: string): boolean {
  const query = searchQuery.trim().toLowerCase()
  if (!query) return true
  if (entry.name.toLowerCase().includes(query)) return true
  return (entry.children ?? []).some((child) => matchesSearch(child, query))
}
