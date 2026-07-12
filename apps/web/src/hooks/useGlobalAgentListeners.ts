import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { listSubagentWork, onSidecarEvent, sidecarCall } from '@/lib/desktop-api'
import {
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentRuntimeEventsAtom,
  agentPendingInteractiveAtom,
  agentMessageQueueAtom,
  agentSubagentRunsAtom,
  agentSubagentWorkAtom,
  agentPlanModePhaseAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
  desktopActionVisualAtom,
  agentSidePanelViewAtom,
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  welcomePromptSeedAtom,
} from '@/atoms'
import { buildDesktopProposalOpenRequestState } from '@/components/settings/desktop-assistant-proposals-state'
import { threadMessagesCache } from '@/components/agent/thread-messages-cache'
import {
  AGENT_IPC_CHANNELS,
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type AgentMessageAppendedEvent,
  type AgentPendingInteractiveState,
  type AgentRuntimeEventNotification,
  type AgentRuntimeStatusChangedEvent,
  type AgentThreadRuntimeEventsResult,
  type AgentThreadMeta,
  type AgentAskUserQuestionRequest,
  type AgentBrowserAuthRequest,
  type AgentDesktopActionRequest,
  type AgentToolPermissionRequest,
  type AgentSubagentCompletionEvent,
  type AgentSubagentWorkChangedEvent,
  type AgentMessageQueueSnapshot,
  type PlanModePhaseChangedEvent,
  type LumeRuntimeEvent,
  type DesktopProactiveProposal,
} from '@lume/shared'
import {
  planPreviewToPendingTaskApproval,
  removePendingToolPermissionEverywhere,
  removePendingTaskApprovalsForThread,
  upsertPendingAskUserQuestion,
  upsertPendingBrowserAuthRequest,
  upsertPendingDesktopActionRequest,
  upsertPendingTaskApproval,
  upsertPendingToolPermission,
} from './pending-interactive-state'
import { appendRuntimeEvents, hydrateRuntimeEvents } from './runtime-event-state'
import { projectDesktopActionVisualEvent } from './desktop-action-visual-state'

