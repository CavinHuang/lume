/**
 * OpenAI Responses API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Responses API format (/v1/responses).
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
// Responses API types
// --------------------------------------------------------------------------

type ResponsesInputItem =
  | { role: 'developer' | 'user'; content: ResponsesInputContent[]; type: 'message' }
  | { role: 'assistant'; content: ResponsesAssistantContent[]; type: 'message' }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesAssistantContent =
  | { type: 'output_text'; text: string }
  | { type: 'refusal'; refusal: string }

const TOOL_RESULT_IMAGE_INSTRUCTION =
  'The following image was returned by a tool. Inspect its pixels directly and use it as visual evidence for the current user request.'

interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface ResponsesToolNames {
  originalToWire: Map<string, string>
  wireToOriginal: Map<string, string>
}

interface ResponsesApiResponse {
  id: string
  object: 'response'
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress' | 'cancelled' | 'queued'
  output: ResponsesOutputItem[]
  incomplete_details?: {
    reason?: string
  } | null
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
  }
  error?: {
    code?: string
    message: string
  } | null
}

type ResponsesOutputItem =
  | {
      type: 'message'
      role: 'assistant'
      content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }>
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
      status: string
    }
  | {
      type: 'reasoning'
      id: string
      summary: Array<{ type: 'summary_text'; text: string }>
      encrypted_content?: string | null
    }

interface ResponsesStreamEvent {
  type: string
  delta?: string
  arguments?: string
  output_index?: number
  content_index?: number
  code?: string
  message?: string
  param?: string | null
  item?: {
    type: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    status?: string
  }
  response?: ResponsesApiResponse
}

function normalizeContentBlocks(content: unknown): NormalizedContentBlock[] {
  if (Array.isArray(content)) return content as NormalizedContentBlock[]
  if (content && typeof content === 'object') return [content as NormalizedContentBlock]
  return []
}

function imageSourceToUrl(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown }
  if (typeof s.url === 'string' && s.url.trim()) return s.url
  if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
    return `data:${s.media_type};base64,${s.data}`
  }
  return null
}

function toolResultImageToUrl(item: { source?: unknown; data?: unknown; mimeType?: unknown }): string | null {
  const fromSource = imageSourceToUrl(item.source)
  if (fromSource) return fromSource
  if (typeof item.data === 'string' && typeof item.mimeType === 'string') {
    return `data:${item.mimeType};base64,${item.data}`
  }
  return null
}

function buildResponsesToolNames(tools: NormalizedTool[] | undefined): ResponsesToolNames {
  const originalToWire = new Map<string, string>()
  const wireToOriginal = new Map<string, string>()
  const reservedNames = new Set(
    (tools ?? []).map((tool) => tool.name).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)),
  )

  for (const tool of tools ?? []) {
    let wireName = tool.name
    if (!/^[a-zA-Z0-9_-]+$/.test(wireName)) {
      const baseName = wireName
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'tool'
      wireName = baseName
      let suffix = 2
      while (reservedNames.has(wireName)) {
        wireName = `${baseName}_${suffix}`
        suffix += 1
      }
      reservedNames.add(wireName)
    }
    originalToWire.set(tool.name, wireName)
    wireToOriginal.set(wireName, tool.name)
  }

  return { originalToWire, wireToOriginal }
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIResponsesProvider implements LLMProvider {
  readonly apiType: ApiType = 'openai-responses'
  private apiKey: string
  private baseURL: string
  private retryConfig: RetryConfig

  constructor(opts: { apiKey?: string; baseURL?: string; retryConfig?: RetryConfig }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.retryConfig = opts.retryConfig ?? DEFAULT_RETRY_CONFIG
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const { input, tools, toolNames } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }
    this.applyPromptCachePolicy(body, params)
    this.applyOutputOptions(body, params)

    const response = await this.fetchResponse(body, params.abortSignal)
    const data = (await response.json()) as ResponsesApiResponse
    return this.convertResponse(data, toolNames, params.thinking?.type === 'enabled')
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const { input, tools, toolNames } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      stream: true,
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }
    this.applyPromptCachePolicy(body, params)
    this.applyOutputOptions(body, params)

    const response = await this.fetchResponse(body, params.abortSignal)

    if (!response.body) {
      throw new Error('OpenAI Responses API returned no response body for streaming request')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finalResponse: ResponsesApiResponse | undefined
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const functionCalls = new Map<number, { id: string; call_id: string; name: string; arguments: string }>()
    const includeReasoning = params.thinking?.type === 'enabled'

    const handleEvent = (event: ResponsesStreamEvent): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []

      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta': {
          if (event.delta) {
            textParts.push(event.delta)
            events.push({ type: 'text_delta', text: event.delta })
          }
          break
        }
        case 'response.reasoning_summary_text.delta': {
          if (includeReasoning && event.delta) {
            reasoningParts.push(event.delta)
            events.push({ type: 'thinking_delta', thinking: event.delta })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const outputIndex = event.output_index ?? 0
          if (event.delta) {
            const existing = functionCalls.get(outputIndex)
            if (existing) {
              existing.arguments += event.delta
            }
          }
          break
        }
        case 'response.function_call_arguments.done': {
          const existing = functionCalls.get(event.output_index ?? 0)
          if (existing && typeof event.arguments === 'string') {
            existing.arguments = event.arguments
          }
          break
        }
        case 'response.output_item.added': {
          const item = event.item
          if (item && item.type === 'function_call') {
            functionCalls.set(event.output_index ?? functionCalls.size, {
              id: item.id ?? '',
              call_id: item.call_id ?? '',
              name: toolNames.wireToOriginal.get(item.name ?? '') ?? item.name ?? '',
              arguments: item.arguments ?? '',
            })
          }
          break
        }
        case 'response.output_item.done': {
          const item = event.item
          if (item && item.type === 'function_call') {
            const outputIndex = event.output_index ?? functionCalls.size
            const existing = functionCalls.get(outputIndex)
            functionCalls.set(outputIndex, {
              id: item.id ?? existing?.id ?? '',
              call_id: item.call_id ?? existing?.call_id ?? '',
              name: toolNames.wireToOriginal.get(item.name ?? '')
                ?? item.name
                ?? existing?.name
                ?? '',
              arguments: item.arguments ?? existing?.arguments ?? '',
            })
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          if (event.response) {
            finalResponse = event.response
          }
          break
        }
        case 'response.failed':
        case 'response.cancelled': {
          throw createResponsesApiError(event.response, event.type)
        }
        case 'error': {
          throw new Error(formatResponsesError(event.message, event.code, event.param))
        }
      }

      return events
    }

    const processFrame = (frame: string): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []
      for (const line of frame.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let parsed: ResponsesStreamEvent
        try {
          parsed = JSON.parse(data) as ResponsesStreamEvent
        } catch {
          continue
        }
        events.push(...handleEvent(parsed))
      }
      return events
    }

    const processBuffer = (flush = false): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []
      while (true) {
        const lfIndex = buffer.indexOf('\n\n')
        const crlfIndex = buffer.indexOf('\r\n\r\n')
        const separatorIndex = lfIndex === -1
          ? crlfIndex
          : crlfIndex === -1
            ? lfIndex
            : Math.min(lfIndex, crlfIndex)
        if (separatorIndex === -1) break

        const separatorLength = separatorIndex === crlfIndex ? 4 : 2
        events.push(...processFrame(buffer.slice(0, separatorIndex)))
        buffer = buffer.slice(separatorIndex + separatorLength)
      }

      if (flush && buffer.trim().length > 0) {
        events.push(...processFrame(buffer))
        buffer = ''
      }

      return events
    }

    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      for (const event of processBuffer(false)) {
        yield event
      }
    }

    buffer += decoder.decode()
    for (const event of processBuffer(true)) {
      yield event
    }

    if (finalResponse) {
      assertResponsesTerminalState(finalResponse)
      if (textParts.length === 0) {
        textParts.push(...responseTextParts(finalResponse))
      }
      if (includeReasoning && reasoningParts.length === 0) {
        reasoningParts.push(...responseReasoningParts(finalResponse))
      }
      for (const [outputIndex, item] of finalResponse.output.entries()) {
        if (item.type !== 'function_call' || functionCalls.has(outputIndex)) continue
        functionCalls.set(outputIndex, {
          id: item.id,
          call_id: item.call_id,
          name: toolNames.wireToOriginal.get(item.name) ?? item.name,
          arguments: item.arguments,
        })
      }
    }

    // Build final response
    const content: NormalizedResponseBlock[] = []
    const reasoning = reasoningParts.join('')
    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning })
    }
    const text = textParts.join('')
    if (text) {
      content.push({ type: 'text', text })
    }

    for (const [, fc] of [...functionCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: any
      try {
        input = JSON.parse(fc.arguments)
      } catch {
        input = fc.arguments
      }
      content.push({
        type: 'tool_use',
        id: fc.call_id || fc.id,
        ...(fc.id ? { response_item_id: fc.id } : {}),
        name: fc.name,
        input,
      })
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    const status = finalResponse?.status
    const stopReason = mapResponsesStopReason(
      status,
      finalResponse?.incomplete_details?.reason,
      functionCalls.size > 0,
    )

    const usage = normalizeResponsesUsage(finalResponse?.usage)
    return {
      content,
      stopReason,
      usage,
    }
  }

  // --------------------------------------------------------------------------
  // Request building
  // --------------------------------------------------------------------------

  private buildRequestParts(params: CreateMessageParams): {
    input: ResponsesInputItem[]
    tools: ResponsesFunctionTool[] | undefined
    toolNames: ResponsesToolNames
  } {
    const toolNames = buildResponsesToolNames(params.tools)
    const input = this.convertInput(params, toolNames)
    const tools = params.tools ? this.convertTools(params.tools, toolNames) : undefined
    return { input, tools, toolNames }
  }

  private convertInput(params: CreateMessageParams, toolNames: ResponsesToolNames): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = []

    if (params.system) {
      items.push({
        role: 'developer',
        type: 'message',
        content: [{ type: 'input_text', text: params.system }],
      })
    }

    for (const msg of params.messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, items)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, items, toolNames)
      } else if (msg.role === 'runtime') {
        const content = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        const role = params.promptCache?.runtimeRole === 'user' ? 'user' : 'developer'
        items.push({
          role,
          type: 'message',
          content: [{
            type: 'input_text',
            text: role === 'user'
              ? `<lume_runtime_context>\n${content}\n</lume_runtime_context>`
              : content,
          }],
        })
      }
    }

    return items
  }

  private convertUserMessage(msg: NormalizedMessageParam, items: ResponsesInputItem[]): void {
    if (typeof msg.content === 'string') {
      items.push({
        role: 'user',
        type: 'message',
        content: [{ type: 'input_text', text: msg.content }],
      })
      return
    }

    const contentParts: ResponsesInputContent[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []
    let hasToolResultImageInstruction = false

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        contentParts.push({ type: 'input_text', text: block.text })
      } else if (block.type === 'image') {
        const url = imageSourceToUrl(block.source)
        if (url) {
          contentParts.push({ type: 'input_image', image_url: url })
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
          toolResults.push({
            tool_use_id: block.tool_use_id,
            content: text,
          })
          for (const item of block.content) {
            if (item.type !== 'image') continue
            const url = toolResultImageToUrl(item)
            if (url) {
              if (!hasToolResultImageInstruction) {
                contentParts.push({ type: 'input_text', text: TOOL_RESULT_IMAGE_INSTRUCTION })
                hasToolResultImageInstruction = true
              }
              contentParts.push({ type: 'input_image', image_url: url })
            }
          }
        }
      }
    }

    // Tool results become function_call_output items
    for (const tr of toolResults) {
      items.push({
        type: 'function_call_output',
        call_id: tr.tool_use_id,
        output: tr.content,
      })
    }

    // Text/image parts become a user message
    if (contentParts.length > 0) {
      items.push({
        role: 'user',
        type: 'message',
        content: contentParts,
      })
    }
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    items: ResponsesInputItem[],
    toolNames: ResponsesToolNames,
  ): void {
    if (typeof msg.content === 'string') {
      items.push({
        role: 'assistant',
        type: 'message',
        content: [{ type: 'output_text', text: msg.content }],
      })
      return
    }

    const textParts: string[] = []
    const functionCallItems: ResponsesInputItem[] = []

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        functionCallItems.push({
          type: 'function_call',
          ...(block.response_item_id?.startsWith('fc')
            ? { id: block.response_item_id }
            : {}),
          call_id: block.id,
          name: toolNames.originalToWire.get(block.name) ?? block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        })
      }
      // thinking blocks are not supported in Responses API input
    }
    if (textParts.length > 0) {
      items.push({
        role: 'assistant',
        type: 'message',
        content: [{ type: 'output_text', text: textParts.join('\n') }],
      })
    }
    items.push(...functionCallItems)
  }

  private convertTools(tools: NormalizedTool[], toolNames: ResponsesToolNames): ResponsesFunctionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      name: toolNames.originalToWire.get(t.name) ?? t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    }))
  }

  // --------------------------------------------------------------------------
  // Response conversion
  // --------------------------------------------------------------------------

  private convertResponse(
    data: ResponsesApiResponse,
    toolNames: ResponsesToolNames,
    includeReasoning = false,
  ): CreateMessageResponse {
    assertResponsesTerminalState(data)
    const content: NormalizedResponseBlock[] = []

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            content.push({ type: 'text', text: c.text })
          } else if (c.type === 'refusal' && c.refusal) {
            content.push({ type: 'text', text: c.refusal })
          }
        }
      } else if (item.type === 'function_call') {
        let input: any
        try {
          input = JSON.parse(item.arguments)
        } catch {
          input = item.arguments
        }
        content.push({
          type: 'tool_use',
          id: item.call_id || item.id,
          response_item_id: item.id,
          name: toolNames.wireToOriginal.get(item.name) ?? item.name,
          input,
        })
      } else if (includeReasoning && item.type === 'reasoning') {
        const thinking = item.summary
          .filter((summary) => summary.type === 'summary_text')
          .map((summary) => summary.text)
          .join('\n')
        if (thinking) {
          content.push({ type: 'thinking', thinking })
        }
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    const hasToolCalls = data.output?.some((item) => item.type === 'function_call') ?? false
    const stopReason = mapResponsesStopReason(
      data.status,
      data.incomplete_details?.reason,
      hasToolCalls,
    )

    return {
      content,
      stopReason,
      usage: normalizeResponsesUsage(data.usage),
    }
  }

  // --------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------

  private applyPromptCachePolicy(body: Record<string, unknown>, params: CreateMessageParams): void {
    const routingKey = params.promptCache?.routingKey
    if (!routingKey) return
    if (params.promptCache?.strategy === 'openrouter-sticky') {
      body.session_id = routingKey
    } else {
      body.prompt_cache_key = routingKey
    }
  }

  private applyOutputOptions(body: Record<string, unknown>, params: CreateMessageParams): void {
    if (params.effort || params.thinking?.type === 'enabled') {
      body.reasoning = {
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.thinking?.type === 'enabled' ? { summary: 'auto' } : {}),
      }
    }

    const outputFormat = params.outputFormat
      ?? (params.jsonSchema
        ? { type: 'json_schema' as const, schema: params.jsonSchema }
        : undefined)
    if (outputFormat?.type === 'json_schema') {
      body.text = {
        format: {
          type: 'json_schema',
          name: 'structured_output',
          strict: true,
          schema: outputFormat.schema,
        },
      }
    }
  }

  private async fetchResponse(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseURL}/responses`, {
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
          `OpenAI Responses API error: ${response.status} ${response.statusText}: ${errBody}`,
        )
        err.status = response.status
        throw err
      }

      return response
    }, this.retryConfig, signal)
  }
}

function responseTextParts(response: ResponsesApiResponse): string[] {
  const parts: string[] = []
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue
    for (const content of item.content) {
      if (content.type === 'output_text' && content.text) {
        parts.push(content.text)
      } else if (content.type === 'refusal' && content.refusal) {
        parts.push(content.refusal)
      }
    }
  }
  return parts
}

function responseReasoningParts(response: ResponsesApiResponse): string[] {
  return (response.output ?? [])
    .filter((item): item is Extract<ResponsesOutputItem, { type: 'reasoning' }> => item.type === 'reasoning')
    .flatMap((item) => item.summary)
    .filter((summary) => summary.type === 'summary_text' && summary.text)
    .map((summary) => summary.text)
}

function assertResponsesTerminalState(response: ResponsesApiResponse): void {
  if (response.status === 'failed' || response.error) {
    throw createResponsesApiError(response, 'response.failed')
  }
  if (response.status === 'cancelled') {
    throw createResponsesApiError(response, 'response.cancelled')
  }
  if (response.status === 'queued' || response.status === 'in_progress') {
    throw new Error(`OpenAI Responses API returned non-terminal status: ${response.status}`)
  }
}

function createResponsesApiError(
  response: ResponsesApiResponse | undefined,
  eventType: string,
): Error {
  if (response?.error) {
    return new Error(formatResponsesError(response.error.message, response.error.code))
  }
  return new Error(`OpenAI Responses API ${eventType.replace('response.', '')}`)
}

function formatResponsesError(message?: string, code?: string, param?: string | null): string {
  const details = [
    code ? `[${code}]` : '',
    message || 'Unknown streaming error',
    param ? `(param: ${param})` : '',
  ].filter(Boolean).join(' ')
  return `OpenAI Responses API error: ${details}`
}

function mapResponsesStopReason(
  status: ResponsesApiResponse['status'] | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): CreateMessageResponse['stopReason'] {
  if (status === 'incomplete') {
    return incompleteReason === 'max_output_tokens'
      ? 'max_tokens'
      : incompleteReason || 'incomplete'
  }
  return hasToolCalls ? 'tool_use' : 'end_turn'
}

function normalizeResponsesUsage(
  usage: ResponsesApiResponse['usage'] | undefined,
): CreateMessageResponse['usage'] {
  const inputTokens = tokenValue(usage?.input_tokens)
  const cacheReadInputTokens = tokenValue(usage?.input_tokens_details?.cached_tokens)
  const cacheCreationInputTokens = tokenValue(usage?.input_tokens_details?.cache_write_tokens)
  return {
    input_tokens: Math.max(0, inputTokens - cacheReadInputTokens - cacheCreationInputTokens),
    output_tokens: tokenValue(usage?.output_tokens),
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  }
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}
