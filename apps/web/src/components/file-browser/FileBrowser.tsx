import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Folder, RefreshCw } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileTypeIcon } from './FileTypeIcon'
import { cn } from '@/lib/utils'
import { sidecarCall } from '@/lib/desktop-api'
import type { FileEntry } from '@lume/shared'

interface FileBrowserProps {
  threadId: string
  workspaceSlug?: string
  refreshToken?: number
}

export function normalizeDirectoryEntriesResponse(
  response: { entries?: FileEntry[] } | FileEntry[] | undefined | null
): FileEntry[] {
  if (Array.isArray(response)) {
    return response
  }
  return response?.entries ?? []
}

export function FileBrowser({ threadId, workspaceSlug, refreshToken = 0 }: FileBrowserProps) {
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
      <div className="px-3 py-2.5 border-b border-border/50 flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground/60">文件浏览器</span>
        <button
          onClick={handleRefresh}
          className="p-1 rounded hover:bg-muted/50 text-foreground/40 hover:text-foreground/70 transition-colors"
          title="刷新"
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2 py-2">
          {entries.map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              depth={0}
              threadId={threadId}
              workspaceSlug={workspaceSlug}
              parentRefreshTick={rootTick}
            />
          ))}
          {!loading && entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-foreground/30">目录为空</p>
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
}: {
  entry: FileEntry
  depth: number
  threadId: string
  workspaceSlug?: string
  parentRefreshTick: number
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
    if (!entry.isDirectory) return
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

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors text-left"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {entry.isDirectory
          ? <ChevronRight size={12} className={cn('text-foreground/40 transition-transform flex-shrink-0', open && 'rotate-90')} />
          : <span className="w-3 flex-shrink-0" />
        }
        {entry.isDirectory
          ? <Folder size={13} className="text-foreground/50 flex-shrink-0" />
          : <FileTypeIcon filename={entry.name} size={13} />
        }
        <span className="text-[12px] text-foreground/70 truncate">{entry.name}</span>
      </button>
      {open && children.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          threadId={threadId}
          workspaceSlug={workspaceSlug}
          parentRefreshTick={parentRefreshTick}
        />
      ))}
    </div>
  )
}
