import type { FileReferenceBinding, FileReferenceProtocolVersion, LumeRuntimeEvent, RuntimeCodingReport } from '@lume/shared'
import { isDelegationToolName } from './subagent-run-projection'
import type {
  RuntimeAssistantBlock,
  RuntimeAssistantMessageView,
  RuntimeAssistantTokenUsageView,
  RuntimeMessageView,
  RuntimeToolCallView,
} from './runtime-message-view'

// #566:turn_limited 后系统可能自动续跑，不再指示用户手动「继续」（自动续跑未生效时下一条用户消息同样会经恢复上下文接续）
export const TURN_LIMIT_NOTICE = '本轮已达到最大执行轮次，当前进度已保存。'

export interface ProjectionState {
  messages: RuntimeMessageView[]
  currentAssistant: MutableAssistantMessage | null
  terminalClosed: boolean
  // per-runId 的 compaction 段计数：compaction 把同一 run 的 assistant 内容切成多段，
  // 重建的 assistant 必须用唯一 id（见 assistantIdFor），避免与已 flush 的同 runId 消息
  // id 冲突 → AgentMessages 列表 React key 撞车（duplicate/omit + 跳变）。
  assistantSegmentByRun: Map<string, number>
  /** One stable divider per run; compaction progress updates it in place. */
  compactionMessageByRun: Map<string, string>
  fileReferenceBinding?: FileReferenceBinding
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion
  /**
   * #566:待收回的「已达上限」提示——turn_limited 后系统可能自动续跑；若同一链的
   * run.started 随后到达（期间无用户消息），剥掉该提示尾缀，避免给用户假信号。
   * 用户消息插入则保留提示（手动继续场景提示仍然成立）。
   */
  pendingTurnLimitNotice?: { messageId: string; noticeLength: number } | null
}

/**
 * 同一 run 内 compaction 后重建的 assistant 用唯一 id：`assistant:${runId}:c${seg}`。
 * 首段（seg=0）保持原 `assistant:${runId}`，向后兼容既有 stabilize cache / 测试快照。
 * 段切换使 React key 变化 → 该 assistant 消息 remount 是有意为之（commit 4c940848）：
 * 防 key 撞车优先于保留 DOM 连续性，丝滑重构计划不动此处。
 */
function assistantIdFor(state: ProjectionState, runId: string): string {
  const segment = state.assistantSegmentByRun.get(runId) ?? 0
  return segment > 0 ? `assistant:${runId}:c${segment}` : `assistant:${runId}`
}

export function projectRuntimeEventMessages(events: LumeRuntimeEvent[]): RuntimeMessageView[] {
  const kept = keepLatestVersionTurns(events)
  const state: ProjectionState = {
    messages: [],
    currentAssistant: null,
    terminalClosed: false,
    assistantSegmentByRun: new Map(),
    compactionMessageByRun: new Map(),
  }
  for (const event of kept) {
    applyRuntimeEvent(state, event)
  }
  flushAssistant(state.messages, state.currentAssistant)
  return state.messages
}

