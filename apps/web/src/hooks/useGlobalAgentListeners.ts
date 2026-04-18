import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { onSidecarEvent } from '@/lib/desktop-api'
import {
  agentSDKMessagesAtom,
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentPendingInteractiveAtom,
  agentSubagentRunsAtom,
  agentSubagentMessagesAtom,
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
  SDKMessage,
} from '@lume/shared'

interface StreamingRef {
  uuid: string
  text: string
  thinking: string
}

function upsertStreamingMessage(
  prev: Record<string, SDKMessage[]>,
  threadId: string,
  ref: StreamingRef,
): Record<string, SDKMessage[]> {
  const syntheticMsg = {
    type: 'assistant',
    uuid: ref.uuid,
    message: {
      role: 'assistant',
      content: [
        ...(ref.thinking ? [{ type: 'thinking', thinking: ref.thinking }] : []),
        ...(ref.text ? [{ type: 'text', text: ref.text }] : []),
      ],
    },
  } as unknown as SDKMessage
  const existing = prev[threadId] ?? []
  const idx = existing.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
  if (idx >= 0) {
    const updated = [...existing]
    updated[idx] = syntheticMsg
    return { ...prev, [threadId]: updated }
  }
  return { ...prev, [threadId]: [...existing, syntheticMsg] }
}

function appendSubagentMessage(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  msg: SDKMessage,
): Record<string, Record<string, SDKMessage[]>> {
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  return {
    ...prev,
    [threadId]: { ...threadMap, [runId]: [...messages, msg] },
  }
}

function upsertSubagentStreaming(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  ref: StreamingRef,
): Record<string, Record<string, SDKMessage[]>> {
  const syntheticMsg = {
    type: 'assistant',
    uuid: ref.uuid,
    message: {
      role: 'assistant',
      content: [
        ...(ref.thinking ? [{ type: 'thinking', thinking: ref.thinking }] : []),
        ...(ref.text ? [{ type: 'text', text: ref.text }] : []),
      ],
    },
  } as unknown as SDKMessage
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  const idx = messages.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
  if (idx >= 0) {
    const updated = [...messages]
    updated[idx] = syntheticMsg
    return { ...prev, [threadId]: { ...threadMap, [runId]: updated } }
  }
  return { ...prev, [threadId]: { ...threadMap, [runId]: [...messages, syntheticMsg] } }
}

function replaceSubagentStreaming(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  ref: StreamingRef | undefined,
  msg: SDKMessage,
): Record<string, Record<string, SDKMessage[]>> {
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  if (ref) {
    const idx = messages.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
    if (idx >= 0) {
      const updated = [...messages]
      updated[idx] = msg
      return { ...prev, [threadId]: { ...threadMap, [runId]: updated } }
    }
  }
  return { ...prev, [threadId]: { ...threadMap, [runId]: [...messages, msg] } }
}

