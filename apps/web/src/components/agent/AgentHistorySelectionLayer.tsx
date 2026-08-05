/**
 * AgentHistorySelectionLayer — Agent 历史消息划线引用采集层
 *
 * 挂在 AgentMessages 的消息容器上，监听文本选区。划选后弹出 SelectionActionPopover：
 * 1. 为 Agent 引用 —— 写入当前会话 quotedSelectionMapAtom[threadId]，输入框展示 chip（主闭环）
 * 2. 打开右侧问答 —— 新建 agent 会话 tab + 切过去 + 把引用带到新会话
 *    （Lume 无 Proma 的右侧 side chat，映射为「新会话 tab」；与「为 Agent 引用」的当前会话区分）
 *
 * 选区归属靠消息项的 data-message-id / data-message-role（AgentMessages.tsx 标注）。
 */

import { useCallback, useEffect, useRef, type ReactElement, type RefObject } from 'react'
import { useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { activeTabIdAtom, agentThreadsAtom, currentWorkspaceIdAtom, quotedSelectionMapAtom, tabsAtom, type QuotedSelection } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentThreadMeta } from '@lume/shared'
import { useQuotedSelection } from '@/hooks/use-quoted-selection'
import { SelectionActionPopover } from '@/components/selection/SelectionActionPopover'

const MAX_AGENT_HISTORY_QUOTED_CHARS = 2000

interface AgentHistorySelectionLayerProps {
  threadId: string
  rootRef: RefObject<HTMLElement | null>
}

function getRoleLabel(role?: string): string {
  if (role === 'user') return 'Agent 历史 · 用户消息'
  if (role === 'assistant') return 'Agent 历史 · Agent 回复'
  if (role === 'system') return 'Agent 历史 · 系统消息'
  return 'Agent 历史'
}

/** 从选区两端提取所属消息的 id/role（仅当选区完全落在同一条消息内） */
function extractMessageContext(range: Range): { messageId?: string; messageRole?: string } {
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const endEl = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  const startMsg = startEl?.closest('[data-message-id]')
  const endMsg = endEl?.closest('[data-message-id]')
  // 跨消息选区不带单条归属
  if (!startMsg || !endMsg || startMsg !== endMsg) return {}
  return {
    messageId: startMsg.getAttribute('data-message-id') ?? undefined,
    messageRole: startMsg.getAttribute('data-message-role') ?? undefined,
  }
}

export function AgentHistorySelectionLayer({
  threadId,
  rootRef,
}: AgentHistorySelectionLayerProps): ReactElement | null {
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const store = useStore()
  const { selection, clearSelection } = useQuotedSelection({
    rootRef,
    maxChars: MAX_AGENT_HISTORY_QUOTED_CHARS,
    extractContext: extractMessageContext,
  })
  const openChatPendingRef = useRef(false)

  // 截断提示（仅当本次选区触发截断时）
  useEffect(() => {
    if (selection?.truncated) {
      toast.warning(`已选中超过 ${MAX_AGENT_HISTORY_QUOTED_CHARS} 字符，仅引用前 ${MAX_AGENT_HISTORY_QUOTED_CHARS} 字符`, {
        id: `agent-history-selection-cap:${threadId}`,
        duration: 3000,
      })
    }
  }, [selection, threadId])

  const handleAddToAgent = useCallback((): void => {
    if (!selection) return
    const sourceLabel = getRoleLabel(selection.messageRole)
    const quoted: QuotedSelection = {
      text: selection.text,
      filePath: sourceLabel,
      sourceType: 'agent-history',
      sourceLabel,
      messageId: selection.messageId,
      messageRole: selection.messageRole as QuotedSelection['messageRole'],
      capturedAt: Date.now(),
    }
    setQuotedSelectionMap((prev) => ({ ...prev, [threadId]: quoted }))
    window.getSelection()?.removeAllRanges()
    clearSelection()
    toast.success('已添加到 Agent 引用')
  }, [clearSelection, selection, setQuotedSelectionMap, threadId])

  /** 新建会话并以选区为引用上下文（Lume 的「右侧问答」映射：新 agent tab + 切过去） */
  const handleOpenChat = useCallback(async (): Promise<void> => {
    if (!selection || openChatPendingRef.current) return
    openChatPendingRef.current = true
    try {
      const workspaceId = store.get(currentWorkspaceIdAtom) ?? undefined
      // 新建会话（与 WelcomeView 一致：sidecarCall 带 AgentThreadMeta 泛型；后端用默认 model）
      const meta = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, { workspaceId })
      const sourceLabel = getRoleLabel(selection.messageRole)
      // 引用带到新会话（AgentInput 读 quotedSelectionFamily(meta.id) 自动展示 chip）
      setQuotedSelectionMap((prev) => ({
        ...prev,
        [meta.id]: {
          text: selection.text,
          filePath: sourceLabel,
          sourceType: 'agent-history',
          sourceLabel,
          messageId: selection.messageId,
          messageRole: selection.messageRole as QuotedSelection['messageRole'],
          capturedAt: Date.now(),
        },
      }))
      // 乐观更新侧栏（后端 THREAD_LIST_CHANGED 会校正）
      setThreads((prev) => [meta, ...prev])
      // 打开 agent tab（去重 upsert，与 CommandPalette 一致）
      setActiveTabId(meta.id)
      setTabs((prev) => prev.find((t) => t.id === meta.id)
        ? prev
        : [...prev, {
            id: meta.id,
            type: 'agent' as const,
            title: meta.title,
            threadId: meta.id,
            ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
          }])
      window.getSelection()?.removeAllRanges()
      clearSelection()
      toast.success('已在新会话引用选区')
    } catch (error) {
      console.error('[AgentHistorySelectionLayer] 打开问答会话失败:', error)
      toast.error('打开问答会话失败')
    } finally {
      openChatPendingRef.current = false
    }
  }, [clearSelection, selection, setActiveTabId, setQuotedSelectionMap, setTabs, setThreads, store])

  if (!selection) return null

  return (
    <SelectionActionPopover
      x={selection.x}
      y={selection.y}
      onAddToAgent={handleAddToAgent}
      onOpenChat={handleOpenChat}
    />
  )
}
