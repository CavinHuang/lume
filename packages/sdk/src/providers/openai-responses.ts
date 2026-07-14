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
  | { role: 'user'; content: ResponsesInputContent[]; type: 'message' }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

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
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress'
  output: ResponsesOutputItem[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  error?: { message: string }
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

interface ResponsesStreamEvent {
  type: string
  delta?: string
  output_index?: number
  content_index?: number
  item?: {
    type: string
    id?: string
    call_id?: string
    name?: string
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
    const { input, tools, instructions, toolNames } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }

    if (params.effort) {
      body.reasoning = { effort: params.effort }
    }

    const response = await this.fetchResponse(body)
    const data = (await response.json()) as ResponsesApiResponse
    return this.convertResponse(data, toolNames)
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const { input, tools, instructions, toolNames } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      stream: true,
      ...(instructions ? { instructions } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }

    if (params.effort) {
      body.reasoning = { effort: params.effort }
    }

    const response = await this.fetchResponse(body)

    if (!response.body) {
      throw new Error('OpenAI Responses API returned no response body for streaming request')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finalResponse: ResponsesApiResponse | undefined
    const textParts: string[] = []
    const functionCalls = new Map<number, { id: string; call_id: string; name: string; arguments: string }>()

    const handleEvent = (event: ResponsesStreamEvent): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []

      switch (event.type) {
        case 'response.output_text.delta': {
          if (event.delta) {
            textParts.push(event.delta)
            events.push({ type: 'text_delta', text: event.delta })
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
        case 'response.output_item.added': {
          const item = event.item
          if (item && item.type === 'function_call') {
            functionCalls.set(event.output_index ?? functionCalls.size, {
              id: item.id ?? '',
              call_id: item.call_id ?? '',
              name: toolNames.wireToOriginal.get(item.name ?? '') ?? item.name ?? '',
              arguments: '',
            })
          }
          break
        }
        case 'response.completed': {
          if (event.response) {
            finalResponse = event.response
          }
          break
        }
      }

      return events
    }

    const processBuffer = (flush = false): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []
      while (true) {
        const separatorIndex = buffer.indexOf('\n\n')
        if (separatorIndex === -1) break

        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data) as ResponsesStreamEvent
            events.push(...handleEvent(parsed))
          } catch {
            // skip malformed JSON
          }
        }
      }

      if (flush && buffer.trim().length > 0) {
        for (const line of buffer.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data) as ResponsesStreamEvent
            events.push(...handleEvent(parsed))
          } catch {
            // skip
          }
        }
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

    // Build final response
    const content: NormalizedResponseBlock[] = []
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
    const stopReason = status === 'incomplete' ? 'max_tokens'
      : functionCalls.size > 0 ? 'tool_use'
      : 'end_turn'

    const usage = finalResponse?.usage
    return {
      content,
      stopReason,
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  }

  // --------------------------------------------------------------------------
  // Request building
  // --------------------------------------------------------------------------

  private buildRequestParts(params: CreateMessageParams): {
    input: ResponsesInputItem[]
    tools: ResponsesFunctionTool[] | undefined
    instructions: string | undefined
    toolNames: ResponsesToolNames
  } {
    const toolNames = buildResponsesToolNames(params.tools)
    const input = this.convertInput(params.messages, toolNames)
    const tools = params.tools ? this.convertTools(params.tools, toolNames) : undefined
    return { input, tools, instructions: params.system || undefined, toolNames }
  }

  private convertInput(messages: NormalizedMessageParam[], toolNames: ResponsesToolNames): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, items)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, items, toolNames)
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
          if (text) {
            toolResults.push({
              tool_use_id: block.tool_use_id,
              content: text,
            })
          }
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
      // Responses API doesn't have assistant role in input.
      // For multi-turn context, we skip pure text assistant messages
      // as the Responses API uses previous_response_id for conversation state.
      // When we have full message history, we include it as context.
      return
    }

    const textParts: string[] = []

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        items.push({
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

  private convertResponse(data: ResponsesApiResponse, toolNames: ResponsesToolNames): CreateMessageResponse {
    const content: NormalizedResponseBlock[] = []

    if (data.error) {
      return {
        content: [{ type: 'text', text: `Error: ${data.error.message}` }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            content.push({ type: 'text', text: c.text })
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
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    const hasToolCalls = data.output?.some((item) => item.type === 'function_call') ?? false
    const stopReason = data.status === 'incomplete' ? 'max_tokens'
      : hasToolCalls ? 'tool_use'
      : 'end_turn'

    return {
      content,
      stopReason,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  }

  // --------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------

  private async fetchResponse(body: Record<string, unknown>): Promise<Response> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
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
    }, this.retryConfig)
  }
}