export function applyRuntimeEvent(state: ProjectionState, event: LumeRuntimeEvent): void {
  const { messages } = state
  if (event.fileReferenceBinding) {
    state.fileReferenceBinding = event.fileReferenceBinding
    if (state.currentAssistant) state.currentAssistant.fileReferenceBinding = event.fileReferenceBinding
  }
  if (event.fileReferenceProtocolVersion) {
    state.fileReferenceProtocolVersion = event.fileReferenceProtocolVersion
    if (state.currentAssistant) state.currentAssistant.fileReferenceProtocolVersion = event.fileReferenceProtocolVersion
  }

  // T7c:双路并行期入口闸门(TERMINAL_REBUILDING_EVENT_TYPES)+[lifecycle-mismatch] 打点已删
  // ——双投源消失。其余重建型分支(model.retry/assistant.*/tool.*/plan/todo/run 终值)
  // 仍由下方 terminalClosed 通用早退兜底;memory.context.used/advisor.reviewed 两分支
  // 因位于通用早退之前,各自保留最小防线(见分支内注释)。

  if (event.type === 'run.started') {
    retractPendingTurnLimitNotice(state)
    state.terminalClosed = false
    return
  }

  if (event.type === 'message.user.submitted') {
    state.pendingTurnLimitNotice = null
    flushAssistant(state.messages, state.currentAssistant)
    messages.push({
      id: event.messageId ?? `user:${event.createdAt}`,
      type: 'user',
      text: event.text,
      createdAt: event.createdAt,
      ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      ...(event.commentAttachments?.length ? { commentAttachments: event.commentAttachments } : {}),
      ...(event.messageParts ? { messageParts: event.messageParts } : {}),
      ...(event.capabilityReferences ? { capabilityReferences: event.capabilityReferences } : {}),
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.versionGroupId ? { versionGroupId: event.versionGroupId } : {}),
      ...(typeof event.versionIndex === 'number' ? { versionIndex: event.versionIndex } : {}),
      ...(typeof event.versionCount === 'number' ? { versionCount: event.versionCount } : {}),
    })
    state.currentAssistant = createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.terminalClosed = false
    return
  }

  if (event.type === 'task.progress') {
    if (state.terminalClosed || !state.currentAssistant) {
      state.currentAssistant = createBoundAssistant(state, `assistant:task:${event.taskRunId}:${event.runId}`)
    }
    state.terminalClosed = false
    state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block) => block.type !== 'task_progress')
    state.currentAssistant.blocks.push({
      type: 'task_progress',
      id: `task:${event.taskRunId}:${event.createdAt}`,
      event,
    })
    recomputeAssistantContent(state.currentAssistant)
    return
  }

  if (event.type === 'memory.context.used') {
    if (event.items.length === 0) return
    // 终态后到达的尾巴事件不得经 ??= 重建同 id 的空 assistant(会与已 flush 的
    // assistant:<runId> 撞 React key,#22 duplicate key 的实际路径)。T7c 入口闸门
    // 退役后保留此最小防线:历史 events.jsonl 双域回放与 hydrate replay 中已迁类
    // (本类+advisor.reviewed)仍可能终态后到达(位于下方通用早退之前,需自守)。
    if (state.terminalClosed && !state.currentAssistant) return
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block) => block.type !== 'memory_context_used')
    state.currentAssistant.blocks.push({
      type: 'memory_context_used',
      id: `memory:${event.runId}:${event.createdAt}`,
      event,
    })
    return
  }

  if (event.type === 'memory.changed') {
    flushAssistant(state.messages, state.currentAssistant)
    state.currentAssistant = null
    // 幂等 upsert：live 补发与 replay 重放可能携带同 id（见 consolidation/replay 的 id 公式），
    // 无条件 push 会在刷新后突现重复的幽灵消息。
    const message: RuntimeMessageView = {
      id: event.id,
      type: 'system',
      variant: 'memory_saved',
      status: 'completed',
      text: event.summary,
      createdAt: event.createdAt,
      workspaceSlug: event.workspaceSlug,
      details: event.details,
      target: {
        section: 'memory',
        workspaceSlug: event.workspaceSlug,
        libraryView: 'recent',
        ...(event.memoryIds[0] ? { memoryId: event.memoryIds[0] } : {}),
        ...(event.mutationIds[0] ? { mutationId: event.mutationIds[0] } : {}),
      },
    }
    const existingIndex = messages.findIndex((item) => item.id === event.id)
    if (existingIndex >= 0) messages[existingIndex] = message
    else messages.push(message)
    return
  }

  if (event.type === 'memory.job.progress' || event.type === 'memory.job.completed') {
    flushAssistant(state.messages, state.currentAssistant)
    state.currentAssistant = null
    const id = `memory-job:${event.jobId}`
    const message: RuntimeMessageView = {
      id,
      type: 'system',
      variant: 'memory_job',
      status: event.type === 'memory.job.progress' ? 'active' : 'completed',
      text: event.type === 'memory.job.progress'
        ? `${event.phase} · ${event.processedItems}/${event.scannedItems}`
        : event.summary,
      createdAt: event.createdAt,
      target: { section: 'activity', jobId: event.jobId },
    }
    const existingIndex = messages.findIndex((item) => item.id === id)
    if (existingIndex >= 0) messages[existingIndex] = message
    else messages.push(message)
    return
  }

  if (event.type === 'advisor.reviewed') {
    // 同 memory.context.used:终态后的 advisor 尾巴不重建同 id assistant(T7c 闸门
    // 退役后的最小防线,理由见 memory.context.used 分支注释)。
    if (state.terminalClosed && !state.currentAssistant) return
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.blocks.push({
      type: 'advisor_review',
      id: `advisor:${event.runId}:${event.createdAt}`,
      event,
    })
    return
  }

  if (
    event.type === 'context.compaction.started'
    || event.type === 'context.compaction.progress'
    || event.type === 'context.compaction.completed'
  ) {
    if (state.currentAssistant && assistantHasContent(state.currentAssistant)) {
      flushAssistant(state.messages, state.currentAssistant)
      // 前段已 flush 为独立消息：递增段号，使 compaction 后同 runId 重建的 assistant 用唯一 id
      // （`assistant:${runId}:c${seg}`），避免与刚 flush 的消息 id 冲突 → AgentMessages React key 撞车。
      state.assistantSegmentByRun.set(
        event.runId,
        (state.assistantSegmentByRun.get(event.runId) ?? 0) + 1,
      )
    }
    state.currentAssistant = null
    appendContextCompactionNotice(state, event)
    state.terminalClosed = false
    return
  }

  if (event.type === 'usage.updated') {
    if (event.scope !== 'main') return
    applyAssistantProviderTokenUsage(state.messages, state.currentAssistant, {
      inputTokens: firstFiniteNumber(event.billing.latestRecord?.inputTokens, event.billing.cumulative.inputTokens),
      outputTokens: firstFiniteNumber(event.billing.latestRecord?.outputTokens, event.billing.cumulative.outputTokens),
      cacheReadInputTokens: firstFiniteNumber(event.billing.latestRecord?.cacheReadInputTokens, event.billing.cumulative.cacheReadInputTokens),
      cacheCreationInputTokens: firstFiniteNumber(event.billing.latestRecord?.cacheCreationInputTokens, event.billing.cumulative.cacheCreationInputTokens),
      cachedTokens: firstFiniteNumber(event.billing.latestRecord?.cachedTokens, event.billing.cumulative.cachedTokens),
      contextTokens: event.context.totalTokens,
      contextWindow: event.context.contextWindow,
      contextPercent: calculateContextPercent(event.context.totalTokens, event.context.contextWindow),
    })
    return
  }

  if (event.type === 'im.delivery') {
    applyAssistantImDelivery(state.messages, state.currentAssistant, event)
    return
  }

  if (event.type === 'coding.report.updated') {
    if (state.currentAssistant?.id.startsWith(`assistant:${event.runId}`)) {
      state.currentAssistant.codingReport = {
        ...state.currentAssistant.codingReport,
        ...event.codingReport,
      }
      return
    }
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]
      if (
        message?.type !== 'assistant'
        || message.status === 'streaming'
        || !message.id.startsWith(`assistant:${event.runId}`)
      ) continue
      state.messages[index] = {
        ...message,
        codingReport: {
          ...message.codingReport,
          ...event.codingReport,
        },
      }
      break
    }
    return
  }

  if (state.terminalClosed) {
    return
  }

  if (event.type === 'model.retry') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    if (event.phase === 'waiting') {
      const segmentStart = Math.min(
        state.currentAssistant.currentContentSegmentStart,
        state.currentAssistant.blocks.length,
      )
      state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block, index) => (
        index < segmentStart || (block.type !== 'text' && block.type !== 'thinking')
      ))
      recomputeAssistantContent(state.currentAssistant)
    }
    state.currentAssistant.retry = {
      phase: event.phase,
      attempt: event.attempt,
      maxRetries: event.maxRetries,
      retryDelayMs: event.retryDelayMs,
    }
    return
  }

  if (event.type === 'model.retry_cleared') {
    if (state.currentAssistant) state.currentAssistant.retry = undefined
    return
  }

  const subagentOwner = getSubagentOwner(event)
  if (subagentOwner) {
    if (state.currentAssistant) {
      markSubagentToolCall(state.currentAssistant, subagentOwner.parentToolUseId, {
        subagentRunId: subagentOwner.subagentRunId,
        status: 'running',
      })
    }
    return
  }

  if (event.type === 'assistant.delta') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.text += event.delta
    appendAssistantTextBlock(state.currentAssistant, event.delta)
    return
  }

  if (event.type === 'assistant.thinking_delta') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.thinking += event.delta
    appendAssistantThinkingBlock(state.currentAssistant, event.delta)
    return
  }

  if (event.type === 'assistant.final') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    replaceAssistantContentBlocks(state.currentAssistant, event.blocks)
    return
  }

  if (event.type === 'plan.preview') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.blocks.push({
      type: 'plan_preview',
      id: `plan:${event.contractId}`,
      preview: {
        contractId: event.contractId,
        title: event.title,
        summary: event.summary,
        markdown: event.markdown,
        ...(event.planFilePath ? { planFilePath: event.planFilePath } : {}),
        ...(event.planVerified !== undefined ? { planVerified: event.planVerified } : {}),
        stepCount: event.stepCount,
      },
    })
    state.currentAssistant.text += event.markdown
    return
  }

  if (event.type === 'todo.state_updated') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block) => block.type !== 'todo_update')
    state.currentAssistant.blocks.push({
      type: 'todo_update',
      // id 必须跨 todo 事件稳定：上方 filter 已保证同 run 内 todo_update 单例，
      // runId 足够唯一。若带 event.createdAt，每次 todo 更新 id 都漂移，会令简洁模式下
      // MinimalProcessGroup 段 key 漂移（段首为 todo_update 时）→ 整段卸载重建 → 列表抖动 + 跳顶。
      id: `todo:${event.runId}`,
      data: {
        todos: event.todos,
        currentActiveForm: event.currentActiveForm,
      },
    })
    return
  }

  if (event.type === 'tool.started') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    const toolCall: RuntimeToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName,
      input: event.inputPreview ?? {},
      status: 'running',
      startedAt: event.createdAt,
      ...(event.riskLevel ? { riskLevel: event.riskLevel } : {}),
    }
    // 幂等 upsert(与 completed/failed 对称):批次2 总线与旧路 persisted 事件跨 id 空间,
    // 同 toolCallId 的重复 started 只覆盖原位,不再 push 第二个 block(否则 React duplicate
    // key + 前一张卡永久 running)。
    upsertToolCallBlock(state.currentAssistant, event.toolCallId, toolCall)
    return
  }

  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    const existing = state.currentAssistant.toolCalls.get(event.toolCallId)
    const isError = event.type === 'tool.failed'
    const permissionState = isError && isToolPermissionTimeoutMessage(event.error.message)
      ? 'timeout'
      : existing?.permissionState
    const toolCall: RuntimeToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName ?? existing?.toolName ?? event.toolCallId,
      input: existing?.input ?? {},
      startedAt: existing?.startedAt ?? event.createdAt,
      durationMs: computeDurationMs(existing?.startedAt, event.createdAt),
      status: isError ? 'failed' : 'completed',
      output: isError ? event.error.message : event.resultPreview,
      isError,
      ...(permissionState ? { permissionState } : {}),
      ...(existing?.riskLevel ? { riskLevel: existing.riskLevel } : {}),
      ...(event.execution ? { execution: event.execution } : {}),
      ...(event.resultRef ? { resultRef: event.resultRef } : {}),
      ...(existing?.subagentRunId ? { subagentRunId: existing.subagentRunId } : {}),
      ...(isDelegationToolName(existing?.toolName ?? '') || isDelegationToolName(event.toolName ?? '')
        ? { subagentStatus: isError ? 'errored' as const : 'completed' as const }
        : existing?.subagentStatus ? { subagentStatus: existing.subagentStatus } : {}),
    }
    upsertToolCallBlock(state.currentAssistant, event.toolCallId, toolCall)
    return
  }

  if (event.type === 'tool.permission_timeout') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    const existing = state.currentAssistant.toolCalls.get(event.toolCallId)
    const toolCall: RuntimeToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName ?? existing?.toolName ?? event.toolCallId,
      input: existing?.input ?? {},
      startedAt: existing?.startedAt ?? event.createdAt,
      durationMs: computeDurationMs(existing?.startedAt, event.createdAt),
      status: 'failed',
      output: event.message,
      isError: true,
      permissionState: 'timeout',
    }
    upsertToolCallBlock(state.currentAssistant, event.toolCallId, toolCall)
    return
  }

  if (event.type === 'tool.output') {
    // 运行中工具卡的实时输出快照(Bash)。卡片缺失或已结束则忽略——迟到的快照
    // 不复活卡片，completed/failed 的 upsert 不带 streamedOutput 即整体清除。
    const assistant = state.currentAssistant
    if (!assistant) return
    const existing = assistant.toolCalls.get(event.toolCallId)
    if (!existing || existing.status !== 'running') return
    upsertToolCallBlock(assistant, event.toolCallId, { ...existing, streamedOutput: event.chunk })
    return
  }

  if (event.type === 'run.completed' || event.type === 'run.turn_limited') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    if (event.type === 'run.turn_limited') {
      appendAssistantTextBlock(state.currentAssistant, TURN_LIMIT_NOTICE)
      recomputeAssistantContent(state.currentAssistant)
      // #566:记录提示尾缀，若同链 run.started 随后到达则剥掉（自动续跑不给用户假信号）
      const lastBlock = state.currentAssistant.blocks.at(-1)
      state.pendingTurnLimitNotice = lastBlock?.type === 'text'
        ? { messageId: state.currentAssistant.id, noticeLength: TURN_LIMIT_NOTICE.length }
        : null
    }
    if (event.type === 'run.completed') {
      state.currentAssistant.messageId = event.finalMessageId
      state.currentAssistant.completedAt = event.createdAt
    }
    if (event.codingReport) {
      state.currentAssistant.codingReport = {
        ...state.currentAssistant.codingReport,
        ...event.codingReport,
      }
    }
    state.currentAssistant.status = 'completed'
    state.currentAssistant.retry = undefined
    flushAssistant(state.messages, state.currentAssistant)
    state.currentAssistant = null
    state.terminalClosed = true
    return
  }

  if (event.type === 'run.failed' || event.type === 'run.cancelled') {
    state.currentAssistant ??= createBoundAssistant(state, assistantIdFor(state, event.runId))
    state.currentAssistant.status = 'failed'
    state.currentAssistant.retry = undefined
    state.currentAssistant.error = event.type === 'run.failed' ? event.error.message : (event.reason ?? 'Run cancelled')
    if (event.type === 'run.failed' && event.codingReport) {
      state.currentAssistant.codingReport = {
        ...state.currentAssistant.codingReport,
        ...event.codingReport,
      }
    }
    flushAssistant(state.messages, state.currentAssistant)
    state.currentAssistant = null
    state.terminalClosed = true
  }
}

