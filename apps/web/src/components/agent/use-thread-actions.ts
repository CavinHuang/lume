import { useAtom, useSetAtom } from 'jotai'
import { agentThreadsAtom, tabsAtom, activeTabIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { toast } from 'sonner'

/**
 * 会话写操作 hook：置顶 / 重命名 / 归档。
 * 复刻 LeftSidebar.tsx:148-208 的逻辑，供 AgentHeader 树使用（列表项本期不改，留待收敛）。
 * 归档不做二次确认（顶部菜单直接执行；归档可恢复）。
 */
export function useThreadActions(threadId: string) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const togglePin = async (): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    try {
      await sidecarCall('agent:toggle-pin-thread', { threadId: thread.id })
      setThreads((prev) =>
        prev.map((item) => (item.id === thread.id ? { ...item, pinned: !item.pinned } : item)),
      )
    } catch (error) {
      console.error('[useThreadActions] 置顶失败:', error)
      toast.error('操作失败')
    }
  }

  const rename = async (title: string): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    const trimmed = title.trim()
    if (!thread || !trimmed || trimmed === thread.title) return
    try {
      await sidecarCall('agent:update-thread-title', { threadId: thread.id, title: trimmed })
      setThreads((prev) =>
        prev.map((item) => (item.id === thread.id ? { ...item, title: trimmed } : item)),
      )
      setTabs((prev) => prev.map((tab) => (tab.id === thread.id ? { ...tab, title: trimmed } : tab)))
    } catch (error) {
      console.error('[useThreadActions] 重命名失败:', error)
      toast.error('重命名失败')
    }
  }

  const archive = async (): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    try {
      await sidecarCall('agent:archive-thread', { threadId: thread.id })
      setThreads((prev) => prev.filter((item) => item.id !== thread.id))
      setTabs((prev) => prev.filter((tab) => tab.id !== thread.id))
      setActiveTabId((prev) => (prev === thread.id ? null : prev))
      toast.success('已归档')
    } catch (error) {
      console.error('[useThreadActions] 归档失败:', error)
      toast.error('归档失败')
    }
  }

  return { togglePin, rename, archive }
}
