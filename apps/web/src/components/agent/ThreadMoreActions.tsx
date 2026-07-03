import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  MoreHorizontal,
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
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall, writeClipboardText, getThreadMessages } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { useThreadActions } from './use-thread-actions'
import { threadToMarkdown } from './thread-to-markdown'

interface ThreadMoreActionsProps {
  threadId: string
  readOnly?: boolean
}

/** 会话顶部「更多操作」菜单：工作区切换 / 置顶·重命名·归档 / 复制 / Fork。 */
export function ThreadMoreActions({ threadId, readOnly = false }: ThreadMoreActionsProps) {
  const thread = useAtomValue(agentThreadsAtom).find((t) => t.id === threadId)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const actions = useThreadActions(threadId)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const currentWorkspace = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  const pinned = thread?.pinned ?? false

  // 复制当前工作区绝对路径（复用现有 GET_WORKSPACE_ROOT_PATH IPC）
  const handleCopyPath = async (): Promise<void> => {
    if (!currentWorkspace?.slug) {
      toast.error('当前无工作区')
      return
    }
    try {
      const path = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, {
        workspaceSlug: currentWorkspace.slug,
      })
      await writeClipboardText(path)
      toast.success('已复制工作目录')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制工作目录失败:', error)
      toast.error('复制失败')
    }
  }

  const handleCopyThreadId = async (): Promise<void> => {
    try {
      await writeClipboardText(threadId)
      toast.success('已复制会话 ID')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制会话 ID 失败:', error)
      toast.error('复制失败')
    }
  }

  const handleCopyMarkdown = async (): Promise<void> => {
    try {
      const messages = await getThreadMessages(threadId)
      const md = threadToMarkdown(thread?.title ?? '未命名会话', messages)
      await writeClipboardText(md)
      toast.success('已复制为 Markdown')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制 Markdown 失败:', error)
      toast.error('复制失败')
    }
  }

  // Fork：整体分叉（取最后一条消息 id），本期不自动跳转（见技术债）
  const handleFork = async (): Promise<void> => {
    try {
      const messages = await getThreadMessages(threadId)
      const last = messages[messages.length - 1]
      if (!last) {
        toast.error('空会话无法 Fork')
        return
      }
      await sidecarCall<{ newThreadId: string }>(AGENT_IPC_CHANNELS.FORK_THREAD, {
        threadId,
        upToMessageId: last.id,
      })
      toast.success('已创建分叉，请在侧栏查看')
    } catch (error) {
      console.error('[ThreadMoreActions] Fork 失败:', error)
      toast.error('Fork 失败')
    }
  }

  const openRename = (): void => {
    setRenameValue(thread?.title ?? '')
    setRenameOpen(true)
  }

  const confirmRename = async (): Promise<void> => {
    setRenameOpen(false)
    await actions.rename(renameValue)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="更多操作"
              className="flex-shrink-0 p-0.5 rounded text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors"
            >
              <MoreHorizontal size={16} />
            </button>
          }
        />
        <DropdownMenuContent>
          {/* 切换工作区（全局当前工作区，沿用 WorkspacePicker 语义） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderTree size={14} />
              切换工作区
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {workspaces.map((w) => (
                <DropdownMenuItem key={w.id} onClick={() => setCurrentId(w.id)}>
                  <span className="flex-1 truncate">{w.name}</span>
                  {currentId === w.id && <Check size={12} className="text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* 会话管理（readOnly 下禁用） */}
          <DropdownMenuItem disabled={readOnly} onClick={() => actions.togglePin()}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onClick={openRename}>
            <Pencil size={14} />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onClick={() => actions.archive()}>
            <Archive size={14} />
            归档
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* 复制（readOnly 下仍启用） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Copy size={14} />
              复制
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={handleCopyPath}>
                <FolderTree size={14} />
                复制工作目录
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyThreadId}>
                <FileText size={14} />
                复制会话 ID
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyMarkdown}>
                <FileText size={14} />
                复制为 Markdown
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Fork（readOnly 下禁用） */}
          <DropdownMenuItem disabled={readOnly} onClick={handleFork}>
            <GitBranch size={14} />
            Fork 分支
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 重命名弹窗：与菜单外置，避免 base-ui 焦点冲突 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmRename()
            }}
            autoFocus
            className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary"
          />
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              className="px-3 py-1.5 rounded-md text-[12px] text-foreground/70 hover:bg-muted/50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void confirmRename()}
              className="px-3 py-1.5 rounded-md text-[12px] bg-primary text-primary-foreground hover:bg-primary/90"
            >
              确认
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