function isToolPermissionTimeoutMessage(message: string): boolean {
  return message.includes('工具权限确认超时')
}

function computeDurationMs(startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined
  return Math.max(0, end - start)
}

function applyAssistantImDelivery(
  messages: RuntimeMessageView[],
  currentAssistant: MutableAssistantMessage | null,
  event: Extract<LumeRuntimeEvent, { type: 'im.delivery' }>,
): void {
  const delivery = {
    status: event.status,
    provider: event.provider,
    peerKind: event.peerKind,
    peerId: event.peerId,
    ...(event.error?.message ? { error: event.error.message } : {}),
  }
  if (currentAssistant) {
    currentAssistant.imDelivery = delivery
    return
  }
  const assistantMessages = [...messages]
    .reverse()
    .filter((message): message is Extract<RuntimeMessageView, { type: 'assistant' }> => message.type === 'assistant')
  const lastAssistant = assistantMessages.find((message) => (
    event.messageId
      ? message.id === event.messageId || message.id === `assistant:${event.runId}`
      : false
  )) ?? assistantMessages[0]
  if (lastAssistant) {
    lastAssistant.imDelivery = delivery
  }
}

function appendContextCompactionNotice(
  state: ProjectionState,
  event: Extract<LumeRuntimeEvent, { type: 'context.compaction.started' | 'context.compaction.progress' | 'context.compaction.completed' }>,
): void {
  const existingId = state.compactionMessageByRun.get(event.runId)
  const existingIndex = existingId
    ? state.messages.findIndex((message) => message.id === existingId)
    : -1
  const next = {
    id: existingId ?? event.id,
    type: 'system' as const,
    variant: 'context_compaction' as const,
    status: event.type === 'context.compaction.completed' ? 'completed' as const : 'active' as const,
    text: formatContextCompactionNoticeText(event),
    ...(event.type === 'context.compaction.completed' && event.outcome !== 'failed' && event.summary
      ? { summary: event.summary }
      : {}),
    createdAt: event.createdAt,
  }
  if (existingIndex >= 0) {
    state.messages[existingIndex] = next
    return
  }
  state.compactionMessageByRun.set(event.runId, next.id)
  state.messages.push(next)
}

