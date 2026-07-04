import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall, writeClipboardText, getThreadMessages } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { useThreadActions } from './use-thread-actions'
import { threadToMarkdown } from './thread-to-markdown'

/**
 * 会话「更多操作」共享逻辑：置顶 / 重命名 / 归档 + 切换工作区 + 复制 + Fork。
 * 供 header 下拉菜单 (ThreadMoreActions) 与 tab 右键菜单 (ThreadTabContextMenu) 共用，
 * 保证两处行为完全一致。readOnly 由调用方在渲染层用于禁用项，不在此处处理。
 */
export function useThreadMoreActions(threadId: string) {
  const thread = useAtomValue(agentThreadsAtom).find((t) => t.id === threadId)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const actions = useThreadActions(threadId)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const currentWorkspace = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  const pinned = thread?.pinned ?? false

  const copyPath = async (): Promise<void> => {
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
      console.error('[useThreadMoreActions] 复制工作目录失败:', error)
      toast.error('复制失败')
    }
  }

  const copyThreadId = async (): Promise<void> => {
    try {
      await writeClipboardText(threadId)
      toast.success('已复制会话 ID')
    } catch (error) {
      console.error('[useThreadMoreActions] 复制会话 ID 失败:', error)
      toast.error('复制失败')
    }
  }

  const copyMarkdown = async (): Promise<void> => {
    try {
      const messages = await getThreadMessages(threadId)
      const md = threadToMarkdown(thread?.title ?? '未命名会话', messages)
      await writeClipboardText(md)
      toast.success('已复制为 Markdown')
    } catch (error) {
      console.error('[useThreadMoreActions] 复制 Markdown 失败:', error)
      toast.error('复制失败')
    }
  }

  // Fork：整体分叉（取最后一条消息 id），本期不自动跳转（见技术债）
  const fork = async (): Promise<void> => {
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
      console.error('[useThreadMoreActions] Fork 失败:', error)
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

  return {
    thread,
    pinned,
    workspaces,
    currentId,
    setCurrentId,
    actions,
    copyPath,
    copyThreadId,
    copyMarkdown,
    fork,
    rename: {
      open: renameOpen,
      setOpen: setRenameOpen,
      value: renameValue,
      setValue: setRenameValue,
      openRename,
      confirmRename,
    },
  }
}
