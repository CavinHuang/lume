import type { LumeRuntimeEvent } from '@lume/shared'
import type {
  RuntimeAssistantBlock,
  RuntimeAssistantMessageView,
  RuntimeAssistantTokenUsageView,
  RuntimeMessageView,
  RuntimeToolCallView,
} from './runtime-message-view'

const TURN_LIMIT_NOTICE = '本轮已达到最大执行轮次，当前进度已保存。发送“继续”可接着执行。'

interface ProjectionState {
  messages: RuntimeMessageView[]
  currentAssistant: MutableAssistantMessage | null
  terminalClosed: boolean
}

export function projectRuntimeEventMessages(events: LumeRuntimeEvent[]): RuntimeMessageView[] {
  const kept = keepLatestVersionTurns(events)
  const state: ProjectionState = {
    messages: [],
    currentAssistant: null,
    terminalClosed: false,
  }
  for (const event of kept) {
    applyRuntimeEvent(state, event)
  }
  flushAssistant(state.messages, state.currentAssistant)
  return state.messages
}

function applyRuntimeEvent(state: ProjectionState, event: LumeRuntimeEvent): void {
  const { messages } = state

  if (event.type === 'run.started') {
    state.terminalClosed = false
    return
  }

  if (event.type === 'message.user.submitted') {
    flushAssistant(state.messages, state.currentAssistant)
    messages.push({
      id: event.messageId ?? `user:${event.createdAt}`,
      type: 'user',
      text: event.text,
      createdAt: event.createdAt,
      ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.versionGroupId ? { versionGroupId: event.versionGroupId } : {}),
      ...(typeof event.versionIndex === 'number' ? { versionIndex: event.versionIndex } : {}),
      ...(typeof event.versionCount === 'number' ? { versionCount: event.versionCount } : {}),
    })
    state.currentAssistant = createAssistantMessage(`assistant:${event.runId}`)
    state.terminalClosed = false
    return
  }

  if (event.type === 'task.progress') {
    if (state.terminalClosed || !state.currentAssistant) {
      state.currentAssistant = createAssistantMessage(`assistant:task:${event.taskRunId}`)
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
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block) => block.type !== 'memory_context_used')
    state.currentAssistant.blocks.push({
      type: 'memory_context_used',
      id: `memory:${event.runId}:${event.createdAt}`,
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
    }
    state.currentAssistant = null
    appendContextCompactionNotice(messages, event)
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

  if (state.terminalClosed) {
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
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.text += event.delta
    appendAssistantTextBlock(state.currentAssistant, event.delta)
    return
  }

  if (event.type === 'assistant.thinking_delta') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.thinking += event.delta
    appendAssistantThinkingBlock(state.currentAssistant, event.delta)
    return
  }

  if (event.type === 'assistant.final') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    replaceAssistantContentBlocks(state.currentAssistant, event.blocks)
    return
  }

  if (event.type === 'plan.preview') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
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

  if (event.type === 'tool.started') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    const toolCall: RuntimeToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName,
      input: event.inputPreview ?? {},
      status: 'running',
      startedAt: event.createdAt,
    }
    state.currentAssistant.toolCalls.set(event.toolCallId, toolCall)
    state.currentAssistant.toolBlockIds.set(event.toolCallId, state.currentAssistant.blocks.length)
    state.currentAssistant.blocks.push({ type: 'tool_call', id: `tool:${event.toolCallId}`, toolCall })
    state.currentAssistant.currentContentSegmentStart = state.currentAssistant.blocks.length
    return
  }

  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
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
      ...(existing?.subagentRunId ? { subagentRunId: existing.subagentRunId } : {}),
      ...(existing?.toolName === 'Agent' || event.toolName === 'Agent'
        ? { subagentStatus: isError ? 'errored' as const : 'completed' as const }
        : existing?.subagentStatus ? { subagentStatus: existing.subagentStatus } : {}),
    }
    upsertToolCallBlock(state.currentAssistant, event.toolCallId, toolCall)
    return
  }

  if (event.type === 'tool.permission_timeout') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
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

  if (event.type === 'run.completed' || event.type === 'run.turn_limited') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    if (event.type === 'run.turn_limited') {
      appendAssistantTextBlock(state.currentAssistant, TURN_LIMIT_NOTICE)
      recomputeAssistantContent(state.currentAssistant)
    }
    if (event.type === 'run.completed') {
      state.currentAssistant.messageId = event.finalMessageId
      state.currentAssistant.completedAt = event.createdAt
    }
    state.currentAssistant.status = 'completed'
    flushAssistant(state.messages, state.currentAssistant)
    state.currentAssistant = null
    state.terminalClosed = true
    return
  }

  if (event.type === 'run.failed' || event.type === 'run.cancelled') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.status = 'failed'
    state.currentAssistant.error = event.type === 'run.failed' ? event.error.message : (event.reason ?? 'Run cancelled')
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
  messages: RuntimeMessageView[],
  event: Extract<LumeRuntimeEvent, { type: 'context.compaction.started' | 'context.compaction.progress' | 'context.compaction.completed' }>,
): void {
  if (event.type === 'context.compaction.completed') {
    const activeNotice = [...messages]
      .reverse()
      .find((m): m is Extract<RuntimeMessageView, { type: 'system'; variant: 'context_compaction' }> =>
        m.type === 'system' && m.variant === 'context_compaction' && m.status === 'active',
      )
    if (activeNotice) {
      activeNotice.status = 'completed'
      activeNotice.text = formatContextCompactionNoticeText(event)
      if (event.summary) activeNotice.summary = event.summary
      return
    }
  }
  const existing = messages.at(-1)
  if (existing?.type === 'system' && existing.variant === 'context_compaction' && existing.status === 'active') {
    existing.text = formatContextCompactionNoticeText(event)
    return
  }
  messages.push({
    id: event.id,
    type: 'system',
    variant: 'context_compaction',
    status: event.type === 'context.compaction.completed' ? 'completed' : 'active',
    text: formatContextCompactionNoticeText(event),
    ...(event.type === 'context.compaction.completed' && event.summary ? { summary: event.summary } : {}),
    createdAt: event.createdAt,
  })
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
  completedAt?: string
  status: RuntimeAssistantMessageView['status']
  error?: string
  providerTokenCount?: number
  providerTokenUsage?: RuntimeAssistantTokenUsageView
  imDelivery?: RuntimeAssistantMessageView['imDelivery']
  toolCalls: Map<string, RuntimeToolCallView>
  toolBlockIds: Map<string, number>
  blocks: RuntimeAssistantBlock[]
  currentContentSegmentStart: number
}

