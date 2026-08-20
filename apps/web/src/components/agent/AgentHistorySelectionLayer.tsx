/**
 * AgentHistorySelectionLayer — Agent 历史消息划线引用采集层
 *
 * 挂在 AgentMessages 的消息容器上，监听文本选区。划选后弹出 SelectionActionPopover：
 * 1. 为 Agent 引用 —— 写入当前会话 quotedSelectionMapAtom[threadId]，输入框展示 chip（主闭环）
 * 2. 打开右侧问答 —— 在右侧面板 side-chat 打开问答会话（复用或新建）+ 把引用带到该会话（见 #18）
 *
 * 选区归属靠消息项的 data-message-id / data-message-role（AgentMessages.tsx 标注）。
 */

import { useCallback, useEffect, useRef, type ReactElement, type RefObject } from 'react'
import { useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { agentSideChatMapAtom, agentThreadsAtom, currentWorkspaceIdAtom, quotedSelectionMapAtom, rightPanelLayoutAtom, rightPanelWorkspaceActionAtom, type QuotedSelection } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentThreadMeta } from '@lume/shared'
import { useQuotedSelection } from '@/hooks/useQuotedSelection'
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
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const dispatchRightPanel = useSetAtom(rightPanelWorkspaceActionAtom)
  const setRightPanelLayout = useSetAtom(rightPanelLayoutAtom)
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

  /** 在右侧面板 side-chat 打开问答：复用或新建 side-chat 会话，并把选区作为引用上下文（见 #18） */
  const handleOpenChat = useCallback(async (): Promise<void> => {
    if (!selection || openChatPendingRef.current) return
    openChatPendingRef.current = true
    try {
      const workspaceId = store.get(currentWorkspaceIdAtom) ?? undefined
      // 复用当前会话的 side-chat；不存在则新建（与 WelcomeView 一致：后端用默认 model）
      const existingSideChatId = store.get(agentSideChatMapAtom)[threadId]
      let sideChatId: string
      if (existingSideChatId) {
        sideChatId = existingSideChatId
      } else {
        const meta = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, { workspaceId })
        sideChatId = meta.id
        setSideChatMap((prev) => ({ ...prev, [threadId]: sideChatId }))
        // 乐观更新侧栏（后端 THREAD_LIST_CHANGED 会校正）
        setThreads((prev) => prev.find((t) => t.id === sideChatId) ? prev : [meta, ...prev])
      }
      const sourceLabel = getRoleLabel(selection.messageRole)
      // 引用带到 side-chat（AgentInput 读 quotedSelectionFamily(sideChatId) 自动展示 chip）
      setQuotedSelectionMap((prev) => ({
        ...prev,
        [sideChatId]: {
          text: selection.text,
          filePath: sourceLabel,
          sourceType: 'agent-history',
          sourceLabel,
          messageId: selection.messageId,
          messageRole: selection.messageRole as QuotedSelection['messageRole'],
          capturedAt: Date.now(),
        },
      }))
      // 在右栏打开 side-chat（不触碰主区域 tabs）（见 #18）
      dispatchRightPanel({ type: 'activate-side-chat', threadId })
      setRightPanelLayout((prev) => ({
        open: true,
        mode: prev.open && prev.mode === 'expanded' ? 'expanded' : 'normal',
      }))
      window.getSelection()?.removeAllRanges()
      clearSelection()
      toast.success('已在右侧打开问答')
    } catch (error) {
      console.error('[AgentHistorySelectionLayer] 打开问答会话失败:', error)
      toast.error('打开问答会话失败')
    } finally {
      openChatPendingRef.current = false
    }
  }, [clearSelection, dispatchRightPanel, selection, setQuotedSelectionMap, setRightPanelLayout, setSideChatMap, setThreads, store, threadId])

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