function formatContextCompactionNoticeText(
  event: Extract<LumeRuntimeEvent, { type: 'context.compaction.started' | 'context.compaction.progress' | 'context.compaction.completed' }>,
): string {
  const mode = event.trigger === 'manual' ? '手动' : '自动'
  if (event.type === 'context.compaction.progress') {
    return event.message ?? `正在${mode}压缩上下文`
  }
  return event.type === 'context.compaction.started'
    ? `正在${mode}压缩上下文`
    : event.outcome === 'failed'
      ? '上下文压缩失败，已保留原上下文'
      : `上下文已${mode}压缩`
}

function getSubagentOwner(event: LumeRuntimeEvent): { parentToolUseId: string; subagentRunId?: string } | null {
  if (!event.parentToolUseId) return null
  return {
    parentToolUseId: event.parentToolUseId,
    ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}),
  }
}

function markSubagentToolCall(
  assistant: MutableAssistantMessage,
  parentToolUseId: string,
  patch: { subagentRunId?: string; status: NonNullable<RuntimeToolCallView['subagentStatus']> },
): void {
  const existing = assistant.toolCalls.get(parentToolUseId)
  if (!existing) return
  upsertToolCallBlock(assistant, parentToolUseId, {
    ...existing,
    ...(patch.subagentRunId ? { subagentRunId: patch.subagentRunId } : {}),
    subagentStatus: patch.status,
  })
}

