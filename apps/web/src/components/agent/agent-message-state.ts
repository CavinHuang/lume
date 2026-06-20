import type { AgentMessage, AgentMessageAttachmentInput, SDKMessage } from '@lume/shared'
import type { RuntimeAssistantTokenUsageView, RuntimeMessageView } from './runtime-message-view'

const SCROLL_BOTTOM_THRESHOLD_PX = 80
const PROGRAMMATIC_SCROLL_HOLD_MS = 180

type ScrollMetrics = {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold
}

export function shouldAutoScrollAfterUserScroll({
  nearBottom,
  programmatic = false,
}: {
  currentScrollTop: number
  previousScrollTop: number
  nearBottom: boolean
  programmatic?: boolean
}): boolean {
  // 只要仍在底部阈值内就保持自动触底：scrollTop 的瞬时减小（上方内容折叠导致
  // 浏览器 clamp、底部亚像素抖动）不应被误判为“用户向上滚”而关闭粘底。
  // 仅当用户向上滚并离开底部区域（nearBottom=false）时才停止跟随。
  if (programmatic) return true
  return nearBottom
}

export function getProgrammaticScrollHoldUntil({
  now,
  behavior,
}: {
  now: number
  behavior: ScrollBehavior
}): number {
  return behavior === 'smooth' ? Number.POSITIVE_INFINITY : now + PROGRAMMATIC_SCROLL_HOLD_MS
}

export function shouldApplyThreadMessagesResult({
  requestedThreadId,
  currentThreadId,
  cancelled,
}: {
  requestedThreadId: string
  currentThreadId: string
  cancelled: boolean
}): boolean {
  return !cancelled && requestedThreadId === currentThreadId
}

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
): RuntimeMessageView[] {
  const visibleUsers = visibleThreadMessages.filter((message) => message.role === 'user')
  const visibleAssistants = visibleThreadMessages.filter((message) => message.role === 'assistant')
  if (visibleUsers.length === 0 && visibleAssistants.length === 0) return messages
  const usedVisibleIds = new Set<string>()
  const usedVisibleAssistantIds = new Set<string>()

  return messages.map((message) => {
    if (message.type === 'user') {
      if (message.messageId) {
        const visible = visibleUsers.find((item) => item.id === message.messageId)
        return visible ? withPersistedUserMessage(message, visible) : message
      }

      const visible = visibleUsers.find((item) => (
        !usedVisibleIds.has(item.id)
        && item.content === message.text
        && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
      )) ?? visibleUsers.find((item) => !usedVisibleIds.has(item.id) && item.content === message.text)

      if (visible) {
        usedVisibleIds.add(visible.id)
        return withPersistedUserMessage(message, visible)
      }
      return message
    }

    if (message.type === 'assistant') {
      const visible = visibleAssistants.find((item) => (
        !usedVisibleAssistantIds.has(item.id)
        && item.content === message.text
      ))
      if (!visible) return message
      usedVisibleAssistantIds.add(visible.id)
      const providerTokenUsage = readPersistedAssistantTokenUsage(visible.metadata)
      const providerOutputTokens = providerTokenUsage?.outputTokens
      return {
        ...message,
        messageId: visible.id,
        completedAt: new Date(visible.createdAt).toISOString(),
        ...(message.tokenCountSource === 'provider' || providerOutputTokens === undefined
          ? {}
          : {
              tokenCount: providerOutputTokens,
              tokenCountSource: 'provider' as const,
            }),
        ...(message.tokenUsage || providerTokenUsage === undefined ? {} : { tokenUsage: providerTokenUsage }),
      }
    }

    return message
  })
}

