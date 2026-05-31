import type { AgentMessage, AgentMessageAttachmentInput, SDKMessage } from '@lume/shared'
import type { RuntimeAssistantTokenUsageView, RuntimeMessageView } from './runtime-message-view'

const SCROLL_BOTTOM_THRESHOLD_PX = 80

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
  currentScrollTop,
  previousScrollTop,
  nearBottom,
}: {
  currentScrollTop: number
  previousScrollTop: number
  nearBottom: boolean
}): boolean {
  if (currentScrollTop < previousScrollTop) return false
  return nearBottom
}

export function getPreservedScrollTopAfterResize({
  currentScrollTop,
  previousScrollHeight,
  nextScrollHeight,
}: {
  currentScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
}): number {
  if (previousScrollHeight <= 0 || previousScrollHeight === nextScrollHeight) {
    return currentScrollTop
  }
  return currentScrollTop + nextScrollHeight - previousScrollHeight
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
  if (sdkMessage.subtype !== 'context_compaction_started' && sdkMessage.subtype !== 'compact_boundary') return null
  const metadata = asRecord((sdkMessage as SDKMessage & { compact_metadata?: unknown }).compact_metadata)
  const mode = metadata?.trigger === 'manual' ? '手动' : '自动'
  const createdAt = typeof (sdkMessage as SDKMessage & { timestamp?: unknown }).timestamp === 'string'
    ? (sdkMessage as SDKMessage & { timestamp: string }).timestamp
    : fallbackCreatedAt
  return {
    id: `${messageId}:${index}:${sdkMessage.subtype}`,
    type: 'system',
    variant: 'context_compaction',
    status: sdkMessage.subtype === 'context_compaction_started' ? 'active' : 'completed',
    text: sdkMessage.subtype === 'context_compaction_started'
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