function upsertToolCallBlock(
  assistant: MutableAssistantMessage,
  toolCallId: string,
  toolCall: RuntimeToolCallView,
): void {
  assistant.toolCalls.set(toolCallId, toolCall)
  const blockIndex = assistant.toolBlockIds.get(toolCallId)
  if (blockIndex === undefined) {
    assistant.toolBlockIds.set(toolCallId, assistant.blocks.length)
    assistant.blocks.push({ type: 'tool_call', id: `tool:${toolCallId}`, toolCall })
    assistant.currentContentSegmentStart = assistant.blocks.length
    return
  }
  assistant.blocks[blockIndex] = { type: 'tool_call', id: `tool:${toolCallId}`, toolCall }
}

function keepLatestVersionTurns(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  const latestTurnByGroup = new Map<string, number>()
  let turnIndex = -1
  for (const event of events) {
    if (event.type !== 'message.user.submitted') continue
    turnIndex += 1
    if (!event.versionGroupId) continue
    const current = latestTurnByGroup.get(event.versionGroupId)
    if (current === undefined || (event.versionIndex ?? 0) >= current) {
      latestTurnByGroup.set(event.versionGroupId, event.versionIndex ?? turnIndex)
    }
  }
  if (latestTurnByGroup.size === 0) return events

  const filtered: LumeRuntimeEvent[] = []
  let includeCurrentTurn = true
  for (const event of events) {
    if (event.type === 'message.user.submitted') {
      includeCurrentTurn = !event.versionGroupId
        || latestTurnByGroup.get(event.versionGroupId) === (event.versionIndex ?? 0)
    }
    if (includeCurrentTurn) {
      filtered.push(event)
    }
  }
  return filtered
}

interface MutableAssistantMessage {
  id: string
  text: string
  thinking: string
  messageId?: string
  fileReferenceBinding?: FileReferenceBinding
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion
  completedAt?: string
  status: RuntimeAssistantMessageView['status']
  error?: string
  retry?: RuntimeAssistantMessageView['retry']
  providerTokenCount?: number
  providerTokenUsage?: RuntimeAssistantTokenUsageView
  codingReport?: RuntimeCodingReport
  imDelivery?: RuntimeAssistantMessageView['imDelivery']
  toolCalls: Map<string, RuntimeToolCallView>
  toolBlockIds: Map<string, number>
  blocks: RuntimeAssistantBlock[]
  currentContentSegmentStart: number
}