export function projectVisibleThreadMessages(visibleThreadMessages: AgentMessage[]): RuntimeMessageView[] {
  const projected: RuntimeMessageView[] = []
  for (const message of visibleThreadMessages) {
    const createdAt = new Date(message.createdAt).toISOString()
    projected.push(...projectPersistedCompactionMessages(message, createdAt))
    if (message.role === 'user') {
      projected.push(withPersistedUserAttachments({
        id: message.id,
        type: 'user',
        text: message.content,
        createdAt,
        messageId: message.id,
        versionGroupId: message.versionGroupId,
        versionIndex: message.versionIndex,
        versionCount: message.versionCount,
      }, message))
      continue
    }

    if (message.role === 'assistant') {
      const tokenUsage = readPersistedAssistantTokenUsage(message.metadata)
      const tokenCount = tokenUsage?.outputTokens
      projected.push({
        id: message.id,
        type: 'assistant',
        text: message.content,
        thinking: message.reasoning ?? '',
        messageId: message.id,
        completedAt: createdAt,
        blocks: projectVisibleAssistantBlocks(message),
        status: 'completed',
        ...(tokenCount !== undefined
          ? {
              tokenCount,
              tokenCountSource: 'provider' as const,
            }
          : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
        toolCalls: [],
      })
    }
  }
  return projected
}

export function collectNewRuntimeMessageIds(
  previousIds: ReadonlySet<string>,
  messages: RuntimeMessageView[],
): Set<string> {
  const next = new Set<string>()
  for (const message of messages) {
    if (!previousIds.has(message.id)) {
      next.add(message.id)
    }
  }
  return next
}

export function collectRuntimeMessageIds(messages: RuntimeMessageView[]): Set<string> {
  return new Set(messages.map((message) => message.id))
}

export function getLatestUserMessageKey(messages: RuntimeMessageView[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'user') {
      return `${message.createdAt}:${message.text}`
    }
  }
  return null
}

function withPersistedUserAttachments(
  message: Extract<RuntimeMessageView, { type: 'user' }>,
  visible: AgentMessage,
): Extract<RuntimeMessageView, { type: 'user' }> {
  if (message.attachments?.length) return message
  const attachments = readPersistedMessageAttachments(visible.metadata)
  return attachments.length > 0 ? { ...message, attachments } : message
}

function withPersistedUserMessage(
  message: Extract<RuntimeMessageView, { type: 'user' }>,
  visible: AgentMessage,
): Extract<RuntimeMessageView, { type: 'user' }> {
  return withPersistedUserAttachments({
    ...message,
    id: visible.id,
    text: visible.content,
    messageId: visible.id,
    versionGroupId: visible.versionGroupId,
    versionIndex: visible.versionIndex,
    versionCount: visible.versionCount,
  }, visible)
}

function readPersistedMessageAttachments(metadata: Record<string, unknown> | undefined): AgentMessageAttachmentInput[] {
  const raw = metadata?.messageAttachments
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentMessageAttachmentInput => (
    item !== null
    && typeof item === 'object'
    && typeof (item as AgentMessageAttachmentInput).id === 'string'
    && typeof (item as AgentMessageAttachmentInput).filename === 'string'
    && typeof (item as AgentMessageAttachmentInput).mediaType === 'string'
    && typeof (item as AgentMessageAttachmentInput).size === 'number'
    && typeof (item as AgentMessageAttachmentInput).threadPath === 'string'
  ))
}

