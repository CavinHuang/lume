import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { onSidecarEvent, sidecarCall } from '@/lib/desktop-api'
import {
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentRunEventsAtom,
  agentPendingInteractiveAtom,
  agentSubagentRunsAtom,
  agentPlanStateAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
  agentSidePanelViewAtom,
} from '@/atoms'
import {
  AGENT_IPC_CHANNELS,
  type AgentPendingInteractiveState,
  type AgentRunEventNotification,
  type AgentRuntimeStatusChangedEvent,
  type AgentAskUserQuestionRequest,
  type AgentToolPermissionRequest,
  type AgentSubagentCompletionEvent,
  type PlanStateChangedEvent,
} from '@lume/shared'
import {
  upsertPendingAskUserQuestion,
  upsertPendingPlanApproval,
  upsertPendingToolPermission,
} from './pending-interactive-state'
import { appendRunEvent } from './run-event-state'

export function useGlobalAgentListeners() {
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setRunEvents = useSetAtom(agentRunEventsAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setPlanState = useSetAtom(agentPlanStateAtom)
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
            for (const request of state.planApprovals ?? []) {
              next = upsertPendingPlanApproval(next, request)
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
        case AGENT_IPC_CHANNELS.RUN_EVENT: {
          const notification = params as AgentRunEventNotification
          const { threadId, event } = notification
          setRunEvents((prev) => appendRunEvent(prev, notification))
          if (
            event.type === 'assistant_delta' ||
            event.type === 'assistant_thinking_delta' ||
            event.type === 'tool_call_started' ||
            event.type === 'tool_call_completed' ||
            (event.type === 'plan_progress' && event.status !== 'completed' && event.status !== 'failed') ||
            (event.type === 'plan_execution_status' && event.status === 'running')
          ) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))
            break
          }
          if (event.type === 'plan_progress' && (event.status === 'completed' || event.status === 'failed')) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: event.status === 'failed' ? 'errored' : 'idle' }))
            break
          }
          if (event.type === 'plan_execution_status' && (event.status === 'waiting' || event.status === 'completed' || event.status === 'failed')) {
            setStreamingStates((prev) => ({ ...prev, [threadId]: event.status === 'failed' ? 'errored' : 'idle' }))
            break
          }
          if (event.type === 'run_completed') {
            setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
            break
          }
          if (event.type === 'run_failed') {
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
        case AGENT_IPC_CHANNELS.PLAN_STATE_CHANGED: {
          const e = params as PlanStateChangedEvent
          setPlanState((prev) => ({ ...prev, [e.threadId]: e }))
          if (e.phase === 'planning' || e.phase === 'review') {
            setSidePanelViews((prev) => ({ ...prev, [e.threadId]: 'plan' }))
            void sidecarCall<AgentPendingInteractiveState[]>(AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE, { threadId: e.threadId })
              .then((states) => {
                setPendingInteractive((prev) => {
                  let next = prev
                  for (const state of states ?? []) {
                    for (const request of state.planApprovals ?? []) {
                      next = upsertPendingPlanApproval(next, request)
                    }
                  }
                  return next
                })
              })
              .catch((error) => {
                console.error('[useGlobalAgentListeners] 刷新 plan approval 失败:', error)
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
  }, [setStreamingStates, setRuntimeStatus, setRunEvents, setPendingInteractive, setSubagentRuns, setPlanState, setThreads, setErrorMessages, setSidePanelViews])
}
