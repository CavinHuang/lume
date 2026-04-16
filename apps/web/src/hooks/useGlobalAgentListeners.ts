import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { onSidecarEvent } from '@/lib/desktop-api'
import {
  agentSDKMessagesAtom,
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentPendingInteractiveAtom,
  agentSubagentRunsAtom,
  agentPlanStateAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
} from '@/atoms'
import type {
  AgentStreamEvent,
  AgentRuntimeStatusChangedEvent,
  AgentAskUserQuestionRequest,
  AgentToolPermissionRequest,
  AgentSubagentCompletionEvent,
  PlanStateChangedEvent,
} from '@lume/shared'

export function useGlobalAgentListeners() {
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setPlanState = useSetAtom(agentPlanStateAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)

  useEffect(() => {
    const unlisten = onSidecarEvent((method, params) => {
      switch (method) {
        case 'agent:stream:event': {
          const e = params as AgentStreamEvent
          setSDKMessages((prev) => ({
            ...prev,
            [e.threadId]: [...(prev[e.threadId] ?? []), e.message],
          }))
          setStreamingStates((prev) => ({ ...prev, [e.threadId]: 'streaming' }))
          break
        }
        case 'agent:stream:complete': {
          const { threadId } = params as { threadId: string }
          setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
          break
        }
        case 'agent:stream:error': {
          const { threadId, error } = params as { threadId: string; error?: string }
          setStreamingStates((prev) => ({ ...prev, [threadId]: 'errored' }))
          if (error) {
            setErrorMessages((prev) => ({ ...prev, [threadId]: error }))
          }
          break
        }
        case 'agent:runtime-status-changed': {
          const { status } = params as AgentRuntimeStatusChangedEvent
          setRuntimeStatus((prev) => ({ ...prev, [status.threadId]: status }))
          break
        }
        case 'agent:ask-user-question': {
          const req = params as AgentAskUserQuestionRequest
          setPendingInteractive((prev) => ({
            ...prev,
            [req.threadId]: { ...prev[req.threadId], threadId: req.threadId, askUserQuestion: req },
          }))
          break
        }
        case 'agent:tool-permission-request': {
          const req = params as AgentToolPermissionRequest
          setPendingInteractive((prev) => ({
            ...prev,
            [req.threadId]: { ...prev[req.threadId], threadId: req.threadId, toolPermission: req },
          }))
          break
        }
        case 'agent:subagent-completed': {
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
            // 未见过的 run：补齐一条最小化记录
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
        case 'agent:plan-state-changed': {
          const e = params as PlanStateChangedEvent
          setPlanState((prev) => ({ ...prev, [e.threadId]: e }))
          break
        }
        case 'agent:title-updated': {
          const { threadId, title } = params as { threadId: string; title: string }
          setThreads((prev) => prev.map((t) => t.id === threadId ? { ...t, title } : t))
          break
        }
      }
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [setSDKMessages, setStreamingStates, setRuntimeStatus, setPendingInteractive, setSubagentRuns, setPlanState, setThreads, setErrorMessages])
}