export function useGlobalAgentListeners() {
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setSubagentMessages = useSetAtom(agentSubagentMessagesAtom)
  const setPlanState = useSetAtom(agentPlanStateAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)

  const streamingRef = useRef<Record<string, StreamingRef>>({})
  const subagentStreamingRef = useRef<Record<string, StreamingRef>>({})
  const pendingAgentToolUseRef = useRef<Record<string, string[]>>({})

  useEffect(() => {
    const unlisten = onSidecarEvent((method, params) => {
      switch (method) {
        case 'agent:stream:event': {
          const e = params as AgentStreamEvent
          const msg = e.message
          const streamKey = e.threadId
          const runId = (msg as { subagent_run_id?: string }).subagent_run_id

          // === Subagent message routing ===
          if (runId) {
            // First event for this runId → link to pending Agent tool_use
            const pending = pendingAgentToolUseRef.current[streamKey]
            if (pending && pending.length > 0) {
              const toolUseId = pending.shift()!
              setSubagentRuns((prev) => {
                const runs = prev[streamKey] ?? []
                const exists = runs.findIndex((r) => r.runId === runId)
                if (exists >= 0) {
                  if (!runs[exists].parentToolUseId) {
                    const updated = [...runs]
                    updated[exists] = { ...updated[exists], parentToolUseId: toolUseId }
                    return { ...prev, [streamKey]: updated }
                  }
                  return prev
                }
                const now = Date.now()
                const record = {
                  runId,
                  parentThreadId: streamKey,
                  rootThreadId: streamKey,
                  depth: 0,
                  childThreadId: '',
                  task: '',
                  status: 'running' as const,
                  cleanup: 'keep' as const,
                  parentToolUseId: toolUseId,
                  createdAt: now,
                  updatedAt: now,
                }
                return { ...prev, [streamKey]: [...runs, record] }
              })
            }

            const subStreamKey = `${streamKey}:${runId}`

            if (msg.type === 'stream_event') {
              const event = (msg as unknown as Record<string, unknown>).event as Record<string, unknown> | undefined
              const delta = event?.delta as Record<string, unknown> | undefined
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                const ref = subagentStreamingRef.current[subStreamKey] ?? { uuid: `sub-streaming:${subStreamKey}:${Date.now()}`, text: '', thinking: '' }
                ref.text += delta.text as string
                subagentStreamingRef.current[subStreamKey] = ref
                setSubagentMessages((prev) => upsertSubagentStreaming(prev, streamKey, runId, ref))
              }
              if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                const ref = subagentStreamingRef.current[subStreamKey] ?? { uuid: `sub-streaming:${subStreamKey}:${Date.now()}`, text: '', thinking: '' }
                ref.thinking += delta.thinking as string
                subagentStreamingRef.current[subStreamKey] = ref
                setSubagentMessages((prev) => upsertSubagentStreaming(prev, streamKey, runId, ref))
              }
              setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
              break
            }

            if (msg.type === 'assistant') {
              const ref = subagentStreamingRef.current[subStreamKey]
              setSubagentMessages((prev) => replaceSubagentStreaming(prev, streamKey, runId, ref, msg))
              delete subagentStreamingRef.current[subStreamKey]
              setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
              break
            }

            if (msg.type === 'tool_result') {
              setSubagentMessages((prev) => appendSubagentMessage(prev, streamKey, runId, msg))
              setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
              break
            }

            // partial_message and other types → skip for subagent
            break
          }

          // === Main thread messages (no subagent_run_id) ===

          // Streaming text/thinking deltas → accumulate into synthetic assistant message
          if (msg.type === 'stream_event') {
            const event = (msg as unknown as Record<string, unknown>).event as Record<string, unknown> | undefined
            const delta = event?.delta as Record<string, unknown> | undefined
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              const ref = streamingRef.current[streamKey] ?? { uuid: `streaming:${streamKey}:${Date.now()}`, text: '', thinking: '' }
              ref.text += delta.text as string
              streamingRef.current[streamKey] = ref
              setSDKMessages((prev) => upsertStreamingMessage(prev, streamKey, ref))
            }
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              const ref = streamingRef.current[streamKey] ?? { uuid: `streaming:${streamKey}:${Date.now()}`, text: '', thinking: '' }
              ref.thinking += delta.thinking as string
              streamingRef.current[streamKey] = ref
              setSDKMessages((prev) => upsertStreamingMessage(prev, streamKey, ref))
            }
            setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
            break
          }

          // Full assistant message → replace synthetic streaming message
          if (msg.type === 'assistant') {
            // Track Agent tool_use blocks for subagent mapping
            const content = (msg as { message?: { content?: unknown[] } }).message?.content
            if (Array.isArray(content)) {
              for (const block of content as Array<{ type: string; name?: string; id?: string }>) {
                if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
                  const queue = pendingAgentToolUseRef.current[streamKey] ?? []
                  queue.push(block.id)
                  pendingAgentToolUseRef.current[streamKey] = queue
                }
              }
            }

            const ref = streamingRef.current[streamKey]
            if (ref) {
              setSDKMessages((prev) => {
                const existing = prev[streamKey] ?? []
                const idx = existing.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
                if (idx >= 0) {
                  const updated = [...existing]
                  updated[idx] = msg
                  return { ...prev, [streamKey]: updated }
                }
                return { ...prev, [streamKey]: [...existing, msg] }
              })
              delete streamingRef.current[streamKey]
            } else {
              setSDKMessages((prev) => ({
                ...prev,
                [streamKey]: [...(prev[streamKey] ?? []), msg],
              }))
            }
            setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
            break
          }

          // Skip partial_message — already handled via stream_event deltas
          if (msg.type === 'partial_message') {
            break
          }

          // Other message types (system, tool_result, result, etc.) → append
          setSDKMessages((prev) => ({
            ...prev,
            [streamKey]: [...(prev[streamKey] ?? []), msg],
          }))
          setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
          break
        }
        case 'agent:stream:complete': {
          const { threadId } = params as { threadId: string }
          delete streamingRef.current[threadId]
          // Clean up subagent streaming refs for this thread
          for (const key of Object.keys(subagentStreamingRef.current)) {
            if (key.startsWith(`${threadId}:`)) {
              delete subagentStreamingRef.current[key]
            }
          }
          setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
          break
        }
        case 'agent:stream:error': {
          const { threadId, error } = params as { threadId: string; error?: string }
          delete streamingRef.current[threadId]
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
  }, [setSDKMessages, setStreamingStates, setRuntimeStatus, setPendingInteractive, setSubagentRuns, setSubagentMessages, setPlanState, setThreads, setErrorMessages])
}
