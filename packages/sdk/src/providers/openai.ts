/**
 * OpenAI Chat Completions API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Chat Completions API format.
 *
 * Uses native fetch (no openai SDK dependency required).
 */

import type {
  LLMProvider,
  ApiType,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './types.js'
import { DEFAULT_RETRY_CONFIG, type RetryConfig, withRetry } from '../utils/retry.js'

// --------------------------------------------------------------------------
// OpenAI-specific types (minimal, just what we need)
// --------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null | OpenAIContentPart[]
  reasoning_content?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

interface OpenAIChatResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: {
      cached_tokens?: number
    }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

type OpenAIUsage = NonNullable<OpenAIChatResponse['usage']>
type OpenAIStreamUsage = NonNullable<OpenAIStreamChunk['usage']>

interface OpenAIStreamChunk {
  choices?: Array<{
    index: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: {
      cached_tokens?: number
    }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  } | null
}

function normalizeContentBlocks(content: unknown): NormalizedContentBlock[] {
  if (Array.isArray(content)) {
    return content as NormalizedContentBlock[]
  }
  if (content && typeof content === 'object') {
    return [content as NormalizedContentBlock]
  }
  return []
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly apiType: ApiType = 'openai-completions'
  private apiKey: string
  private baseURL: string
  private retryConfig: RetryConfig

  constructor(opts: { apiKey?: string; baseURL?: string; retryConfig?: RetryConfig }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.retryConfig = opts.retryConfig ?? DEFAULT_RETRY_CONFIG
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    // Convert to OpenAI format
    const messages = this.convertMessages(params.system, params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      body.enable_thinking = true
    } else if (params.thinking?.type === 'disabled') {
      body.enable_thinking = false
    }

    if (params.effort) {
      body.reasoning_effort = params.effort
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    const outputFormat = params.outputFormat ||
      (params.jsonSchema
        ? { type: 'json_schema' as const, schema: params.jsonSchema }
        : undefined)
    if (outputFormat?.type === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          schema: outputFormat.schema,
        },
      }
    }

    this.prepareChatCompletionBody(body)

    const response = await this.fetchChatCompletion(body, params.abortSignal)

    const data = (await response.json()) as OpenAIChatResponse

    // Convert response back to normalized format
    return this.convertResponse(data, params.thinking?.type === 'disabled')
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const messages = this.convertMessages(params.system, params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      body.enable_thinking = true
    } else if (params.thinking?.type === 'disabled') {
      body.enable_thinking = false
    }

    if (params.effort) {
      body.reasoning_effort = params.effort
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    const outputFormat = params.outputFormat ||
      (params.jsonSchema
        ? { type: 'json_schema' as const, schema: params.jsonSchema }
        : undefined)
    if (outputFormat?.type === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          schema: outputFormat.schema,
        },
      }
    }

    this.prepareChatCompletionBody(body)

    const response = await this.fetchChatCompletion(body, params.abortSignal)

    if (!response.body) {
      throw new Error('OpenAI API returned no response body for streaming request')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason: string | null = null
    let streamedUsage: OpenAIStreamChunk['usage'] | undefined
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls = new Map<number, OpenAIToolCall>()

    const handleChunk = async (
      chunk: OpenAIStreamChunk,
    ): Promise<Array<CreateMessageStreamEvent>> => {
      const events: Array<CreateMessageStreamEvent> = []
      if (chunk.usage) {
        streamedUsage = mergeOpenAIUsage(streamedUsage, chunk.usage)
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta
        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          textParts.push(delta.content)
          events.push({
            type: 'text_delta',
            text: delta.content,
          })
        }
        const reasoningDelta = typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
          ? delta.reasoning_content
          : typeof delta?.reasoning === 'string' && delta.reasoning.length > 0
            ? delta.reasoning
            : null
        // Skip reasoning when thinking is disabled; reasoning models still emit reasoning_content
        if (reasoningDelta && params.thinking?.type !== 'disabled') {
          reasoningParts.push(reasoningDelta)
          events.push({
            type: 'thinking_delta',
            thinking: reasoningDelta,
          })
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const index = typeof toolCall.index === 'number' ? toolCall.index : 0
          const current = toolCalls.get(index) ?? {
            id: toolCall.id || `tool_call_${index}`,
            type: 'function',
            function: {
              name: '',
              arguments: '',
            },
          }
          if (toolCall.id) {
            current.id = toolCall.id
          }
          if (toolCall.function?.name) {
            current.function.name = toolCall.function.name
          }
          if (toolCall.function?.arguments) {
            current.function.arguments += toolCall.function.arguments
          }
          toolCalls.set(index, current)
        }
      }

      return events
    }

    const processBuffer = async (
      flush = false,
    ): Promise<Array<CreateMessageStreamEvent>> => {
      const events: Array<CreateMessageStreamEvent> = []
      while (true) {
        const separatorIndex = buffer.indexOf('\n\n')
        if (separatorIndex === -1) {
          break
        }

        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') {
            continue
          }
          const parsed = JSON.parse(data) as OpenAIStreamChunk
          events.push(...await handleChunk(parsed))
        }
      }

      if (flush && buffer.trim().length > 0) {
        const remaining = buffer
        buffer = ''
        for (const line of remaining.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          const parsed = JSON.parse(data) as OpenAIStreamChunk
          events.push(...await handleChunk(parsed))
        }
      }

      return events
    }

    const stream = response.body
    if (!stream) {
      throw new Error('OpenAI streaming response body is empty')
    }

    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      const events = await processBuffer(false)
      for (const event of events) {
        yield event
      }
    }

    buffer += decoder.decode()
    const tailEvents = await processBuffer(true)
    for (const event of tailEvents) {
      yield event
    }

    const content: NormalizedResponseBlock[] = []
    const reasoning = reasoningParts.join('')
    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning })
    }
    const text = textParts.join('')
    if (text) {
      content.push({ type: 'text', text })
    }

    for (const toolCall of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
      let input: any
      try {
        input = JSON.parse(toolCall.function.arguments)
      } catch {
        input = toolCall.function.arguments
      }
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      })
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    return {
      content,
      stopReason: this.mapFinishReason(finishReason || 'stop'),
      usage: normalizeOpenAIUsage(streamedUsage),
    }
  }

  private async fetchChatCompletion(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        const err: any = new Error(
          `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
        )
        err.status = response.status
        throw err
      }

      return response
    }, this.retryConfig, signal)
  }

  // --------------------------------------------------------------------------
  // Message Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertMessages(
    system: string,
    messages: NormalizedMessageParam[],
  ): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    // System prompt as first message
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, result)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, result)
      }
    }

    return result
  }

  protected prepareChatCompletionBody(_body: Record<string, any>): void {}

  private convertUserMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      return
    }

    // Content blocks may contain text, image, and/or tool_result blocks
    const textParts: string[] = []
    const contentParts: OpenAIContentPart[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        textParts.push(block.text)
        contentParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const url = imageSourceToOpenAIUrl(block.source)
        if (url) {
          contentParts.push({ type: 'image_url', image_url: { url } })
        }
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          toolResults.push({
            tool_use_id: block.tool_use_id,
            content: block.content,
          })
        } else {
          const text = block.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
          if (text) {
            toolResults.push({
              tool_use_id: block.tool_use_id,
              content: text,
            })
          }
          for (const item of block.content) {
            if (item.type !== 'image') continue
            const url = toolResultImageToOpenAIUrl(item)
            if (url) {
              contentParts.push({ type: 'image_url', image_url: { url } })
            }
          }
        }
      }
    }

    // Tool results become separate tool messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      })
    }

    // Text/image parts become a user message
    if (contentParts.some((part) => part.type === 'image_url')) {
      result.push({ role: 'user', content: contentParts })
    } else if (textParts.length > 0) {
      result.push({ role: 'user', content: textParts.join('\n') })
    }
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'assistant', content: msg.content })
      return
    }

    // Extract text and tool_use blocks
    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []
    let reasoningContent: string | undefined

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'thinking') {
        reasoningContent = block.thinking
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input),
          },
        })
      }
    }

    const assistantMsg: OpenAIChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : toolCalls.length > 0 ? null : '',
    }

    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls
    }

    if (reasoningContent) {
      assistantMsg.reasoning_content = reasoningContent
    }

    result.push(assistantMsg)
  }

  // --------------------------------------------------------------------------
  // Tool Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertTools(tools: NormalizedTool[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  // --------------------------------------------------------------------------
  // Response Conversion: OpenAI → Internal
  // --------------------------------------------------------------------------

  private convertResponse(data: OpenAIChatResponse, thinkingDisabled = false): CreateMessageResponse {
    const choice = data.choices[0]
    if (!choice) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    const content: NormalizedResponseBlock[] = []
    const reasoning = typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content.length > 0
      ? choice.message.reasoning_content
      : typeof choice.message.reasoning === 'string' && choice.message.reasoning.length > 0
        ? choice.message.reasoning
        : null
    if (reasoning && !thinkingDisabled) {
      content.push({ type: 'thinking', thinking: reasoning })
    }

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: any
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = tc.function.arguments
        }

        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    // Map finish_reason to our normalized stop reasons
    const stopReason = this.mapFinishReason(choice.finish_reason)

    return {
      content,
      stopReason,
      usage: normalizeOpenAIUsage(data.usage),
    }
  }

  private mapFinishReason(
    reason: string,
  ): 'end_turn' | 'max_tokens' | 'tool_use' | string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      default:
        return reason
    }
  }
}

function normalizeOpenAIUsage(usage: OpenAIUsage | OpenAIStreamChunk['usage'] | undefined): CreateMessageResponse['usage'] {
  const promptTokens = tokenValue(usage?.input_tokens ?? usage?.prompt_tokens)
  const outputTokens = tokenValue(usage?.output_tokens ?? usage?.completion_tokens)
  const cacheReadInputTokens = tokenValue(
    usage?.input_tokens_details?.cached_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.prompt_cache_hit_tokens,
  )
  const promptCacheMissTokens = numberOrUndefined(usage?.prompt_cache_miss_tokens)
  return {
    input_tokens: promptCacheMissTokens ?? Math.max(0, promptTokens - cacheReadInputTokens),
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: 0,
  }
}

function mergeOpenAIUsage(
  current: OpenAIStreamChunk['usage'] | undefined,
  next: OpenAIStreamUsage,
): OpenAIStreamChunk['usage'] {
  if (!current) {
    return next
  }
  const merged: OpenAIStreamUsage = { ...current }

  setNumberField(merged, next, 'prompt_tokens')
  setNumberField(merged, next, 'completion_tokens')
  setNumberField(merged, next, 'total_tokens')
  setNumberField(merged, next, 'input_tokens')
  setNumberField(merged, next, 'output_tokens')
  setNumberField(merged, next, 'prompt_cache_miss_tokens')
  setPositiveNumberField(merged, next, 'prompt_cache_hit_tokens')

  if (next.prompt_tokens_details) {
    const currentCachedTokens = current.prompt_tokens_details?.cached_tokens
    merged.prompt_tokens_details = {
      ...current.prompt_tokens_details,
      ...next.prompt_tokens_details,
    }
    if (
      tokenValue(next.prompt_tokens_details.cached_tokens) === 0
      && tokenValue(currentCachedTokens) > 0
    ) {
      merged.prompt_tokens_details.cached_tokens = currentCachedTokens
    }
  }
  if (next.input_tokens_details) {
    const currentCachedTokens = current.input_tokens_details?.cached_tokens
    merged.input_tokens_details = {
      ...current.input_tokens_details,
      ...next.input_tokens_details,
    }
    if (
      tokenValue(next.input_tokens_details.cached_tokens) === 0
      && tokenValue(currentCachedTokens) > 0
    ) {
      merged.input_tokens_details.cached_tokens = currentCachedTokens
    }
  }

  return merged
}

type OpenAIUsageNumberField =
  | 'prompt_tokens'
  | 'completion_tokens'
  | 'total_tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'prompt_cache_hit_tokens'
  | 'prompt_cache_miss_tokens'

function setNumberField(
  target: OpenAIStreamUsage,
  source: OpenAIStreamUsage,
  field: OpenAIUsageNumberField,
): void {
  const value = source[field]
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[field] = value
  }
}

function setPositiveNumberField(
  target: OpenAIStreamUsage,
  source: OpenAIStreamUsage,
  field: OpenAIUsageNumberField,
): void {
  const value = source[field]
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    target[field] = value
  }
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
}

function imageSourceToOpenAIUrl(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const item = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown }
  if (typeof item.url === 'string' && item.url.trim()) {
    return item.url
  }
  if (item.type === 'base64' && typeof item.media_type === 'string' && typeof item.data === 'string') {
    return `data:${item.media_type};base64,${item.data}`
  }
  return null
}

function toolResultImageToOpenAIUrl(item: { source?: unknown; data?: unknown; mimeType?: unknown }): string | null {
  const fromSource = imageSourceToOpenAIUrl(item.source)
  if (fromSource) return fromSource
  if (typeof item.data === 'string' && typeof item.mimeType === 'string') {
    return `data:${item.mimeType};base64,${item.data}`
  }
  return null
}
