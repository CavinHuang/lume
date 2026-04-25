import type { SDKMessage } from '@lume/shared'

type AssistantSDKMessage = Extract<SDKMessage, { type: 'assistant' }>

function getUserText(message: SDKMessage): string {
  if (message.type !== 'user') return ''
  const content = message.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => block as unknown)
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join('\n\n')
}

function isVisibleUserMessage(message: SDKMessage): boolean {
  return getUserText(message).length > 0
}

function isVisibleSystemMessage(message: SDKMessage): boolean {
  return message.type === 'system' && (message as SDKMessage & { subtype?: string }).subtype === 'compact_boundary'
}

function appendAssistantEventToResponse(
  response: AssistantSDKMessage,
  event: AssistantSDKMessage,
): AssistantSDKMessage {
  const responseContent = Array.isArray(response.message?.content) ? response.message.content : []
  const eventContent = Array.isArray(event.message?.content) ? event.message.content : []

  return {
    ...response,
    message: {
      ...response.message,
      content: [...responseContent, ...eventContent],
    },
  }
}

/**
 * Projects raw SDK protocol events into the message units users expect to read.
 *
 * The SDK emits one assistant message per model turn, including intermediate
 * tool-only turns. The chat surface should show one assistant response between
 * visible user messages while still keeping raw SDK messages elsewhere for tool
 * result lookup and persistence.
 */
export function projectRenderableAgentMessages(messages: SDKMessage[]): SDKMessage[] {
  const projected: SDKMessage[] = []
  let currentAssistantIndex: number | null = null

  for (const message of messages) {
    if (isVisibleUserMessage(message)) {
      projected.push(message)
      currentAssistantIndex = null
      continue
    }

    if (message.type === 'assistant') {
      if (currentAssistantIndex === null) {
        projected.push(message)
        currentAssistantIndex = projected.length - 1
        continue
      }

      const previous = projected[currentAssistantIndex]
      if (previous?.type === 'assistant') {
        projected[currentAssistantIndex] = appendAssistantEventToResponse(previous, message)
      } else {
        projected.push(message)
        currentAssistantIndex = projected.length - 1
      }
      continue
    }

    if (isVisibleSystemMessage(message)) {
      projected.push(message)
      currentAssistantIndex = null
    }
  }

  return projected
}