function createBoundAssistant(state: ProjectionState, id: string): MutableAssistantMessage {
  return createAssistantMessage(id, state.fileReferenceBinding, state.fileReferenceProtocolVersion)
}

function createAssistantMessage(id: string, fileReferenceBinding?: FileReferenceBinding, fileReferenceProtocolVersion?: FileReferenceProtocolVersion): MutableAssistantMessage {
  return {
    id,
    text: '',
    thinking: '',
    status: 'streaming',
    toolCalls: new Map(),
    toolBlockIds: new Map(),
    blocks: [],
    currentContentSegmentStart: 0,
    ...(fileReferenceBinding ? { fileReferenceBinding } : {}),
    ...(fileReferenceProtocolVersion ? { fileReferenceProtocolVersion } : {}),
  }
}

function appendAssistantTextBlock(assistant: MutableAssistantMessage, text: string): void {
  const last = assistant.blocks.at(-1)
  if (last?.type === 'text') {
    last.text += text
    return
  }
  assistant.blocks.push({
    type: 'text',
    id: `text:${assistant.blocks.length}`,
    text,
  })
}

function appendAssistantThinkingBlock(assistant: MutableAssistantMessage, text: string): void {
  const last = assistant.blocks.at(-1)
  if (last?.type === 'thinking') {
    last.text += text
    return
  }
  assistant.blocks.push({
    type: 'thinking',
    id: `thinking:${assistant.blocks.length}`,
    text,
  })
}

function replaceAssistantContentBlocks(
  assistant: MutableAssistantMessage,
  blocks: Array<{ type: 'text' | 'thinking'; text: string }>,
): void {
  const finalHasThinking = blocks.some((block) => block.type === 'thinking' && block.text.trim())
  const segmentStart = Math.min(assistant.currentContentSegmentStart, assistant.blocks.length)
  const beforeSegment = assistant.blocks.slice(0, segmentStart)
  const currentSegment = assistant.blocks.slice(segmentStart)
  const preservedCurrentSegment = currentSegment.filter((block) => (
    block.type === 'tool_call'
    || block.type === 'plan_preview'
    || (!finalHasThinking && block.type === 'thinking')
  ))
  assistant.blocks = [...beforeSegment, ...preservedCurrentSegment]
  reindexToolBlocks(assistant)

  for (const block of blocks) {
    if (block.type === 'text') {
      assistant.text += block.text
      appendAssistantTextBlock(assistant, block.text)
    } else {
      assistant.thinking += block.text
      appendAssistantThinkingBlock(assistant, block.text)
    }
  }
  recomputeAssistantContent(assistant)
}

function reindexToolBlocks(assistant: MutableAssistantMessage): void {
  assistant.toolBlockIds.clear()
  assistant.blocks.forEach((block, index) => {
    if (block.type === 'tool_call') {
      assistant.toolBlockIds.set(block.toolCall.id, index)
    }
  })
}

