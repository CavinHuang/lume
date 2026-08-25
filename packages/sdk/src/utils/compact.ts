/**
 * Context Compression / Auto-Compaction
 *
 * Summarizes older history while retaining recent messages verbatim.
 */

import type { CompactionFailureReason } from '@lume/shared'
import type { LLMProvider, NormalizedMessageParam } from '../providers/types.js'
import type {
  AgentContextCompactionTrigger,
  NormalizedProviderUsage,
} from '../types.js'
import {
  estimateMessagesTokens,
  estimateTokens,
  getContextWindowSize,
} from './tokens.js'
import {
  createEstimatedContextUsage,
  normalizeProviderUsage,
} from './usage.js'
import { renderComputerUseActionFacts, stripImagesFromMessages } from './messages.js'

const DEFAULT_RESERVE_TOKENS = 16_384
const MAX_RESERVE_TOKENS = 20_000
const DEFAULT_KEEP_RECENT_TOKENS = 20_000
const TOOL_RESULT_MAX_CHARS = 2_000

/**
 * 熔断阈值：proactive(auto)压缩与 prompt_too_long 恢复各自计数、共享同一
 * 断路值。原三处字面量 3 提常量（#709 第 7 项）。
 */
export const COMPACTION_BREAKER_THRESHOLD = 3

/**
 * 摘要请求输入预算的安全边际（system prompt + 指令段 + 估算误差），
 * 从模型窗口中扣除后再给序列化文本定上限。
 */
const SUMMARY_INPUT_SAFETY_MARGIN_TOKENS = 4_096

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints, preferences, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Facts, examples, file paths, function names, and exact error messages needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE Progress and Next Steps based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- Remove information only when it is no longer relevant

Use the same EXACT headings as the existing summary:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context`

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix using this EXACT format:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Preserve exact file paths, function names, and error messages.`

const REQUIRED_SUMMARY_HEADINGS = [
  '## Goal',
  '## Constraints & Preferences',
  '## Progress',
  '### Done',
  '### In Progress',
  '### Blocked',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
]

const REQUIRED_TURN_PREFIX_HEADINGS = [
  '## Original Request',
  '## Early Progress',
  '## Context for Suffix',
]

// Single-sourced in @lume/shared (src/types/sdk-protocol.ts); re-exported for
// existing `import('./utils/compact.js').CompactionFailureReason` consumers.
export type { CompactionFailureReason }

export interface AutoCompactState {
  compacted: boolean
  turnCounter: number
  consecutiveFailures: number
}

export interface CompactionPreparation {
  messagesToSummarize: NormalizedMessageParam[]
  turnPrefixMessages: NormalizedMessageParam[]
  retainedTail: NormalizedMessageParam[]
  previousSummary?: string
  isSplitTurn: boolean
  tokensBefore: number
  protectedUserMessage?: NormalizedMessageParam
}

export interface CompactConversationOptions {
  trigger?: AgentContextCompactionTrigger
  reserveTokens?: number
  keepRecentTokens?: number
  protectedMessageIndex?: number
  maxSummaryTokens?: number
  abortSignal?: AbortSignal
}

export interface CompactConversationResult {
  compacted: boolean
  compactedMessages: NormalizedMessageParam[]
  summary: string
  state: AutoCompactState
  failureReason?: CompactionFailureReason
  usage?: NormalizedProviderUsage
  retainedTokens?: number
  retainedMessageCount?: number
}

interface SummaryCallResult {
  text: string
  usage: NormalizedProviderUsage
}

interface FileOperations {
  read: Set<string>
  modified: Set<string>
}

export function createAutoCompactState(): AutoCompactState {
  return {
    compacted: false,
    turnCounter: 0,
    consecutiveFailures: 0,
  }
}

/** Check the current request against the resolved model window. */
export function shouldAutoCompact(
  messages: any[],
  model: string,
  state: AutoCompactState,
  options: {
    contextUsage?: { totalTokens: number; contextWindow: number }
    maxOutputTokens?: number
  } = {},
): boolean {
  if (state.consecutiveFailures >= COMPACTION_BREAKER_THRESHOLD) return false

  const contextUsage = options.contextUsage ?? createEstimatedContextUsage({
    messageTokens: estimateMessagesTokens(stripImagesFromMessages(messages)),
    contextWindow: getContextWindowSize(model),
    contextWindowSource: 'model',
  })
  const reserveTokens = Math.min(
    Math.max(0, options.maxOutputTokens ?? DEFAULT_RESERVE_TOKENS),
    MAX_RESERVE_TOKENS,
  )
  return contextUsage.totalTokens > Math.max(0, contextUsage.contextWindow - reserveTokens)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object'
}

function isCompactionBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value)
    && value.type === 'text'
    && typeof value.text === 'string'
    && value._meta?.contextBlock === 'compaction'
}

function extractCompactionSummary(message: NormalizedMessageParam): string | undefined {
  if (!Array.isArray(message.content)) return undefined
  return message.content.find(isCompactionBlock)?.text
}

function isToolResultOnlyMessage(message: NormalizedMessageParam): boolean {
  return Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => isRecord(block) && block.type === 'tool_result')
}

function isTurnStartMessage(message: NormalizedMessageParam): boolean {
  return message.role === 'user'
    && !isToolResultOnlyMessage(message)
    && extractCompactionSummary(message) === undefined
}

function findValidCutPoints(
  messages: NormalizedMessageParam[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = []
  for (let index = startIndex; index < endIndex; index++) {
    const message = messages[index]!
    if (!isToolResultOnlyMessage(message) && extractCompactionSummary(message) === undefined) {
      cutPoints.push(index)
    }
  }
  return cutPoints
}

function findTurnStartIndex(
  messages: NormalizedMessageParam[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let index = entryIndex; index >= startIndex; index--) {
    if (isTurnStartMessage(messages[index]!)) return index
  }
  return -1
}

export function findCompactionCutPoint(
  messages: NormalizedMessageParam[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): { firstKeptIndex: number; turnStartIndex: number; isSplitTurn: boolean } {
  const cutPoints = findValidCutPoints(messages, startIndex, endIndex)
  if (cutPoints.length === 0) {
    return { firstKeptIndex: startIndex, turnStartIndex: -1, isSplitTurn: false }
  }

  let accumulatedTokens = 0
  let cutIndex = cutPoints[0]!
  for (let index = endIndex - 1; index >= startIndex; index--) {
    accumulatedTokens += estimateMessagesTokens([messages[index]!])
    if (accumulatedTokens < keepRecentTokens) continue
    cutIndex = cutPoints.find((candidate) => candidate >= index) ?? cutPoints[cutPoints.length - 1]!
    break
  }

  const turnStartIndex = isTurnStartMessage(messages[cutIndex]!)
    ? -1
    : findTurnStartIndex(messages, cutIndex, startIndex)
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: turnStartIndex !== -1,
  }
}

export function prepareCompaction(
  messages: NormalizedMessageParam[],
  options: Pick<CompactConversationOptions, 'keepRecentTokens' | 'protectedMessageIndex'> = {},
): CompactionPreparation | undefined {
  if (messages.length === 0) return undefined

  let previousSummary: string | undefined
  let boundaryStart = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const summary = extractCompactionSummary(messages[index]!)
    if (!summary) continue
    previousSummary = summary
    boundaryStart = index + 1
    break
  }
  if (boundaryStart >= messages.length) return undefined

  const cutPoint = findCompactionCutPoint(
    messages,
    boundaryStart,
    messages.length,
    options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
  )
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex
  const protectedMessageIndex = options.protectedMessageIndex
  const protectedUserMessage = protectedMessageIndex !== undefined
    && protectedMessageIndex >= boundaryStart
    && protectedMessageIndex < cutPoint.firstKeptIndex
    && isTurnStartMessage(messages[protectedMessageIndex]!)
    ? messages[protectedMessageIndex]
    : undefined

  // The protected message is re-inserted verbatim after the summary; drop it
  // from the serialized ranges so it is not summarized (and duplicated) too.
  const inSummarizedRange = (message: NormalizedMessageParam[]): NormalizedMessageParam[] =>
    protectedUserMessage
      ? message.filter((item) => item !== protectedUserMessage)
      : message

  return {
    messagesToSummarize: inSummarizedRange(messages.slice(boundaryStart, historyEnd)),
    turnPrefixMessages: inSummarizedRange(
      cutPoint.isSplitTurn
        ? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex)
        : [],
    ),
    retainedTail: messages.slice(cutPoint.firstKeptIndex),
    previousSummary,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore: estimateMessagesTokens(messages),
    protectedUserMessage,
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

function describeImage(block: Record<string, any>): string {
  const source = isRecord(block.source) ? block.source : {}
  const path = typeof source.path === 'string' ? source.path : undefined
  const mediaType = typeof source.media_type === 'string'
    ? source.media_type
    : typeof block.mimeType === 'string'
      ? block.mimeType
      : 'image'
  return path ? `[Image reference: ${path}]` : `[Image omitted: ${mediaType}]`
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : safeJsonStringify(content)
  return content.map((block) => {
    if (!isRecord(block)) return String(block)
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (block.type === 'image') return describeImage(block)
    return safeJsonStringify(block)
  }).filter(Boolean).join('\n')
}

export function serializeConversation(messages: NormalizedMessageParam[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'runtime') {
      const content = contentToText(message.content)
      if (content) parts.push(`[Runtime]: ${content}`)
      continue
    }
    if (message.role === 'user') {
      if (Array.isArray(message.content) && isToolResultOnlyMessage(message)) {
        for (const block of message.content) {
          const record = block as Record<string, any>
          const content = contentToText(record.content)
          parts.push(`[Tool result ${String(record.tool_use_id ?? '')}]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`)
        }
      } else {
        const content = contentToText(message.content)
        if (content) parts.push(`[User]: ${content}`)
      }
      continue
    }

    if (typeof message.content === 'string') {
      if (message.content) parts.push(`[Assistant]: ${message.content}`)
      continue
    }
    const thinking: string[] = []
    const text: string[] = []
    const toolCalls: string[] = []
    for (const block of message.content) {
      const record = block as Record<string, any>
      if (record.type === 'thinking' && typeof record.thinking === 'string') {
        thinking.push(record.thinking)
      } else if (record.type === 'text' && typeof record.text === 'string') {
        text.push(record.text)
      } else if (record.type === 'tool_use') {
        toolCalls.push(`${String(record.name ?? 'tool')}(${safeJsonStringify(record.input ?? {})})`)
      } else if (record.type === 'image') {
        text.push(describeImage(record))
      }
    }
    if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join('\n')}`)
    if (text.length > 0) parts.push(`[Assistant]: ${text.join('\n')}`)
    if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
  }
  return parts.join('\n\n')
}

function collectFileOperations(messages: NormalizedMessageParam[]): FileOperations {
  const fileOps: FileOperations = { read: new Set(), modified: new Set() }
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const record = block as Record<string, any>
      if (record.type !== 'tool_use' || !isRecord(record.input)) continue
      const name = String(record.name ?? '').toLowerCase()
      const paths = ['path', 'file_path', 'filePath', 'target_file', 'targetFile']
        .map((key) => record.input[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
      for (const path of paths) {
        if (/write|edit|patch|create|delete|move|rename/.test(name)) fileOps.modified.add(path)
        else if (/read|grep|glob|search|view/.test(name)) fileOps.read.add(path)
      }
    }
  }
  return fileOps
}

function formatFileOperations(fileOps: FileOperations): string {
  const modifiedFiles = [...fileOps.modified].sort()
  const readFiles = [...fileOps.read].filter((path) => !fileOps.modified.has(path)).sort()
  const sections: string[] = []
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`)
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`)
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}

function validateSummary(text: string, requiredHeadings: string[]): CompactionFailureReason | undefined {
  if (!text.trim()) return 'empty_summary'
  if (requiredHeadings.some((heading) => !text.includes(heading))) return 'invalid_structure'
  const lineCounts = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim().replace(/\s+/g, ' ')
    if (!normalized) continue
    const count = (lineCounts.get(normalized) ?? 0) + 1
    if (count > 5) return 'repetitive_summary'
    lineCounts.set(normalized, count)
  }
  return undefined
}

/**
 * 摘要输入上限裁切（#709 第 6 项）：序列化文本无界时，小窗模型的摘要请求自身
 * 超窗必败、×3 烧完熔断。按模型窗口给输入定预算，超限保头（目标）保尾（近期
 * 进展）截中。治本是给模型显式配置真实 contextWindow。
 */
export function truncateSerializedConversation(text: string, inputBudgetTokens: number): string {
  const textTokens = estimateTokens(text)
  if (textTokens <= inputBudgetTokens) return text
  const charsPerToken = text.length / Math.max(1, textTokens)
  const maxChars = Math.floor(inputBudgetTokens * charsPerToken)
  const headChars = Math.floor(maxChars * 0.4)
  const tailChars = Math.max(0, maxChars - headChars)
  return `${text.slice(0, headChars)}\n\n[... ${text.length - maxChars} characters truncated ...]\n\n${text.slice(-tailChars)}`
}

async function generateSummary(
  provider: LLMProvider,
  model: string,
  messages: NormalizedMessageParam[],
  maxTokens: number,
  options: {
    previousSummary?: string
    turnPrefix?: boolean
    abortSignal?: AbortSignal
  },
): Promise<SummaryCallResult> {
  const inputBudgetTokens = Math.max(
    2_048,
    getContextWindowSize(model) - maxTokens - SUMMARY_INPUT_SAFETY_MARGIN_TOKENS,
  )
  const conversationText = truncateSerializedConversation(serializeConversation(messages), inputBudgetTokens)
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`
  if (options.previousSummary) {
    prompt += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`
  }
  prompt += options.turnPrefix
    ? TURN_PREFIX_SUMMARIZATION_PROMPT
    : options.previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT

  const response = await provider.createMessage({
    model,
    maxTokens,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    abortSignal: options.abortSignal,
  })
  const responseUsage = normalizeProviderUsage(response.usage)
  if (response.stopReason === 'aborted') {
    throw Object.assign(new Error('Compaction summary was aborted'), {
      compactionReason: 'aborted',
      usage: responseUsage,
    })
  }
  if (response.stopReason === 'error') {
    throw Object.assign(new Error('Compaction summary failed'), {
      compactionReason: 'provider_error',
      usage: responseUsage,
    })
  }
  if (response.stopReason === 'max_tokens') {
    throw Object.assign(new Error('Compaction summary reached max_tokens'), {
      compactionReason: 'max_tokens',
      usage: responseUsage,
    })
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim()
  const failure = validateSummary(
    text,
    options.turnPrefix ? REQUIRED_TURN_PREFIX_HEADINGS : REQUIRED_SUMMARY_HEADINGS,
  )
  if (failure) {
    throw Object.assign(new Error(`Invalid compaction summary: ${failure}`), {
      compactionReason: failure,
      usage: responseUsage,
    })
  }
  return { text, usage: responseUsage }
}

function combineUsage(first: NormalizedProviderUsage, second: NormalizedProviderUsage): NormalizedProviderUsage {
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadInputTokens: first.cacheReadInputTokens + second.cacheReadInputTokens,
    cacheCreationInputTokens: first.cacheCreationInputTokens + second.cacheCreationInputTokens,
    totalTokens: first.totalTokens + second.totalTokens,
  }
}

function failureResult(
  messages: NormalizedMessageParam[],
  state: AutoCompactState,
  failureReason: CompactionFailureReason,
  usage?: NormalizedProviderUsage,
  trigger?: AgentContextCompactionTrigger,
): CompactConversationResult {
  return {
    compacted: false,
    compactedMessages: messages,
    summary: '',
    failureReason,
    usage,
    state: {
      ...state,
      // Recovery-path compaction (prompt_too_long) keeps its own breaker on the
      // engine (promptTooLongRecoveryFailures): letting its failures burn the
      // proactive counter disabled overflow self-rescue after 3 unrelated
      // proactive failures (#567 item 2). manual 触发失败烧共享熔断是有意的
      // （#709 第 7 项语义确认）：manual 与 auto 走同一摘要链路，连续失败即链路
      // 坏，auto 继续尝试只会重复烧钱；manual 成功会清零重新武装 auto。
      consecutiveFailures:
        trigger === 'prompt_too_long' ? state.consecutiveFailures : state.consecutiveFailures + 1,
    },
  }
}

export async function compactConversation(
  provider: LLMProvider,
  model: string,
  messages: NormalizedMessageParam[],
  state: AutoCompactState,
  options: CompactConversationOptions = {},
): Promise<CompactConversationResult> {
  const preparation = prepareCompaction(messages, options)
  if (!preparation) return failureResult(messages, state, 'not_smaller', undefined, options.trigger)

  const reserveTokens = Math.min(
    Math.max(1, options.reserveTokens ?? DEFAULT_RESERVE_TOKENS),
    MAX_RESERVE_TOKENS,
  )
  const historyMaxTokens = Math.max(1, Math.min(
    options.maxSummaryTokens ?? Math.floor(reserveTokens * 0.8),
    MAX_RESERVE_TOKENS,
  ))
  const prefixMaxTokens = Math.max(1, Math.floor(reserveTokens * 0.5))

  try {
    let summary: string
    let usage: NormalizedProviderUsage
    if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
      let historyText = preparation.previousSummary ?? 'No prior history.'
      let historyUsage: NormalizedProviderUsage | undefined
      if (preparation.messagesToSummarize.length > 0) {
        const history = await generateSummary(
          provider,
          model,
          preparation.messagesToSummarize,
          historyMaxTokens,
          {
            previousSummary: preparation.previousSummary,
            abortSignal: options.abortSignal,
          },
        )
        historyText = history.text
        historyUsage = history.usage
      }
      const turnPrefix = await generateSummary(
        provider,
        model,
        preparation.turnPrefixMessages,
        prefixMaxTokens,
        { turnPrefix: true, abortSignal: options.abortSignal },
      )
      summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`
      usage = historyUsage ? combineUsage(historyUsage, turnPrefix.usage) : turnPrefix.usage
    } else {
      if (preparation.messagesToSummarize.length === 0) {
        return failureResult(messages, state, 'not_smaller', undefined, options.trigger)
      }
      const result = await generateSummary(
        provider,
        model,
        preparation.messagesToSummarize,
        historyMaxTokens,
        {
          previousSummary: preparation.previousSummary,
          abortSignal: options.abortSignal,
        },
      )
      summary = result.text
      usage = result.usage
    }

    const summarizedMessages = [
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]
    summary += formatFileOperations(collectFileOperations(summarizedMessages))
    const actionFacts = renderComputerUseActionFacts(summarizedMessages)
    const internalContext = [summary, actionFacts].filter(Boolean).join('\n\n')
    const summaryMessage = {
      role: 'user' as const,
      content: [{
        type: 'text' as const,
        text: internalContext,
        _meta: { contextBlock: 'compaction' },
      }],
    } as unknown as NormalizedMessageParam
    const compactedMessages = [
      summaryMessage,
      ...(preparation.protectedUserMessage ? [preparation.protectedUserMessage] : []),
      ...preparation.retainedTail,
    ]
    const retainedTokens = estimateMessagesTokens([
      ...(preparation.protectedUserMessage ? [preparation.protectedUserMessage] : []),
      ...preparation.retainedTail,
    ])
    if (
      options.trigger !== 'manual'
      && estimateMessagesTokens(compactedMessages) >= preparation.tokensBefore
    ) {
      return failureResult(messages, state, 'not_smaller', usage, options.trigger)
    }

    return {
      compacted: true,
      compactedMessages,
      summary,
      usage,
      retainedTokens,
      retainedMessageCount: preparation.retainedTail.length + (preparation.protectedUserMessage ? 1 : 0),
      state: {
        compacted: true,
        turnCounter: state.turnCounter,
        consecutiveFailures: 0,
      },
    }
  } catch (error: any) {
    const failureReason = options.abortSignal?.aborted
      ? 'aborted'
      : isCompactionFailureReason(error?.compactionReason)
        ? error.compactionReason
        : 'provider_error'
    return failureResult(messages, state, failureReason, error?.usage, options.trigger)
  }
}