function createAssistantMessage(id: string): MutableAssistantMessage {
  return {
    id,
    text: '',
    thinking: '',
    status: 'streaming',
    toolCalls: new Map(),
    toolBlockIds: new Map(),
    blocks: [],
    currentContentSegmentStart: 0,
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
    || assistant.error
  )
}

function flushAssistant(
  messages: RuntimeMessageView[],
  assistant: MutableAssistantMessage | null,
): void {
  if (!assistant) return
  const hasContent = assistantHasContent(assistant)
  const shouldRenderPlaceholder = assistant.status === 'streaming'
  if (!hasContent && !shouldRenderPlaceholder) return
  messages.push({
    id: assistant.id,
    type: 'assistant',
    text: assistant.text,
    thinking: assistant.thinking,
    ...(assistant.messageId ? { messageId: assistant.messageId } : {}),
    ...(assistant.completedAt ? { completedAt: assistant.completedAt } : {}),
    blocks: assistant.blocks,
    status: assistant.status,
    ...(assistant.error ? { error: assistant.error } : {}),
    ...(assistant.imDelivery ? { imDelivery: assistant.imDelivery } : {}),
    tokenCount: assistant.providerTokenCount ?? estimateAssistantTokenCount(assistant),
    ...(assistant.providerTokenCount !== undefined ? { tokenCountSource: 'provider' as const } : {}),
    ...(assistant.providerTokenUsage ? { tokenUsage: assistant.providerTokenUsage } : {}),
    toolCalls: [...assistant.toolCalls.values()],
  })
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
    const cachedTokens = (normalized.cacheReadInputTokens ?? 0) + (normalized.cacheCreationInputTokens ?? 0)
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
  if (block.type === 'tool_call') {
    return estimateValueTokens(block.toolCall.input) + estimateValueTokens(block.toolCall.output)
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
