import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { acknowledgeRendererDelivery, onSidecarEvent, onSuggestionsChanged, sidecarCall } from '@/lib/desktop-api'
import {
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentRuntimeEventsAtom,
  agentPendingInteractiveAtom,
  agentMessageQueueAtom,
  agentQueueInterruptedAtom,
  agentSubagentRunsAtom,
  agentPlanModePhaseAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
  desktopActionVisualAtom,
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  welcomePromptSeedAtom,
  suggestionsVersionAtom,
  memoryCenterVersionAtom,
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
  type AgentDesktopActionRequest,
  type AgentToolPermissionRequest,
  type AgentSubagentCompletionEvent,
  type AgentMessageQueueSnapshot,
  type AgentListSubagentRunsResult,
  type SubagentRunRecord,
  type PlanModePhaseChangedEvent,
  type LumeRuntimeEvent,
  type DesktopProactiveProposal,
} from '@lume/shared'
import {
  removePendingToolPermissionEverywhere,
  upsertPendingAskUserQuestion,
  upsertPendingDesktopActionRequest,
  upsertPendingToolPermission,
} from './pending-interactive-state'
import { appendRuntimeEvents, hydrateRuntimeEvents } from './runtime-event-state'
import { projectDesktopActionVisualEvent } from './desktop-action-visual-state'
import { consumeBusEnvelope, type LifecycleAdapterState } from './lifecycle-event-adapter'
import { useAgentEventBus } from './useAgentEventBus'

// T7c(批次5 删除批):AGENT_LIFECYCLE_EVENTS flag 已退役——总线消费恒开
// (active agent tab 即订阅);T7a 已删 LEGACY_SKIPPED_PILOT_EVENT_TYPES 跳过清单
// (已迁类旧路产生点已删,RUNTIME_EVENT 不再送达已迁类)。保留类
// (message.user.submitted/plan.preview/task.progress/usage.updated/model.retry 系/
// memory.changed 系/交互对等)旧路分支原样。

// 模块级而非 ref:适配器求差基线与去重水位须跨双挂载实例、跨 tab 切换存活
const lifecycleAdapterStatesByThread = new Map<string, LifecycleAdapterState>()
const lifecycleDeliveredSeqByThread = new Map<string, number>()

/** 线程删除时释放其 lifecycle 适配器基线（含 lastText/lastThinking 累计全文），防止 Map 只增不减。 */
export function releaseThreadLifecycleState(threadId: string): void {
  lifecycleAdapterStatesByThread.delete(threadId)
  lifecycleDeliveredSeqByThread.delete(threadId)
}

export function hydrateSubagentRuns(
  current: Record<string, SubagentRunRecord[]>,
  runs: SubagentRunRecord[],
): Record<string, SubagentRunRecord[]> {
  let next = current
  for (const run of runs) {
    const currentRuns = next[run.parentThreadId] ?? []
    const index = currentRuns.findIndex((item) => item.runId === run.runId)
    if (index >= 0 && currentRuns[index].updatedAt >= run.updatedAt) continue
    if (next === current) next = { ...current }
    next[run.parentThreadId] = index < 0
      ? [...currentRuns, run]
      : currentRuns.map((item, itemIndex) => itemIndex === index ? run : item)
  }
  return next
}

