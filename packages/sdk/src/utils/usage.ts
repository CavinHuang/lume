import type {
  ContextUsageSnapshot,
  NormalizedProviderUsage,
  UsageIdentity,
} from '../types.js'
import type { NormalizedMessageParam } from '../providers/types.js'
import { estimateMessagesTokens } from './tokens.js'

export interface NormalizeProviderUsageOptions {
  inputIncludesCache?: boolean
}

export function normalizeProviderUsage(
  raw: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    cache_creation?: {
      ephemeral_5m_input_tokens?: number
      ephemeral_1h_input_tokens?: number
    }
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    input_tokens_details?: {
      cached_tokens?: number
    }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    promptTokenCount?: number
    cachedContentTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    usageMetadata?: {
      promptTokenCount?: number
      cachedContentTokenCount?: number
      candidatesTokenCount?: number
      thoughtsTokenCount?: number
    }
  },
  options: NormalizeProviderUsageOptions = {},
): NormalizedProviderUsage {
  const usageMetadata = raw.usageMetadata
  const cacheReadInputTokens = tokenValue(
    raw.cache_read_input_tokens
      ?? raw.cacheReadInputTokens
      ?? raw.input_tokens_details?.cached_tokens
      ?? raw.prompt_tokens_details?.cached_tokens
      ?? raw.prompt_cache_hit_tokens
      ?? raw.cachedContentTokenCount
      ?? usageMetadata?.cachedContentTokenCount,
  )
  const cacheCreationInputTokens = tokenValue(
    raw.cache_creation_input_tokens
      ?? raw.cacheCreationInputTokens
      ?? sumAnthropicCacheCreation(raw.cache_creation),
  )
  const cachedTokens = cacheReadInputTokens + cacheCreationInputTokens
  const promptCacheMissTokens = numberOrUndefined(raw.prompt_cache_miss_tokens)
  const reportedInputTokens = tokenValue(
    promptCacheMissTokens
      ?? raw.input_tokens
      ?? raw.inputTokens
      ?? raw.prompt_tokens
      ?? raw.promptTokenCount
      ?? usageMetadata?.promptTokenCount,
  )
  const inputIncludesCache = promptCacheMissTokens === undefined
    && (options.inputIncludesCache
      || raw.input_tokens_details?.cached_tokens !== undefined
      || raw.prompt_tokens_details?.cached_tokens !== undefined
      || raw.prompt_cache_hit_tokens !== undefined
      || raw.cachedContentTokenCount !== undefined
      || usageMetadata?.cachedContentTokenCount !== undefined)
  const inputTokens = inputIncludesCache
    ? Math.max(0, reportedInputTokens - cachedTokens)
    : reportedInputTokens
  const directOutputTokens = numberOrUndefined(raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens)
  const outputTokens = directOutputTokens
    ?? (
      tokenValue(raw.candidatesTokenCount ?? usageMetadata?.candidatesTokenCount)
      + tokenValue(raw.thoughtsTokenCount ?? usageMetadata?.thoughtsTokenCount)
    )

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: inputTokens + outputTokens + cachedTokens,
  }
}

export function createEstimatedContextUsage(input: {
  messageTokens: number
  systemTokens?: number
  memoryTokens?: number
  toolSchemaTokens?: number
  contextWindow: number
  contextWindowSource: ContextUsageSnapshot['contextWindowSource']
}): ContextUsageSnapshot {
  const sections = {
    systemTokens: tokenValue(input.systemTokens),
    memoryTokens: tokenValue(input.memoryTokens),
    toolSchemaTokens: tokenValue(input.toolSchemaTokens),
    messageTokens: tokenValue(input.messageTokens),
  }
  const totalTokens =
    sections.systemTokens
    + sections.memoryTokens
    + sections.toolSchemaTokens
    + sections.messageTokens

  return {
    source: 'estimated',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens,
    estimatedTailTokens: totalTokens,
    sections,
    contextWindow: tokenValue(input.contextWindow),
    contextWindowSource: input.contextWindowSource,
  }
}

export function createContextUsageSnapshot(
  messages: Array<NormalizedMessageParam & {
    usage?: NormalizedProviderUsage
    usageIdentity?: UsageIdentity
  }>,
  options: {
    threadId: string
    contextWindow: number
    contextWindowSource: ContextUsageSnapshot['contextWindowSource']
    systemTokens?: number
    memoryTokens?: number
    toolSchemaTokens?: number
  },
): ContextUsageSnapshot {
  const anchorIndex = findLatestConversationUsageAnchor(messages, options.threadId)
  if (anchorIndex === -1) {
    return createEstimatedContextUsage({
      messageTokens: estimateMessagesTokens(messages),
      systemTokens: options.systemTokens,
      memoryTokens: options.memoryTokens,
      toolSchemaTokens: options.toolSchemaTokens,
      contextWindow: options.contextWindow,
      contextWindowSource: options.contextWindowSource,
    })
  }

  const anchor = messages[anchorIndex]!
  const usage = anchor.usage!
  const estimationStartIndex = findFirstSplitResponseSiblingIndex(messages, anchorIndex, options.threadId)
  const tailMessages = messages.slice(estimationStartIndex + 1)
  const estimatedTailTokens = estimateMessagesTokens(tailMessages)
  return {
    source: 'provider',
    inputTokens: usage.inputTokens + estimatedTailTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    totalTokens: usage.totalTokens + estimatedTailTokens,
    estimatedTailTokens,
    contextWindow: tokenValue(options.contextWindow),
    contextWindowSource: options.contextWindowSource,
  }
}

function findLatestConversationUsageAnchor(
  messages: Array<NormalizedMessageParam & {
    usage?: NormalizedProviderUsage
    usageIdentity?: UsageIdentity
  }>,
  threadId: string,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !message.usage || !message.usageIdentity) continue
    if (message.usageIdentity.threadId !== threadId) continue
    if (message.usageIdentity.callerKind !== 'conversation') continue
    return index
  }
  return -1
}

function findFirstSplitResponseSiblingIndex(
  messages: Array<NormalizedMessageParam & {
    usage?: NormalizedProviderUsage
    usageIdentity?: UsageIdentity
  }>,
  anchorIndex: number,
  threadId: string,
): number {
  const responseId = messages[anchorIndex]?.usageIdentity?.responseId
  if (!responseId) return anchorIndex

  let startIndex = anchorIndex
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const identity = message?.usageIdentity
    const priorResponseId = identity?.responseId
    if (
      message?.role === 'assistant'
      && priorResponseId === responseId
      && identity?.threadId === threadId
      && identity.callerKind === 'conversation'
    ) {
      startIndex = index
      continue
    }
    if (message?.role === 'assistant' && priorResponseId && priorResponseId !== responseId) {
      break
    }
  }
  return startIndex
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function sumAnthropicCacheCreation(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const cacheCreation = value as {
    ephemeral_5m_input_tokens?: unknown
    ephemeral_1h_input_tokens?: unknown
  }
  return tokenValue(cacheCreation.ephemeral_5m_input_tokens)
    + tokenValue(cacheCreation.ephemeral_1h_input_tokens)
}
