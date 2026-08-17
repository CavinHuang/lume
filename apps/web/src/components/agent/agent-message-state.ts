import type { AgentCapabilityReferenceView, AgentMessage, AgentMessageAttachmentInput, AgentUserMessagePart, SDKMessage } from '@lume/shared'
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

export interface ConversationMinimapItem {
  id: string
  title: string
  preview: string
}

export function collectConversationMinimapItems(
  messages: RuntimeMessageView[],
): ConversationMinimapItem[] {
  const items: ConversationMinimapItem[] = []
  let currentUser: Extract<RuntimeMessageView, { type: 'user' }> | null = null
  let assistantParts: string[] = []

  const pushCurrent = () => {
    if (!currentUser) return
    items.push({
      id: currentUser.id,
      title: currentUser.text,
      preview: assistantParts.join('\n\n').trim(),
    })
    currentUser = null
    assistantParts = []
  }

  for (const message of messages) {
    if (message.type === 'user') {
      pushCurrent()
      currentUser = message
      continue
    }
    if (message.type !== 'assistant' || !currentUser) continue
    const text = message.text.trim()
    if (text) assistantParts.push(text)
  }

  pushCurrent()
  return items
}

export type ReconcileCache = Map<string, {
  projectedRef: RuntimeMessageView
  visibleRef: AgentMessage | undefined
  result: RuntimeMessageView
}>

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
  cache?: ReconcileCache,
): RuntimeMessageView[] {
  if (visibleThreadMessages.length === 0) return messages

  const visibleUsersById = new Map<string, AgentMessage>()
  const visibleUsersByContent = new Map<string, AgentMessage[]>()
  const visibleAssistantsById = new Map<string, AgentMessage>()
  const visibleAssistantsByContent = new Map<string, AgentMessage[]>()
  for (const visible of visibleThreadMessages) {
    if (visible.role === 'user') {
      visibleUsersById.set(visible.id, visible)
      pushGroup(visibleUsersByContent, visible.content, visible)
    } else if (visible.role === 'assistant') {
      visibleAssistantsById.set(visible.id, visible)
      pushGroup(visibleAssistantsByContent, visible.content, visible)
    }
  }
  if (visibleUsersById.size === 0 && visibleAssistantsByContent.size === 0) return messages

  const effectiveCache = cache ?? new Map()
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of effectiveCache.keys()) {
    if (!liveIds.has(id)) effectiveCache.delete(id)
  }

  const usedVisibleIds = new Set<string>()
  const usedVisibleAssistantIds = new Set<string>()
  return messages.map((message) => {
    const visible = matchVisibleMessage(
      message,
      visibleUsersById,
      visibleUsersByContent,
      visibleAssistantsById,
      visibleAssistantsByContent,
      usedVisibleIds,
      usedVisibleAssistantIds,
    )
    const cached = effectiveCache.get(message.id)
    if (cached && cached.projectedRef === message && cached.visibleRef === visible) {
      return cached.result
    }
    const result = applyReconciledMessage(message, visible)
    effectiveCache.set(message.id, { projectedRef: message, visibleRef: visible, result })
    return result
  })
}

function pushGroup(map: Map<string, AgentMessage[]>, key: string, message: AgentMessage): void {
  const list = map.get(key)
  if (list) list.push(message)
  else map.set(key, [message])
}

