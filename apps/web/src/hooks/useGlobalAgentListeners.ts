import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { onSidecarEvent, sidecarCall } from '@/lib/desktop-api'
import {
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentRuntimeEventsAtom,
  agentPendingInteractiveAtom,
  agentSubagentRunsAtom,
  agentPlanModePhaseAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
  agentSidePanelViewAtom,
} from '@/atoms'
import {
  AGENT_IPC_CHANNELS,
  type AgentPendingInteractiveState,
  type AgentRuntimeEventNotification,
  type AgentRuntimeStatusChangedEvent,
  type AgentAskUserQuestionRequest,
  type AgentToolPermissionRequest,
  type AgentSubagentCompletionEvent,
  type PlanModePhaseChangedEvent,
} from '@lume/shared'
import {
  planPreviewToPendingTaskApproval,
  removePendingToolPermissionEverywhere,
  removePendingTaskApprovalsForThread,
  upsertPendingAskUserQuestion,
  upsertPendingTaskApproval,
  upsertPendingToolPermission,
} from './pending-interactive-state'
import { appendRuntimeEvent } from './runtime-event-state'

export function useGlobalAgentListeners() {
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)
  const setSidePanelViews = useSetAtom(agentSidePanelViewAtom)

  useEffect(() => {
    sidecarCall<AgentPendingInteractiveState[]>(AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE)
      .then((states) => {
        setPendingInteractive((prev) => {
          let next = prev
          for (const state of states ?? []) {
            for (const request of state.askUserQuestions ?? []) {
              next = upsertPendingAskUserQuestion(next, request)
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
          setRuntimeEvents((prev) => appendRuntimeEvent(prev, event))
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
        case AGENT_IPC_CHANNELS.ASK_USER_QUESTION: {
          const req = params as AgentAskUserQuestionRequest
          setPendingInteractive((prev) => upsertPendingAskUserQuestion(prev, req))
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
          break
        }
      }
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [setStreamingStates, setRuntimeStatus, setRuntimeEvents, setPendingInteractive, setSubagentRuns, setPlanModePhase, setThreads, setErrorMessages, setSidePanelViews])
}