export function useGlobalAgentListeners() {
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom)
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const setMessageQueues = useSetAtom(agentMessageQueueAtom)
  const messageQueues = useAtomValue(agentMessageQueueAtom)
  const messageQueuesRef = useRef(messageQueues)
  messageQueuesRef.current = messageQueues
  const setQueueInterrupted = useSetAtom(agentQueueInterruptedAtom)
  const setSubagentRuns = useSetAtom(agentSubagentRunsAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)
  const setDesktopActionVisual = useSetAtom(desktopActionVisualAtom)
  const setTabs = useSetAtom(tabsAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  // 监听 handler 内经 ref 读取：effect deps 含 tabs/currentWorkspaceId 会让
  // 全局订阅随切 tab/标题更新高频退订重订，退订-重订间隙的保留类事件可丢（#409）
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const currentWorkspaceIdRef = useRef(currentWorkspaceId)
  currentWorkspaceIdRef.current = currentWorkspaceId
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const setSuggestionsVersion = useSetAtom(suggestionsVersionAtom)
  const setMemoryCenterVersion = useSetAtom(memoryCenterVersionAtom)

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

  // ---- lifecycle 总线消费(T7c 起恒开:active agent tab 即订阅,经适配器喂现有投影) ----
  // useGlobalAgentListeners 会被 App 与 QuickInput 同时挂载:两实例各自消费总线会导致
  // 同一 envelope 适配两次。用模块级 seq 水位去重(事件已按线程 seq 排序)。
  const lifecycleBusThreadId = tabs.find((tab) => tab.id === activeTabId && tab.type === 'agent')?.threadId ?? null
  useAgentEventBus(lifecycleBusThreadId ?? '', {
    enabled: lifecycleBusThreadId !== null,
    onEvent: (envelope, source) => {
      // F4:快照回放注入事件(新线程 assistant/tool/run 历史单读总线快照,旧路
      // hydrate 已过滤已迁类)、不置 streaming;
      // 详见 lifecycle-event-adapter.ts consumeBusEnvelope 注释。
      consumeBusEnvelope(envelope, source, {
        deliveredSeqByThread: lifecycleDeliveredSeqByThread,
        adapterStatesByThread: lifecycleAdapterStatesByThread,
        enqueueRuntimeEvent,
        setStreamingStates,
        setErrorMessages,
        // 批次5:run.cancelled 被跳过清单接管后,queue-interrupted(Resume 横幅)副作用
        // 移至总线版——与旧路 RUNTIME_EVENT 分支同逻辑(队列非空才置位,幂等不重复置)
        onRunCancelled: (threadId) => {
          const queue = messageQueuesRef.current[threadId]
          if (queue && queue.queuedMessages.some((item) => !item.internal)) {
            setQueueInterrupted((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }))
          }
        },
      })
    },
  })

  useEffect(() => {
    sidecarCall<AgentListSubagentRunsResult>(AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS, { limit: 500 })
      .then((result) => {
        setSubagentRuns((current) => hydrateSubagentRuns(current, result.runs ?? []))
      })
      .catch((error) => {
        console.error('[useGlobalAgentListeners] 恢复 subagent runs 失败:', error)
      })

    sidecarCall<AgentPendingInteractiveState[]>(AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE)
      .then((states) => {
        setPendingInteractive((prev) => {
          let next = prev
          for (const state of states ?? []) {
            for (const request of state.askUserQuestions ?? []) {
              next = upsertPendingAskUserQuestion(next, request)
            }
            for (const request of state.desktopActionRequests ?? []) {
              next = upsertPendingDesktopActionRequest(next, request)
            }
            for (const request of state.toolPermissions ?? []) {
              next = upsertPendingToolPermission(next, request)
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
          if (event.type === 'memory.changed' || event.type === 'memory.job.progress' || event.type === 'memory.job.completed') {
            setMemoryCenterVersion((version) => version + 1)
          }
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
          if (event.type === 'tool.permission_timeout') {
            setPendingInteractive((prev) => removePendingToolPermissionEverywhere(prev, event.requestId))
          }
          // #560:MCP 连接失败等运行环境警告投影——原本只进 system prompt 用户不可见
          if (event.type === 'runtime.warning') {
            toast.warning(event.message)
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
          if (event.type === 'background.task.completed') {
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
            // 队列因中断(STOP)暂停:run.cancelled 且队列非空时置 interrupted,驱动 Resume 横幅。
            if (event.type === 'run.cancelled') {
              const queue = messageQueuesRef.current[threadId]
              if (queue && queue.queuedMessages.some((item) => !item.internal)) {
                setQueueInterrupted((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }))
              }
            }
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
          // paused 权威源在 sidecar(kernel);snapshot.paused 驱动 Resume 横幅(刷新可恢复)。
          const nextPaused = snapshot.paused === true
          setQueueInterrupted((prev) => {
            const cur = prev[snapshot.threadId] === true
            if (cur === nextPaused) return prev
            return { ...prev, [snapshot.threadId]: nextPaused }
          })
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
                tabs: tabsRef.current,
                currentWorkspaceId: currentWorkspaceIdRef.current,
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
              if (event.message.role === 'assistant' && event.deliveryAttemptId) {
                requestAnimationFrame(() => {
                  void acknowledgeRendererDelivery(event)
                })
              }
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
        case AGENT_IPC_CHANNELS.PLAN_MODE_PHASE_CHANGED: {
          const e = params as PlanModePhaseChangedEvent
          setPlanModePhase((prev) => ({ ...prev, [e.threadId]: e }))
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
    // sidecar 推送的建议变更信号 → bump 版本号 → 消费方（建议列表 / Banner，
    // Task 14+）订阅 suggestionsVersionAtom 触发 suggestion:list 重拉。
    const unlistenSuggestions = onSuggestionsChanged(() => {
      setSuggestionsVersion((v) => v + 1)
    })
    return () => {
      unlisten.then((fn) => fn())
      unlistenSuggestions.then((fn) => fn())
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
  }, [setStreamingStates, setRuntimeStatus, setRuntimeEvents, setPendingInteractive, setMessageQueues, setQueueInterrupted, setSubagentRuns, setPlanModePhase, setThreads, setErrorMessages, setDesktopActionVisual, setTabs, setActiveTabId, setWelcomePromptSeed, setSuggestionsVersion, setMemoryCenterVersion, enqueueRuntimeEvent])
}