function matchVisibleMessage(
  message: RuntimeMessageView,
  visibleUsersById: Map<string, AgentMessage>,
  visibleUsersByContent: Map<string, AgentMessage[]>,
  visibleAssistantsById: Map<string, AgentMessage>,
  visibleAssistantsByContent: Map<string, AgentMessage[]>,
  usedVisibleIds: Set<string>,
  usedVisibleAssistantIds: Set<string>,
): AgentMessage | undefined {
  if (message.type === 'user') {
    if (message.messageId) {
      return visibleUsersById.get(message.messageId)
    }
    const group = visibleUsersByContent.get(message.text) ?? []
    const withinWindow = group.find((item) => (
      !usedVisibleIds.has(item.id)
      && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
    ))
    if (withinWindow) {
      usedVisibleIds.add(withinWindow.id)
      return withinWindow
    }
    const byContent = group.find((item) => !usedVisibleIds.has(item.id))
    if (byContent) {
      usedVisibleIds.add(byContent.id)
      return byContent
    }
    return undefined
  }
  if (message.type === 'assistant') {
    if (message.messageId) {
      const byId = visibleAssistantsById.get(message.messageId)
      if (byId) {
        usedVisibleAssistantIds.add(byId.id)
        return byId
      }
    }
    const group = visibleAssistantsByContent.get(message.text) ?? []
    const visible = group.find((item) => !usedVisibleAssistantIds.has(item.id))
    if (visible) {
      usedVisibleAssistantIds.add(visible.id)
      return visible
    }
    return undefined
  }
  return undefined
}