function isCompactionFailureReason(value: unknown): value is CompactionFailureReason {
  return typeof value === 'string' && [
    'provider_error',
    'aborted',
    'max_tokens',
    'empty_summary',
    'invalid_structure',
    'repetitive_summary',
    'not_smaller',
  ].includes(value)
}

export function microCompactMessages(
  messages: any[],
  maxToolResultChars: number = 50000,
): any[] {
  return messages.map((msg: any) => {
    if (typeof msg.content === 'string') return msg
    if (!Array.isArray(msg.content)) return msg

    const content = (msg.content as any[]).map((block: any) => {
      if (block?.type !== 'tool_result') return block
      if (typeof block.content === 'string') {
        if (block.content.length > maxToolResultChars) {
          return {
            ...block,
            content:
              block.content.slice(0, maxToolResultChars / 2)
              + '\n...(truncated)...\n'
              + block.content.slice(-maxToolResultChars / 2),
          }
        }
        return block
      }
      // Array-form tool results (images, web-fetch payloads, ...) previously
      // passed through unbounded and blew up the provider request (#364).
      if (Array.isArray(block.content)) {
        return { ...block, content: compactToolResultContent(block.content, maxToolResultChars) }
      }
      return block
    })

    return { ...msg, content }
  })
}

export function compactToolResultContent(blocks: any[], maxToolResultChars: number): any[] {
  let changed = false
  const next = blocks.map((item: any) => {
    if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > maxToolResultChars) {
      changed = true
      return {
        ...item,
        text:
          item.text.slice(0, maxToolResultChars / 2)
          + '\n...(truncated)...\n'
          + item.text.slice(-maxToolResultChars / 2),
      }
    }
    // Only shed media blocks that actually exceed the budget — small images
    // must reach the model or visual ability regresses (#364).
    if (item?.type === 'image' || item?.type === 'document') {
      const originalChars = safeJsonLength(item)
      if (originalChars > maxToolResultChars) {
        changed = true
        return {
          type: 'text',
          text: `[${item.type} omitted by micro-compaction: original ${item.type} was ${originalChars} chars]`,
        }
      }
      return item
    }
    return item
  })
  return changed ? next : blocks
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}