function readPersistedAssistantTokenUsage(metadata: Record<string, unknown> | undefined): RuntimeAssistantTokenUsageView | undefined {
  const raw = metadata?.tokenUsage
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const tokenUsage = raw as Record<string, unknown>
  if (tokenUsage.source !== 'provider') return undefined
  const billingUsage = asRecord(tokenUsage.billingUsage)
  const contextUsage = asRecord(tokenUsage.contextUsage)
  const usage: RuntimeAssistantTokenUsageView = {}
  assignFiniteUsageNumber(usage, 'inputTokens', billingUsage?.inputTokens)
  assignFiniteUsageNumber(usage, 'outputTokens', tokenUsage.providerOutputTokens ?? billingUsage?.outputTokens)
  assignFiniteUsageNumber(usage, 'cacheReadInputTokens', billingUsage?.cacheReadInputTokens)
  assignFiniteUsageNumber(usage, 'cacheCreationInputTokens', billingUsage?.cacheCreationInputTokens)
  assignFiniteUsageNumber(usage, 'cachedTokens', billingUsage?.cachedTokens)
  assignFiniteUsageNumber(usage, 'contextTokens', contextUsage?.totalTokens)
  assignFiniteUsageNumber(usage, 'contextWindow', contextUsage?.contextWindow)
  if (usage.cachedTokens === undefined) {
    const cachedTokens = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    if (cachedTokens > 0) usage.cachedTokens = cachedTokens
  }
  if (usage.contextTokens !== undefined && usage.contextWindow !== undefined && usage.contextWindow > 0) {
    usage.contextPercent = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function assignFiniteUsageNumber<K extends keyof RuntimeAssistantTokenUsageView>(
  usage: RuntimeAssistantTokenUsageView,
  key: K,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    usage[key] = Math.max(0, Math.round(value)) as RuntimeAssistantTokenUsageView[K]
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function projectPersistedCompactionMessages(
  message: AgentMessage,
  fallbackCreatedAt: string,
): RuntimeMessageView[] {
  if (!Array.isArray(message.sdkMessages)) return []
  return message.sdkMessages
    .map((sdkMessage, index) => projectPersistedCompactionMessage(message.id, index, sdkMessage, fallbackCreatedAt))
    .filter((item): item is Extract<RuntimeMessageView, { type: 'system'; variant: 'context_compaction' }> => item !== null)
}

function projectPersistedCompactionMessage(
  messageId: string,
  index: number,
  sdkMessage: SDKMessage,
  fallbackCreatedAt: string,
): Extract<RuntimeMessageView, { type: 'system'; variant: 'context_compaction' }> | null {
  if (sdkMessage.type !== 'system') return null
  if (
    sdkMessage.subtype !== 'context_compaction_started'
    && sdkMessage.subtype !== 'context_compaction_progress'
    && sdkMessage.subtype !== 'compact_boundary'
  ) return null
  const metadata = asRecord((sdkMessage as SDKMessage & { compact_metadata?: unknown }).compact_metadata)
  const mode = metadata?.trigger === 'manual' ? '手动' : '自动'
  const progressMessage = typeof metadata?.message === 'string' ? metadata.message : undefined
  const createdAt = typeof (sdkMessage as SDKMessage & { timestamp?: unknown }).timestamp === 'string'
    ? (sdkMessage as SDKMessage & { timestamp: string }).timestamp
    : fallbackCreatedAt
  return {
    id: `${messageId}:${index}:${sdkMessage.subtype}`,
    type: 'system',
    variant: 'context_compaction',
    status: sdkMessage.subtype === 'compact_boundary' ? 'completed' : 'active',
    text: sdkMessage.subtype === 'context_compaction_progress'
      ? progressMessage ?? `正在${mode}压缩上下文`
      : sdkMessage.subtype === 'context_compaction_started'
      ? `正在${mode}压缩上下文`
      : `上下文已${mode}压缩`,
    createdAt,
  }
}

function projectVisibleAssistantBlocks(message: AgentMessage): Extract<RuntimeMessageView, { type: 'assistant' }>['blocks'] {
  const blocks: Extract<RuntimeMessageView, { type: 'assistant' }>['blocks'] = []
  if (message.reasoning?.trim()) {
    blocks.push({
      type: 'thinking',
      id: `thinking:${message.id}`,
      text: message.reasoning,
    })
  }
  if (message.content.trim()) {
    blocks.push({
      type: 'text',
      id: `text:${message.id}`,
      text: message.content,
    })
  }
  return blocks
}

/**
 * 流式时 projection 每 token 重建所有 message（及 block）对象引用，导致 memo 默认浅
 * 比较失效、整列表 + 流式消息内部未变 block 都每 token re-render。stabilize 在消费层
 * （AgentMessages）做引用稳定化：
 *
 * - message 级：内容签名（JSON.stringify）相同 → 复用旧 message 引用（含旧 blocks）。
 * - block 级（仅 assistant）：签名变化时，按 block.id 匹配上一帧 block，内容相同则复用
 *   旧 block 引用。即使 id 偶尔失配（如 assistant.final 重排），stringify 内容比较兜底，
 *   最坏只是「不复用」，不会「错误复用」。
 *
 * cache 跨 token 保持（useRef），消息移除时自动清理对应条目。
 */
export type RuntimeMessageStabilizeCache = Map<string, { signature: string; message: RuntimeMessageView }>

export function stabilizeRuntimeMessages(
  messages: RuntimeMessageView[],
  cache: RuntimeMessageStabilizeCache,
): RuntimeMessageView[] {
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) cache.delete(id)
  }
  return messages.map((message) => {
    const signature = JSON.stringify(message)
    const cached = cache.get(message.id)
    if (cached && cached.signature === signature) {
      return cached.message
    }
    const stabilized = stabilizeRuntimeMessageBlocks(message, cached?.message)
    cache.set(message.id, { signature, message: stabilized })
    return stabilized
  })
}

function stabilizeRuntimeMessageBlocks(
  message: RuntimeMessageView,
  prevMessage: RuntimeMessageView | undefined,
): RuntimeMessageView {
  if (message.type !== 'assistant' || prevMessage?.type !== 'assistant') {
    return message
  }
  const prevById = new Map(prevMessage.blocks.map((block) => [block.id, block]))
  let reusedAny = false
  const nextBlocks = message.blocks.map((block) => {
    const prev = prevById.get(block.id)
    if (prev && JSON.stringify(prev) === JSON.stringify(block)) {
      reusedAny = true
      return prev
    }
    return block
  })
  if (!reusedAny) return { ...message }
  return { ...message, blocks: nextBlocks }
}
