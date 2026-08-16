import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { acknowledgeRendererDelivery, listSubagentWork, onSidecarEvent, onSuggestionsChanged, sidecarCall } from '@/lib/desktop-api'
import {
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentRuntimeEventsAtom,
  agentPendingInteractiveAtom,
  agentMessageQueueAtom,
  agentQueueInterruptedAtom,
  agentSubagentRunsAtom,
  agentSubagentWorkAtom,
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
  type AgentSubagentWorkChangedEvent,
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

/**
 * Batch 1 lifecycle 总线开关(与 sidecar 同 flag:AGENT_LIFECYCLE_EVENTS=1)。
 * web 是 Vite 渲染进程,经 vite envPrefix 暴露 AGENT_ 前缀变量读取——flag 需在
 * 启动 web dev server 与 desktop 的同一环境(根目录 `bun run dev`)中设置。
 * flag off:本文件零行为变化。
 */
const LIFECYCLE_BUS_ENABLED = import.meta.env.AGENT_LIFECYCLE_EVENTS === '1'

/**
 * flag on 时旧 RUNTIME_EVENT 分支跳过的试点链类型(试点线程内由 lifecycle 总线
 * 经适配器驱动,避免双写)。刻意不含:
 * - assistant.thinking_delta:总线批次1 不折叠 thinking,旧路是唯一来源
 * - run.cancelled:软中止无 result 终值、总线不产对应事件,旧路是唯一来源
 *   (含 Resume 横幅所需的 queue-interrupted 副作用)
 */
const LEGACY_SKIPPED_PILOT_EVENT_TYPES = new Set<string>([
  'assistant.delta',
  'assistant.final',
  'run.completed',
  'run.turn_limited',
  'run.failed',
  // 批次2 扩:tool 渲染同由 lifecycle 总线适配器驱动。
  'tool.started',
  'tool.completed',
  'tool.failed',
  // 批次3 扩:memory 引用展示由总线驱动(sidecar 第二注入路径双发,跳过旧路 live 避免双写;
  // 旧路 hydrate replay 版由投影 memory 分支 filter+push 幂等吸收,无需跳过)。
  'memory.context.used',
])

// 模块级而非 ref:适配器求差基线与去重水位须跨双挂载实例、跨 tab 切换存活
const lifecycleAdapterStatesByThread = new Map<string, LifecycleAdapterState>()
const lifecycleDeliveredSeqByThread = new Map<string, number>()

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
  const setSubagentWork = useSetAtom(agentSubagentWorkAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const setErrorMessages = useSetAtom(agentErrorMessagesAtom)
  const setDesktopActionVisual = useSetAtom(desktopActionVisualAtom)
  const setTabs = useSetAtom(tabsAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
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

  // ---- Batch 1 lifecycle 总线消费(flag on 时试点链切换到新总线,经适配器喂现有投影) ----
  // useGlobalAgentListeners 会被 App 与 QuickInput 同时挂载:两实例各自消费总线会导致
  // 同一 envelope 适配两次。用模块级 seq 水位去重(事件已按线程 seq 排序)。
  const lifecycleBusThreadId = LIFECYCLE_BUS_ENABLED
    ? tabs.find((tab) => tab.id === activeTabId && tab.type === 'agent')?.threadId ?? null
    : null
  const lifecycleBusThreadIdRef = useRef<string | null>(null)
  lifecycleBusThreadIdRef.current = lifecycleBusThreadId
  useAgentEventBus(lifecycleBusThreadId ?? '', {
    enabled: lifecycleBusThreadId !== null,
    onEvent: (envelope, source) => {
      // 快照回放不注入事件(旧路 hydrate 已覆盖,双份注入无法去重)、不置 streaming;
      // 详见 lifecycle-event-adapter.ts consumeBusEnvelope 注释。
      consumeBusEnvelope(envelope, source, {
        deliveredSeqByThread: lifecycleDeliveredSeqByThread,
        adapterStatesByThread: lifecycleAdapterStatesByThread,
        enqueueRuntimeEvent,
        setStreamingStates,
        setErrorMessages,
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
          // flag on 时试点线程的试点链类型改由 lifecycle 总线驱动,旧分支跳过避免双写
          if (LIFECYCLE_BUS_ENABLED && threadId === lifecycleBusThreadIdRef.current && LEGACY_SKIPPED_PILOT_EVENT_TYPES.has(event.type)) {
            break
          }
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
  }, [setStreamingStates, setRuntimeStatus, setRuntimeEvents, setPendingInteractive, setMessageQueues, setQueueInterrupted, setSubagentRuns, setSubagentWork, setPlanModePhase, setThreads, setErrorMessages, setDesktopActionVisual, setTabs, tabs, currentWorkspaceId, setActiveTabId, setWelcomePromptSeed, setSuggestionsVersion, setMemoryCenterVersion, enqueueRuntimeEvent])
}