function applyReconciledMessage(
  message: RuntimeMessageView,
  visible: AgentMessage | undefined,
): RuntimeMessageView {
  if (!visible) return message
  if (message.type === 'user') {
    return withPersistedUserMessage(message, visible)
  }
  if (message.type === 'assistant') {
    const providerTokenUsage = readPersistedAssistantTokenUsage(visible.metadata)
    const providerOutputTokens = providerTokenUsage?.outputTokens
    const shouldRestoreContent = !message.text.trim() && visible.content.trim().length > 0
    const persistedBlocks = shouldRestoreContent ? projectVisibleAssistantBlocks(visible) : []
    return {
      ...message,
      ...(shouldRestoreContent
        ? {
            text: visible.content,
            thinking: message.thinking || visible.reasoning || '',
            blocks: [
              ...persistedBlocks.filter((block) => block.type === 'text' || block.type === 'thinking'),
              ...message.blocks,
            ],
          }
        : {}),
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
}

export function projectVisibleThreadMessages(visibleThreadMessages: AgentMessage[]): RuntimeMessageView[] {
  const projected: RuntimeMessageView[] = []
  for (const message of visibleThreadMessages) {
    const createdAt = new Date(message.createdAt).toISOString()
    projected.push(...projectPersistedCompactionMessages(message, createdAt))
    if (message.role === 'user') {
      projected.push(withPersistedUserMessage({
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
        ...(message.fileReferenceBinding ? { fileReferenceBinding: message.fileReferenceBinding } : {}),
        ...(message.fileReferenceProtocolVersion ? { fileReferenceProtocolVersion: message.fileReferenceProtocolVersion } : {}),
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

/**
 * 比较两批消息的"结构身份"是否一致(长度相同,且逐条引用相同或同位置 id 相同)。
 * 流式期间只有活跃消息是新引用且 id 不变,历史前缀保持原引用;
 * 借此让 minimap 等只关心消息身份的派生在 token 帧间保持旧数组引用,避免全量重算。
 */
export function haveSameMessageIdentities(previous: RuntimeMessageView[], next: RuntimeMessageView[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    const prev = previous[index]
    const curr = next[index]
    if (prev === curr) continue
    if (prev?.id !== curr?.id) return false
  }
  return true
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
  const messageParts = readPersistedMessageParts(visible.metadata)
  const capabilityReferences = readPersistedCapabilityReferences(visible.metadata)
  return withPersistedUserAttachments({
    ...message,
    id: visible.id,
    text: visible.content,
    messageId: visible.id,
    versionGroupId: visible.versionGroupId,
    versionIndex: visible.versionIndex,
    versionCount: visible.versionCount,
    ...(messageParts.length > 0 ? { messageParts } : {}),
    ...(capabilityReferences.length > 0 ? { capabilityReferences } : {}),
  }, visible)
}

function readPersistedMessageParts(metadata: Record<string, unknown> | undefined): AgentUserMessagePart[] {
  const raw = metadata?.messageParts
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentUserMessagePart => {
    if (!item || typeof item !== 'object') return false
    const part = item as Record<string, unknown>
    return (part.type === 'text' && typeof part.text === 'string')
      || (part.type === 'capability_ref'
        && typeof part.occurrenceId === 'string'
        && typeof part.uri === 'string')
      || (part.type === 'planning_todo_ref'
        && part.schemaVersion === 1
        && typeof part.uri === 'string'
        && typeof part.todoId === 'string'
        && (part.relation === 'mentioned' || part.relation === 'primary')
        && typeof part.displayText === 'string')
      || (part.type === 'link_connection_ref'
        && part.schemaVersion === 1
        && typeof part.service === 'string'
        && typeof part.connectionName === 'string'
        && typeof part.displayText === 'string')
  })
}

function readPersistedCapabilityReferences(metadata: Record<string, unknown> | undefined): AgentCapabilityReferenceView[] {
  const raw = metadata?.capabilityReferenceViews
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentCapabilityReferenceView => (
    item !== null
    && typeof item === 'object'
    && typeof (item as AgentCapabilityReferenceView).uri === 'string'
    && typeof (item as AgentCapabilityReferenceView).displayName === 'string'
    && typeof (item as AgentCapabilityReferenceView).kind === 'string'
    && typeof (item as AgentCapabilityReferenceView).callable === 'boolean'
  ))
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
    const cachedTokens = usage.cacheReadInputTokens ?? 0
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
  const projectedByRun = new Map<string, Extract<RuntimeMessageView, { type: 'system'; variant: 'context_compaction' }>>()
  for (const [index, sdkMessage] of message.sdkMessages.entries()) {
    const projected = projectPersistedCompactionMessage(message.id, index, sdkMessage, fallbackCreatedAt)
    if (!projected) continue
    const runId = typeof (sdkMessage as SDKMessage & { session_id?: unknown }).session_id === 'string'
      ? (sdkMessage as SDKMessage & { session_id: string }).session_id
      : message.id
    const existing = projectedByRun.get(runId)
    projectedByRun.set(runId, existing ? { ...projected, id: existing.id } : projected)
  }
  return [...projectedByRun.values()]
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
  const summary = typeof metadata?.summary === 'string'
    ? metadata.summary
    : typeof (sdkMessage as SDKMessage & { summary?: unknown }).summary === 'string'
      ? (sdkMessage as SDKMessage & { summary: string }).summary
      : undefined
  const compactionFailed = metadata?.outcome === 'failed'
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
      : compactionFailed
        ? '上下文压缩失败，已保留原上下文'
        : `上下文已${mode}压缩`,
    ...(sdkMessage.subtype === 'compact_boundary' && !compactionFailed && summary ? { summary } : {}),
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
 * 流式时 projection 重建 message（及 block）对象引用，stabilize 在消费层（AgentMessages）
 * 做引用稳定化。2b 增量投影 + 2c reconcile memoize 已让未变消息引用稳定，stabilize 退化
 * 为纯引用比较（不再用 JSON.stringify）：
 *
 * - message 级：引用相同（cached.message === message）→ 复用旧 message 引用（含旧 blocks）。
 * - block 级（仅 assistant）：按 block.id 匹配上一帧 block，引用相同（prev === block）则复用。
 *
 * cache 跨 token 保持（useRef），消息移除时自动清理对应条目。
 */
export type RuntimeMessageStabilizeCache = Map<string, { message: RuntimeMessageView }>

export function stabilizeRuntimeMessages(
  messages: RuntimeMessageView[],
  cache: RuntimeMessageStabilizeCache,
): RuntimeMessageView[] {
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) cache.delete(id)
  }
  return messages.map((message) => {
    const cached = cache.get(message.id)
    if (cached?.message === message) return cached.message
    const stabilized = stabilizeRuntimeMessageBlocks(message, cached?.message)
    cache.set(message.id, { message: stabilized })
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
    if (prev && prev === block) {
      reusedAny = true
      return prev
    }
    return block
  })
  if (!reusedAny) return { ...message }
  return { ...message, blocks: nextBlocks }
}
