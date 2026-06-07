/**
 * OpenAI Responses API 适配器
 *
 * 实现 OpenAI Responses API (/v1/responses) 的消息转换、请求构建和 SSE 解析。
 * 与 OpenAIAdapter 并行存在，通过 Channel.openaiApiMode 字段选择使用哪个。
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  StreamRequestInput,
  StreamEvent,
  TitleRequestInput,
  ImageAttachmentData,
  ToolDefinition,
  ContinuationMessage,
} from './types'
import { normalizeBaseUrl } from './url-utils'

// ===== Responses API 类型 =====

interface ResponsesInputItem {
  type?: 'message' | 'function_call' | 'function_call_output'
  role?: 'user' | 'developer'
  content?: ResponsesInputContent[]
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  id?: string
}

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

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
    arguments?: string
    status?: string
  }
}

// ===== 消息转换 =====

function buildInputContent(
  text: string,
  imageData: ImageAttachmentData[],
): ResponsesInputContent[] {
  const parts: ResponsesInputContent[] = []
  for (const img of imageData) {
    parts.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` })
  }
  if (text) {
    parts.push({ type: 'input_text', text })
  }
  return parts
}

function toResponsesInput(input: StreamRequestInput): ResponsesInputItem[] {
  const { history, userMessage, attachments, readImageAttachments } = input
  const items: ResponsesInputItem[] = []

  for (const msg of history) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      if (msg.attachments && msg.attachments.length > 0) {
        const images = readImageAttachments(msg.attachments)
        items.push({
          type: 'message',
          role: 'user',
          content: buildInputContent(msg.content, images),
        })
      } else {
        items.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: msg.content }],
        })
      }
    }
    // Assistant history messages are skipped in Responses API input
    // (the API uses previous_response_id for conversation state)
  }

  // Current user message
  const currentImages = readImageAttachments(attachments)
  items.push({
    type: 'message',
    role: 'user',
    content: buildInputContent(userMessage, currentImages),
  })

  return items
}

function appendResponsesContinuation(
  items: ResponsesInputItem[],
  continuationMessages: ContinuationMessage[],
): void {
  for (const msg of continuationMessages) {
    if (msg.role === 'assistant') {
      for (const tc of msg.toolCalls) {
        items.push({
          type: 'function_call',
          id: tc.id,
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        })
      }
    } else if (msg.role === 'tool') {
      for (const result of msg.results) {
        items.push({
          type: 'function_call_output',
          call_id: result.toolCallId,
          output: result.content,
        })
      }
    }
  }
}

function toResponsesTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

// ===== 适配器实现 =====

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly providerType: ProviderAdapter['providerType'] = 'openai'

  buildStreamRequest(input: StreamRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)
    const inputItems = toResponsesInput(input)
    const bodyObj: Record<string, unknown> = {
      model: input.modelId,
      input: inputItems,
      stream: true,
    }

    if (input.systemMessage) {
      bodyObj.instructions = input.systemMessage
    }

    if (input.tools && input.tools.length > 0) {
      bodyObj.tools = toResponsesTools(input.tools)
    }

    if (input.continuationMessages && input.continuationMessages.length > 0) {
      appendResponsesContinuation(inputItems, input.continuationMessages)
    }

    return {
      url: `${url}/responses`,
      headers: {
        'Authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(bodyObj),
    }
  }

  parseSSELine(jsonLine: string): StreamEvent[] {
    try {
      const event = JSON.parse(jsonLine) as ResponsesStreamEvent
      const events: StreamEvent[] = []

      switch (event.type) {
        case 'response.output_text.delta': {
          if (event.delta) {
            events.push({ type: 'chunk', delta: event.delta })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          if (event.delta) {
            events.push({
              type: 'tool_call_delta',
              toolCallId: `fc_${event.output_index ?? 0}`,
              argumentsDelta: event.delta,
            })
          }
          break
        }
        case 'response.output_item.added': {
          const item = event.item
          if (item && item.type === 'function_call') {
            events.push({
              type: 'tool_call_start',
              toolCallId: item.call_id || item.id || `fc_${event.output_index ?? 0}`,
              toolName: item.name || '',
            })
          }
          break
        }
        case 'response.completed': {
          const resp = (event as any).response
          const hasToolCalls = resp?.output?.some?.((o: any) => o.type === 'function_call') ?? false
          events.push({
            type: 'done',
            stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
          })
          break
        }
      }

      return events
    } catch {
      return []
    }
  }

  buildTitleRequest(input: TitleRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)

    return {
      url: `${url}/responses`,
      headers: {
        'Authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.modelId,
        input: [{ role: 'user', type: 'message', content: [{ type: 'input_text', text: input.prompt }] }],
        max_output_tokens: 50,
      }),
    }
  }

  parseTitleResponse(responseBody: unknown): string | null {
    const data = responseBody as {
      output?: Array<{
        type: string
        content?: Array<{ type: string; text?: string }>
      }>
    }

    if (!data.output) return null

    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            return c.text
          }
        }
      }
    }

    return null
  }
}
