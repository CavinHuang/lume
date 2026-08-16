import { useState } from 'react'
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, X } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type ExternalDirEntry, type ExternalDirEntryItem } from '@lume/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import {
  isDesktopRuntime,
  openInSystem,
  revealPathInSystem,
  sidecarCall,
  writeClipboardText,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

/** 双作用域附加目录清单（dirs 由挂载层 UnifiedFileTree 经 sidecarCall 注入，保持本组件纯渲染可测） */
export interface ExternalDirsByScope {
  thread: ExternalDirEntry[]
  workspace: ExternalDirEntry[]
}

const EXTERNAL_DIR_SECTIONS: { scope: keyof ExternalDirsByScope; label: string }[] = [
  { scope: 'thread', label: '附加目录（会话）' },
  { scope: 'workspace', label: '附加目录（工作区·共享）' },
]

export function ExternalDirsSection({ dirs, onRemove }: {
  dirs: ExternalDirsByScope
  onRemove: (scope: keyof ExternalDirsByScope, absolutePath: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [entriesCache, setEntriesCache] = useState<Record<string, ExternalDirEntryItem[]>>({})

  const toggle = async (absolutePath: string) => {
    const next = new Set(expanded)
    if (next.has(absolutePath)) next.delete(absolutePath)
    else {
      next.add(absolutePath)
      if (!(absolutePath in entriesCache)) {
        try {
          const entries = await sidecarCall<ExternalDirEntryItem[]>(
            AGENT_IPC_CHANNELS.LIST_EXTERNAL_DIR_ENTRIES,
            { absolutePath },
          )
          setEntriesCache((cache) => ({ ...cache, [absolutePath]: entries }))
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '读取外部目录失败')
          // 加载失败且未写缓存：回滚展开态，避免行停留在「加载中…」
          next.delete(absolutePath)
          setExpanded(next)
          return
        }
      }
    }
    setExpanded(next)
  }

  if (!EXTERNAL_DIR_SECTIONS.some((section) => dirs[section.scope].length > 0)) return null

  return (
    <div>
      {EXTERNAL_DIR_SECTIONS.map((section) => {
        const entries = dirs[section.scope]
        if (entries.length === 0) return null
        return (
          <div key={section.scope}>
            <div className="flex h-[30px] items-center gap-1.5 px-2 text-[12px] font-medium">
              <ChevronRight size={13} className="rotate-90" />
              {section.label}
              <span className="text-foreground/38">{entries.length}</span>
            </div>
            {entries.map((entry) => (
              <ExternalDirRow
                key={entry.absolutePath}
                scope={section.scope}
                path={entry.absolutePath}
                name={entry.absolutePath}
                depth={0}
                removable
                isDirectory
                available={entry.available}
                expanded={expanded}
                entriesCache={entriesCache}
                onToggle={(path) => void toggle(path)}
                onRemove={onRemove}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function ExternalDirRow(props: {
  scope: keyof ExternalDirsByScope
  path: string
  name: string
  depth: number
  removable: boolean
  isDirectory: boolean
  available: boolean
  expanded: Set<string>
  entriesCache: Record<string, ExternalDirEntryItem[]>
  onToggle: (path: string) => void
  onRemove: (scope: keyof ExternalDirsByScope, path: string) => void
}) {
  const { path, name, isDirectory, available } = props
  const open = props.expanded.has(path)
  const entries = props.entriesCache[path]
  const childIndent = { paddingLeft: 18 + props.depth * 12 }
  return (
    <div>
      <div
        className="group flex h-7 items-center gap-1 pr-1 text-[12px] hover:bg-foreground/[0.05]"
        style={{ paddingLeft: 6 + props.depth * 12 }}
        onClick={() => { if (isDirectory && available) props.onToggle(path) }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5 shrink-0"
          disabled={!isDirectory || !available}
          onClick={(event) => { event.stopPropagation(); if (isDirectory && available) props.onToggle(path) }}
        >
          <ChevronDown size={12} className={cn('transition-transform', !open && '-rotate-90')} />
        </Button>
        {isDirectory ? <Folder size={14} className="shrink-0 text-foreground/45" /> : <FileTypeIcon filename={name} size={14} />}
        <span className="min-w-0 flex-1 truncate" title={path}>{name}</span>
        {!available && <span className="shrink-0 text-[10px] text-red-600">路径不可用</span>}
        {props.scope === 'workspace' && (
          <span className="shrink-0 rounded bg-foreground/6 px-1 text-[9px] leading-4 text-foreground/45">共享</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />}><MoreHorizontal size={12} /></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void openInSystem(path)}>系统打开</DropdownMenuItem>
            <DropdownMenuItem disabled={!isDesktopRuntime()} onSelect={() => void revealPathInSystem(path)}>在文件管理器中显示</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void writeClipboardText(path)}>复制路径</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {props.removable && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="移除附加"
            className={cn('size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', !available && 'opacity-100')}
            onClick={(event) => { event.stopPropagation(); props.onRemove(props.scope, path) }}
          >
            <X size={12} />
          </Button>
        )}
      </div>
      {isDirectory && open && (
        entries === undefined
          ? <div className="flex h-6 items-center text-[11px] text-foreground/38" style={childIndent}>加载中…</div>
          : entries.length === 0
            ? <div className="flex h-6 items-center text-[11px] text-foreground/38" style={childIndent}>空文件夹</div>
            : entries.map((item) => (
              <ExternalDirRow
                key={item.name}
                {...props}
                path={joinExternalPath(path, item.name)}
                name={item.name}
                depth={props.depth + 1}
                removable={false}
                available={true}
                isDirectory={item.isDirectory}
              />
            ))
      )}
    </div>
  )
}

function joinExternalPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}