export function useGlobalAgentListeners() {
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setMessageQueues = useSetAtom(agentMessageQueueAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setSubagentWork = useSetAtom(agentSubagentWorkAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)
  const setDesktopActionVisual = useSetAtom(desktopActionVisualAtom)
  const setSidePanelViews = useSetAtom(agentSidePanelViewAtom)
  const setTabs = useSetAtom(tabsAtom)
  const tabs = useAtomValue(tabsAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)

  const pendingRuntimeEventsRef = useRef<LumeRuntimeEvent[]>([])
  const runtimeEventsRafRef = useRef<number | null>(null)
  const desktopActionVisualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRuntimeEvents = useCallback(() => {
    runtimeEventsRafRef.current = null
    const batch = pendingRuntimeEventsRef.current
    if (batch.length === 0) return
    pendingRuntimeEventsRef.current = []
    setRuntimeEvents((prev) => appendRuntimeEvents(prev, batch))
  }, [setRuntimeEvents])
  const enqueueRuntimeEvent = useCallback((event: LumeRuntimeEvent) => {
    pendingRuntimeEventsRef.current.push(event)
    if (runtimeEventsRafRef.current === null) {
      runtimeEventsRafRef.current = requestAnimationFrame(flushRuntimeEvents)
    }
  }, [flushRuntimeEvents])

  useEffect(() => {
    sidecarCall<AgentPendingInteractiveState[]>(AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE)
      .then((states) => {
        setPendingInteractive((prev) => {
          let next = prev
          for (const state of states ?? []) {
            for (const request of state.askUserQuestions ?? []) {
              next = upsertPendingAskUserQuestion(next, request)
            }
            for (const request of state.browserAuthRequests ?? []) {
              next = upsertPendingBrowserAuthRequest(next, request)
            }
            for (const request of state.desktopActionRequests ?? []) {
              next = upsertPendingDesktopActionRequest(next, request)
            }
            for (const request of state.toolPermissions ?? []) {
              next = upsertPendingToolPermission(next, request)
            }
            for (const request of state.taskApprovals ?? []) {
              next = upsertPendingTaskApproval(next, request)
            }
          }
          return next
        })
      })
      .catch((error) => {
        console.error('[useGlobalAgentListeners] 恢复 pending interactive 失败:', error)
      })

    const unlisten = onSidecarEvent((method, params) => {
      switch (method) {
        case AGENT_IPC_CHANNELS.RUNTIME_EVENT: {
          const notification = params as AgentRuntimeEventNotification
          const { threadId, event } = notification
          enqueueRuntimeEvent(event)
          if (event.type === 'desktop.action_visual') {
            if (desktopActionVisualTimerRef.current) {
              clearTimeout(desktopActionVisualTimerRef.current)
              desktopActionVisualTimerRef.current = null
            }
            setDesktopActionVisual(projectDesktopActionVisualEvent(event))
            if (event.phase !== 'started') {
              desktopActionVisualTimerRef.current = setTimeout(() => {
                setDesktopActionVisual(null)
                desktopActionVisualTimerRef.current = null
              }, 1_600)
            }
          }
          if (event.type === 'plan.preview') {
            setPendingInteractive((prev) => upsertPendingTaskApproval(prev, planPreviewToPendingTaskApproval(event)))
          }
          if (event.type === 'task.progress') {
            setSidePanelViews((prev) => ({ ...prev, [threadId]: 'task-progress' }))
          }
          if (
            event.type === 'tool.permission_timeout' ||
            (event.type === 'tool.failed' && event.error.message.includes('工具权限确认超时'))
          ) {
            const requestId = event.type === 'tool.permission_timeout' ? event.requestId : event.toolCallId
            setPendingInteractive((prev) => removePendingToolPermissionEverywhere(prev, requestId))
          }
          if (event.type === 'permission.resolved') {
            setPendingInteractive((prev) => removePendingToolPermissionEverywhere(prev, event.requestId))
          }
          if (
            event.type === 'assistant.delta' ||
            event.type === 'assistant.thinking_delta' ||
            event.type === 'tool.started' ||
            event.type === 'tool.completed' ||
            event.type === 'tool.failed' ||
            event.type === 'tool.permission_timeout' ||
            (event.type === 'task.progress' && event.status !== 'completed' && event.status !== 'failed' && event.status !== 'cancelled')
          ) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))
            break
          }
          if (event.type === 'task.progress' && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: event.status === 'failed' ? 'errored' : 'idle' }))
            break
          }
          if (
            event.type === 'context.compaction.started'
            || event.type === 'context.compaction.progress'
            || event.type === 'context.compaction.completed'
          ) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))
            break
          }
          if (event.type === 'run.completed' || event.type === 'run.turn_limited' || event.type === 'run.cancelled') {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
            break
          }
          if (event.type === 'run.failed') {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'errored' }))
            setErrorMessages((prev) => ({ ...prev, [threadId]: event.error.message }))
          }
          break
        }
        case AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED: {
          const { status } = params as AgentRuntimeStatusChangedEvent
          setRuntimeStatus((prev) => ({ ...prev, [status.threadId]: status }))
          break
        }
        case AGENT_IPC_CHANNELS.MESSAGE_QUEUE_CHANGED: {
          const snapshot = params as AgentMessageQueueSnapshot
          setMessageQueues((prev) => ({ ...prev, [snapshot.threadId]: snapshot }))
          break
        }
        case AGENT_IPC_CHANNELS.THREAD_LIST_CHANGED: {
          // 后端 thread-manager 在线程创建（含 Task/Delegate 子会话）后广播；
          // 主动刷新线程列表缓存，避免侧栏等母会话下一条消息才显示新子会话。
          void sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_THREADS)
            .then((result) => {
              setThreads(Array.isArray(result) ? result : [])
            })
            .catch((error) => {
              console.error('[useGlobalAgentListeners] 刷新线程列表失败 (THREAD_LIST_CHANGED)', error)
            })
          break
        }
        case DESKTOP_CONTEXT_IPC_CHANNELS.PROPOSAL_OPEN_REQUEST: {
          const proposalId = typeof (params as { proposalId?: unknown })?.proposalId === 'string'
            ? (params as { proposalId: string }).proposalId
            : ''
          if (!proposalId) break
          void sidecarCall<DesktopProactiveProposal[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS)
            .then((proposals) => {
              const next = buildDesktopProposalOpenRequestState({
                proposalId,
                proposals: Array.isArray(proposals) ? proposals : [],
                tabs,
                currentWorkspaceId,
              })
              if (!next) return
              setTabs(next.tabs)
              setWelcomePromptSeed(next.promptSeed)
              setActiveTabId(next.activeTabId)
              void sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_PROPOSAL, {
                id: next.proposal.id,
                status: 'opened',
              }).catch((error) => {
                console.error('[useGlobalAgentListeners] 标记桌面建议已打开失败:', error)
              })
            })
            .catch((error) => {
              console.error('[useGlobalAgentListeners] 打开桌面建议失败:', error)
            })
          break
        }
        case AGENT_IPC_CHANNELS.MESSAGE_APPENDED: {
          const event = params as AgentMessageAppendedEvent
          void sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_THREADS)
            .then((result) => {
              setThreads(Array.isArray(result) ? result : [])
            })
            .catch((error) => {
              console.error(`[useGlobalAgentListeners] 刷新线程列表失败: ${event.threadId}`, error)
            })
          void sidecarCall<AgentThreadRuntimeEventsResult>(AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS, { threadId: event.threadId })
            .then((result) => {
              setRuntimeEvents((prev) => hydrateRuntimeEvents(prev, result))
            })
            .catch((error) => {
              console.error(`[useGlobalAgentListeners] 刷新运行事件失败: ${event.threadId}`, error)
            })
          // 失效持久化消息缓存：sidecar 落盘了新消息，切回该会话时需重拉避免 stale
          threadMessagesCache.invalidate(event.threadId)
          break
        }
        case AGENT_IPC_CHANNELS.ASK_USER_QUESTION: {
          const req = params as AgentAskUserQuestionRequest
          setPendingInteractive((prev) => upsertPendingAskUserQuestion(prev, req))
          break
        }
        case AGENT_IPC_CHANNELS.BROWSER_AUTH_REQUEST: {
          const req = params as AgentBrowserAuthRequest
          setPendingInteractive((prev) => upsertPendingBrowserAuthRequest(prev, req))
          break
        }
        case AGENT_IPC_CHANNELS.DESKTOP_ACTION_REQUEST: {
          const req = params as AgentDesktopActionRequest
          setPendingInteractive((prev) => upsertPendingDesktopActionRequest(prev, req))
          break
        }
        case AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST: {
          const req = params as AgentToolPermissionRequest
          setPendingInteractive((prev) => upsertPendingToolPermission(prev, req))
          break
        }
        case AGENT_IPC_CHANNELS.SUBAGENT_COMPLETED: {
          const e = params as AgentSubagentCompletionEvent
          setSubagentRuns((prev) => {
            const runs = prev[e.threadId] ?? []
            const exists = runs.findIndex((r) => r.runId === e.runId)
            if (exists >= 0) {
              const updated = [...runs]
              updated[exists] = {
                ...updated[exists],
                status: e.status,
                outcome: {
                  ...(updated[exists].outcome ?? {}),
                  output: e.outputText ?? updated[exists].outcome?.output,
                  error: e.errorText ?? updated[exists].outcome?.error,
                },
                endedAt: Date.now(),
                updatedAt: Date.now(),
              }
              return { ...prev, [e.threadId]: updated }
            }
            // 未见过的 run：补齐一条最小化记录，尝试关联 pending tool_use
            const now = Date.now()
            const record = {
              runId: e.runId,
              parentThreadId: e.threadId,
              rootThreadId: e.threadId,
              depth: 0,
              childThreadId: e.childThreadId,
              parentToolUseId: e.parentToolUseId,
              label: e.label,
              task: e.label ?? '',
              status: e.status,
              cleanup: 'keep' as const,
              outcome: { output: e.outputText, error: e.errorText },
              createdAt: now,
              updatedAt: now,
              endedAt: now,
            }
            return { ...prev, [e.threadId]: [...runs, record] }
          })
          break
        }
        case AGENT_IPC_CHANNELS.SUBAGENT_WORK_CHANGED: {
          const event = params as AgentSubagentWorkChangedEvent
          void listSubagentWork(event.parentThreadId)
            .then((work) => setSubagentWork((prev) => ({ ...prev, [event.parentThreadId]: work })))
            .catch((error) => console.error('[useGlobalAgentListeners] 刷新 subagent work 失败:', error))
          break
        }
        case AGENT_IPC_CHANNELS.PLAN_MODE_PHASE_CHANGED: {
          const e = params as PlanModePhaseChangedEvent
          setPlanModePhase((prev) => ({ ...prev, [e.threadId]: e }))
          if (e.phase === 'awaiting_approval') {
            setSidePanelViews((prev) => prev[e.threadId] === 'task-progress' ? { ...prev, [e.threadId]: null } : prev)
          }
          if (e.phase === 'planning' || e.phase === 'executing' || e.phase === 'completed' || e.phase === 'idle') {
            setPendingInteractive((prev) => removePendingTaskApprovalsForThread(prev, e.threadId))
          }
          if (e.phase === 'planning' || e.phase === 'awaiting_approval') {
            void sidecarCall<AgentPendingInteractiveState[]>(AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE, { threadId: e.threadId })
              .then((states) => {
                setPendingInteractive((prev) => {
                  let next = prev
                  for (const state of states ?? []) {
                    for (const request of state.taskApprovals ?? []) {
                      next = upsertPendingTaskApproval(next, request)
                    }
                  }
                  return next
                })
              })
              .catch((error) => {
                console.error('[useGlobalAgentListeners] 刷新任务审批失败:', error)
              })
          }
          break
        }
        case AGENT_IPC_CHANNELS.TITLE_UPDATED: {
          const { threadId, title } = params as { threadId: string; title: string }
          setThreads((prev) => prev.map((t) => t.id === threadId ? { ...t, title } : t))
          setTabs((prev) => prev.map((tab) => (
            tab.type === 'agent' && (tab.id === threadId || tab.threadId === threadId)
              ? { ...tab, title }
              : tab
          )))
          break
        }
      }
    })
    return () => {
      unlisten.then((fn) => fn())
      if (runtimeEventsRafRef.current !== null) {
        cancelAnimationFrame(runtimeEventsRafRef.current)
        runtimeEventsRafRef.current = null
      }
      if (desktopActionVisualTimerRef.current) {
        clearTimeout(desktopActionVisualTimerRef.current)
        desktopActionVisualTimerRef.current = null
      }
      // flush 残留事件，避免卸载丢失最后一帧
      const batch = pendingRuntimeEventsRef.current
      if (batch.length > 0) {
        pendingRuntimeEventsRef.current = []
        setRuntimeEvents((prev) => appendRuntimeEvents(prev, batch))
      }
    }
  }, [setStreamingStates, setRuntimeStatus, setRuntimeEvents, setPendingInteractive, setMessageQueues, setSubagentRuns, setSubagentWork, setPlanModePhase, setThreads, setErrorMessages, setDesktopActionVisual, setSidePanelViews, setTabs, tabs, currentWorkspaceId, setActiveTabId, setWelcomePromptSeed, enqueueRuntimeEvent])
}