function recomputeAssistantContent(assistant: MutableAssistantMessage): void {
  assistant.text = assistant.blocks
    .filter((block): block is Extract<RuntimeAssistantBlock, { type: 'text' | 'plan_preview' }> => (
      block.type === 'text' || block.type === 'plan_preview'
    ))
    .map((block) => block.type === 'text' ? block.text : block.preview.markdown)
    .join('')
  const taskProgressText = assistant.blocks
    .filter((block): block is Extract<RuntimeAssistantBlock, { type: 'task_progress' }> => block.type === 'task_progress')
    .map((block) => block.event.message)
    .filter((message): message is string => typeof message === 'string' && message.trim().length > 0)
    .join('')
  assistant.text += taskProgressText
  assistant.thinking = assistant.blocks
    .filter((block): block is Extract<RuntimeAssistantBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map((block) => block.text)
    .join('')
}

function assistantHasContent(assistant: MutableAssistantMessage): boolean {
  return Boolean(
    assistant.text.trim()
    || assistant.thinking.trim()
    || assistant.toolCalls.size > 0
    || assistant.blocks.some((block) => block.type === 'memory_context_used')
    || assistant.codingReport
    || assistant.error
  )
}

/** 构建当前 assistant 的视图消息（不 mutate state.messages）。无内容且非 streaming 占位时返回 null。 */
function snapshotAssistant(assistant: MutableAssistantMessage | null): RuntimeMessageView | null {
  if (!assistant) return null
  const hasContent = assistantHasContent(assistant)
  const shouldRenderPlaceholder = assistant.status === 'streaming'
  if (!hasContent && !shouldRenderPlaceholder) return null
  return {
    id: assistant.id,
    type: 'assistant',
    text: assistant.text,
    thinking: assistant.thinking,
    ...(assistant.messageId ? { messageId: assistant.messageId } : {}),
    ...(assistant.fileReferenceBinding ? { fileReferenceBinding: assistant.fileReferenceBinding } : {}),
    ...(assistant.fileReferenceProtocolVersion ? { fileReferenceProtocolVersion: assistant.fileReferenceProtocolVersion } : {}),
    ...(assistant.completedAt ? { completedAt: assistant.completedAt } : {}),
    blocks: assistant.blocks,
    status: assistant.status,
    ...(assistant.error ? { error: assistant.error } : {}),
    ...(assistant.retry ? { retry: assistant.retry } : {}),
    ...(assistant.imDelivery ? { imDelivery: assistant.imDelivery } : {}),
    tokenCount: assistant.providerTokenCount ?? estimateAssistantTokenCount(assistant),
    ...(assistant.providerTokenCount !== undefined ? { tokenCountSource: 'provider' as const } : {}),
    ...(assistant.providerTokenUsage ? { tokenUsage: assistant.providerTokenUsage } : {}),
    ...(assistant.codingReport ? { codingReport: assistant.codingReport } : {}),
    toolCalls: [...assistant.toolCalls.values()],
  }
}

function flushAssistant(
  messages: RuntimeMessageView[],
  assistant: MutableAssistantMessage | null,
): void {
  const snapshot = snapshotAssistant(assistant)
  if (snapshot) messages.push(snapshot)
}

/** #566:自动续跑链的下一 run 开始——剥掉上一边界的「已达上限」提示尾缀。
 * 必须**克隆替换**消息与尾块对象（review M2）：stabilizeRuntimeMessages 按引用
 * 复用缓存视图，原地 mutate 在跨帧增量/live 路径上对 UI 不可见。 */
function retractPendingTurnLimitNotice(state: ProjectionState): void {
  const pending = state.pendingTurnLimitNotice
  state.pendingTurnLimitNotice = null
  if (!pending) return
  const index = state.messages.findIndex((item) => item.id === pending.messageId)
  const message = state.messages[index]
  if (!message || message.type !== 'assistant') return
  const lastBlockIndex = message.blocks.length - 1
  const last = message.blocks[lastBlockIndex]
  if (last?.type !== 'text' || !last.text.endsWith(TURN_LIMIT_NOTICE)) return
  // 块 id 按索引派生，不删块防 id 漂移；提示独占时留空文本块（渲染无痕）
  const strippedBlockText = last.text.slice(0, -pending.noticeLength)
  const strippedMessageText = message.text.endsWith(TURN_LIMIT_NOTICE)
    ? message.text.slice(0, -TURN_LIMIT_NOTICE.length)
    : message.text
  const clonedBlocks = [...message.blocks]
  clonedBlocks[lastBlockIndex] = { ...last, text: strippedBlockText }
  // tokenCount 同步扣掉提示的估算值（~5 token），保持口径诚实
  const noticeTokens = estimateTextTokens(TURN_LIMIT_NOTICE)
  state.messages[index] = {
    ...message,
    text: strippedMessageText,
    blocks: clonedBlocks,
    ...(typeof message.tokenCount === 'number'
      ? { tokenCount: Math.max(0, message.tokenCount - noticeTokens) }
      : {}),
  }
}

/**
 * 构建投影的最终消息视图：历史已 flush 消息 + 当前 currentAssistant 快照。
 * 关键：不 mutate state.messages——增量场景 state 跨帧保持，每帧只在「视图」末尾附上
 * currentAssistant 快照，不能 push（否则跨帧累积重复 assistant）。
 * 全量 projectRuntimeEventMessages 末尾的 flushAssistant 等价于此处的快照追加。
 */
function buildMessagesView(state: ProjectionState): RuntimeMessageView[] {
  const snapshot = snapshotAssistant(state.currentAssistant)
  return snapshot ? [...state.messages, snapshot] : [...state.messages]
}

function applyAssistantProviderTokenUsage(
  messages: RuntimeMessageView[],
  assistant: MutableAssistantMessage | null,
  usage: RuntimeAssistantTokenUsageView,
): void {
  const normalizedUsage = normalizeAssistantTokenUsage(usage)
  if (!normalizedUsage) return
  const outputTokens = normalizedUsage.outputTokens
  if (assistant) {
    if (outputTokens !== undefined) {
      assistant.providerTokenCount = outputTokens
    }
    assistant.providerTokenUsage = normalizedUsage
    return
  }
  const lastMessage = messages.at(-1)
  if (lastMessage?.type === 'assistant') {
    if (outputTokens !== undefined) {
      lastMessage.tokenCount = outputTokens
      lastMessage.tokenCountSource = 'provider'
    }
    lastMessage.tokenUsage = normalizedUsage
  }
}

function normalizeAssistantTokenUsage(usage: RuntimeAssistantTokenUsageView): RuntimeAssistantTokenUsageView | null {
  const normalized: RuntimeAssistantTokenUsageView = {}
  assignFiniteUsageNumber(normalized, 'inputTokens', usage.inputTokens)
  assignFiniteUsageNumber(normalized, 'outputTokens', usage.outputTokens)
  assignFiniteUsageNumber(normalized, 'cacheReadInputTokens', usage.cacheReadInputTokens)
  assignFiniteUsageNumber(normalized, 'cacheCreationInputTokens', usage.cacheCreationInputTokens)
  assignFiniteUsageNumber(normalized, 'cachedTokens', usage.cachedTokens)
  assignFiniteUsageNumber(normalized, 'contextTokens', usage.contextTokens)
  assignFiniteUsageNumber(normalized, 'contextWindow', usage.contextWindow)
  assignFiniteUsageNumber(normalized, 'contextPercent', usage.contextPercent)
  if (normalized.cachedTokens === undefined) {
    const cachedTokens = normalized.cacheReadInputTokens ?? 0
    if (cachedTokens > 0) normalized.cachedTokens = cachedTokens
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

function assignFiniteUsageNumber<K extends keyof RuntimeAssistantTokenUsageView>(
  usage: RuntimeAssistantTokenUsageView,
  key: K,
  value: RuntimeAssistantTokenUsageView[K],
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    usage[key] = Math.max(0, Math.round(value)) as RuntimeAssistantTokenUsageView[K]
  }
}

function calculateContextPercent(totalTokens: number | undefined, contextWindow: number | undefined): number | undefined {
  if (typeof totalTokens !== 'number' || typeof contextWindow !== 'number') return undefined
  if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((totalTokens / contextWindow) * 100)))
}

function firstFiniteNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function estimateAssistantTokenCount(assistant: MutableAssistantMessage): number {
  const blockTokens = assistant.blocks.reduce((sum, block) => sum + estimateAssistantBlockTokens(block), 0)
  return blockTokens + estimateTextTokens(assistant.error ?? '')
}

function estimateAssistantBlockTokens(block: RuntimeAssistantBlock): number {
  if (block.type === 'text' || block.type === 'thinking') return estimateTextTokens(block.text)
  if (block.type === 'plan_preview') return estimateTextTokens(block.preview.markdown)
  if (block.type === 'task_progress') return estimateTextTokens(block.event.message ?? '')
  if (block.type === 'advisor_review') return estimateTextTokens(`${block.event.summary} ${block.event.details ?? ''}`)
  if (block.type === 'tool_call') {
    return estimateValueTokens(block.toolCall.input) + estimateValueTokens(block.toolCall.output)
  }
  if (block.type === 'todo_update') {
    return estimateTextTokens(block.data.currentActiveForm ?? '') + estimateValueTokens(block.data.todos)
  }
  return 0
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value)
  if (value === undefined || value === null) return 0
  try {
    return estimateTextTokens(JSON.stringify(value))
  } catch {
    return estimateTextTokens(String(value))
  }
}

function estimateTextTokens(value: string): number {
  const trimmed = value.trim()
  return trimmed.length > 0 ? Math.ceil(trimmed.length / 4) : 0
}

export interface ProjectionRef {
  state: ProjectionState
  events: LumeRuntimeEvent[]
}

export interface IncrementalProjectionResult {
  messages: RuntimeMessageView[]
  ref: ProjectionRef
}

/**
 * 增量投影：能增量则只 apply 新事件到 prev.state；否则 fallback 全量重投影。
 * 返回最终消息视图 + 供下一帧增量判断的 ref（ref.events 始终是原始 events，便于下次引用比较）。
 *
 * tool.output 快照在 runtime-event-state 按稳定 id 原地替换（可能命中任意旧槽位，
 * 且不改变长度/尾引用），纯追加判定看不见——旧槽位扫描单独处理：仅接受
 * tool.output→tool.output 的引用替换并重放（applyRuntimeEvent 对该类型是绝对
 * 覆写，幂等）；其他类型的旧槽位引用变化说明数组被重写，保守 fallback。
 * 这同时让运行中快照（~7 次/秒）走 O(变更槽位) 增量帧而非全量重投影。
 */
export function applyRuntimeEventsIncremental(
  events: LumeRuntimeEvent[],
  prev: ProjectionRef | null,
): IncrementalProjectionResult {
  const reprojectFully = (): IncrementalProjectionResult => {
    const state: ProjectionState = {
      messages: [],
      currentAssistant: null,
      terminalClosed: false,
      assistantSegmentByRun: new Map(),
      compactionMessageByRun: new Map(),
    }
    const kept = keepLatestVersionTurns(events)
    for (const event of kept) {
      applyRuntimeEvent(state, event)
    }
    return { messages: buildMessagesView(state), ref: { state, events } }
  }

  if (!prev || events.length < prev.events.length) return reprojectFully()

  const prevLen = prev.events.length
  for (let i = prevLen; i < events.length; i++) {
    const event = events[i]
    if (event?.type === 'message.user.submitted' && (event as any).versionGroupId) return reprojectFully()
  }

  const state = prev.state
  for (let i = 0; i < prevLen; i++) {
    if (events[i] === prev.events[i]) continue
    if (events[i]?.type !== 'tool.output') return reprojectFully()
    applyRuntimeEvent(state, events[i]!)
  }
  for (let i = prevLen; i < events.length; i++) {
    applyRuntimeEvent(state, events[i]!)
  }
  return { messages: buildMessagesView(state), ref: { state, events } }
}
