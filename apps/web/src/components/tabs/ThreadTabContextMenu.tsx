import { type ReactElement } from 'react'
import {
  Pin,
  PinOff,
  Pencil,
  Archive,
  Check,
  FolderTree,
  Copy,
  FileText,
  GitBranch,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadMoreActions } from '@/components/agent/use-thread-more-actions'

interface ThreadTabContextMenuProps {
  threadId: string
  readOnly?: boolean
  /** 被右键触发的 tab 元素（通常是 TabBar 的 <Button>）。 */
  children: ReactElement
}

/**
 * agent 会话 tab 的右键菜单：与 header「更多」(ThreadMoreActions) 内容一致，
 * 共享 useThreadMoreActions，保证两处行为完全相同。
 */
export function ThreadTabContextMenu({ threadId, readOnly = false, children }: ThreadTabContextMenuProps) {
  const {
    pinned,
    workspaces,
    currentId,
    setCurrentId,
    actions,
    copyPath,
    copyThreadId,
    copyMarkdown,
    fork,
    rename,
  } = useThreadMoreActions(threadId)

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent>
          {/* 切换工作区 */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderTree size={14} />
              切换工作区
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {workspaces.map((w) => (
                <ContextMenuItem key={w.id} onClick={() => setCurrentId(w.id)}>
                  <span className="flex-1 truncate">{w.name}</span>
                  {currentId === w.id && <Check size={12} className="text-primary" />}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* 会话管理（readOnly 下禁用） */}
          <ContextMenuItem className="disabled:opacity-45" onClick={() => !readOnly && actions.togglePin()}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? '取消置顶' : '置顶'}
          </ContextMenuItem>
          <ContextMenuItem className="disabled:opacity-45" onClick={() => !readOnly && rename.openRename()}>
            <Pencil size={14} />
            重命名
          </ContextMenuItem>
          <ContextMenuItem className="disabled:opacity-45" onClick={() => !readOnly && actions.archive()}>
            <Archive size={14} />
            归档
          </ContextMenuItem>

          <ContextMenuSeparator />

          {/* 复制（readOnly 下仍启用） */}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Copy size={14} />
              复制
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={copyPath}>
                <FolderTree size={14} />
                复制工作目录
              </ContextMenuItem>
              <ContextMenuItem onClick={copyThreadId}>
                <FileText size={14} />
                复制会话 ID
              </ContextMenuItem>
              <ContextMenuItem onClick={copyMarkdown}>
                <FileText size={14} />
                复制为 Markdown
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          {/* Fork（readOnly 下禁用） */}
          <ContextMenuItem className="disabled:opacity-45" onClick={() => !readOnly && fork()}>
            <GitBranch size={14} />
            Fork 分支
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* 重命名弹窗：与菜单外置，避免 base-ui 焦点冲突 */}
      <Dialog open={rename.open} onOpenChange={rename.setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <Input
            value={rename.value}
            onChange={(e) => rename.setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename.confirmRename()
            }}
            autoFocus
            className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              onClick={() => rename.setOpen(false)}
              className="px-3 py-1.5 rounded-md text-[12px] text-foreground/70 hover:bg-muted/50"
            >
              取消
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={() => void rename.confirmRename()}
              className="px-3 py-1.5 rounded-md text-[12px] bg-primary text-primary-foreground hover:bg-primary/90"
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
