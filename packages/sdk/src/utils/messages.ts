/**
 * Message Utilities
 *
 * Message normalization for API, synthetic placeholders,
 * and content processing.
 */

import { readFile } from 'node:fs/promises'

/**
 * Normalize messages for the LLM API.
 * Ensures proper message format, strips internal metadata,
 * and fixes tool result pairing.
 */
export function normalizeMessagesForAPI(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  const normalized: Array<{ role: string; content: any }> = []

  for (const msg of messages) {
    if (!msg) continue

    // Ensure alternating user/assistant messages
    if (normalized.length > 0) {
      const last = normalized[normalized.length - 1]
      if (last && last.role === msg.role) {
        // Merge same-role messages
        if (msg.role === 'user') {
          // Combine content
          const lastContent = typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }]
            : last.content as any[]
          const newContent = typeof msg.content === 'string'
            ? [{ type: 'text' as const, text: msg.content }]
            : msg.content as any[]
          normalized[normalized.length - 1] = {
            role: 'user',
            content: sanitizeContentForAPI([...lastContent, ...newContent]),
          }
          continue
        }
      }
    }

    normalized.push({ ...msg, content: sanitizeContentForAPI(msg.content) })
  }

  // Ensure tool results are properly paired with tool_use
  return fixToolResultPairing(normalized)
}

export async function hydrateEphemeralImageReferences(
  messages: Array<{ role: string; content: any }>,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<Array<{ role: string; content: any }>> {
  return Promise.all(messages.map(async (message) => ({
    ...message,
    content: await hydrateEphemeralValue(message.content, read),
  })))
}

export function releaseEphemeralImageReferences(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  return messages.map((message) => ({
    ...message,
    content: releaseEphemeralValue(message.content),
  }))
}

export function collectInternalContextBlocks(
  messages: Array<{ role: string; content: any }>,
): string[] {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.flatMap((block: any) => isInternalContextBlock(block) ? [block.text] : [])
    : [])
}

export function renderComputerUseActionFacts(messages: Array<{ role: string; content: any }>): string {
  const facts = new Map<string, string>()
  const recordFact = (fact: any): void => {
    if (!fact || typeof fact.actionId !== 'string' || typeof fact.phase !== 'string') return
    const app = typeof fact.window?.app === 'string' ? fact.window.app : 'unknown app'
    const windowId = typeof fact.window?.id === 'number' ? `#${fact.window.id}` : ''
    const action = typeof fact.action === 'string' ? fact.action : 'action'
    const suffix = fact.phase === 'verified' ? 'verified complete' : 'not verified complete'
    facts.set(fact.actionId, `${fact.actionId}: ${action} on ${app}${windowId}; phase=${fact.phase}; ${suffix}`)
  }
  const visit = (value: any): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    recordFact(value._meta?.computerUseAction)
    if (Array.isArray(value._meta?.computerUseActions)) {
      value._meta.computerUseActions.forEach(recordFact)
    }
    Object.values(value).forEach(visit)
  }
  messages.forEach(visit)
  return facts.size > 0
    ? `[Authoritative Computer Use action facts]\n${Array.from(facts.values()).join('\n')}`
    : ''
}

export function stripInternalContextBlocks(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  return messages.flatMap((message) => {
    if (!Array.isArray(message.content)) return [message]
    const content = message.content.filter((block: any) => !isInternalContextBlock(block))
    return content.length > 0 ? [{ ...message, content }] : []
  })
}

function isInternalContextBlock(value: any): value is { type: 'text'; text: string } {
  return value?.type === 'text'
    && typeof value.text === 'string'
    && value._meta?.contextBlock === 'compaction'
}

async function hydrateEphemeralValue(
  value: any,
  read: (path: string) => Promise<Uint8Array>,
): Promise<any> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrateEphemeralValue(item, read)))
  if (!value || typeof value !== 'object') return value
  const source = value.source && typeof value.source === 'object' ? value.source : undefined
  if (
    value.type === 'image'
    && value._meta?.ephemeral === 'trusted_runtime'
    && source?.type === 'file'
    && typeof source.path === 'string'
    && typeof source.media_type === 'string'
  ) {
    const bytes = await read(source.path)
    return {
      ...value,
      source: {
        type: 'base64',
        media_type: source.media_type,
        data: Buffer.from(bytes).toString('base64'),
      },
    }
  }
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [key, await hydrateEphemeralValue(item, read)] as const),
  )
  return Object.fromEntries(entries)
}

function releaseEphemeralValue(value: any): any {
  if (Array.isArray(value)) return value.map(releaseEphemeralValue)
  if (!value || typeof value !== 'object') return value
  if (
    value.type === 'text'
    && value._meta?.contextBlock === 'computer_use_visual'
    && value._meta?.persist === false
  ) {
    const screenshotId = typeof value._meta?.screenshotId === 'string'
      ? value._meta.screenshotId
      : 'unknown'
    return { type: 'text', text: `[Visual observation reference: ${screenshotId}]` }
  }
  const source = value.source && typeof value.source === 'object' ? value.source : undefined
  if (
    value.type === 'image'
    && value._meta?.ephemeral === 'trusted_runtime'
    && source?.type === 'file'
    && typeof source.path === 'string'
  ) {
    return { type: 'text', text: `[Screenshot reference: ${source.path}]` }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, releaseEphemeralValue(item)]),
  )
}

function sanitizeContentForAPI(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map(sanitizeContentBlockForAPI)
}

function sanitizeContentBlockForAPI(block: any): any {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block

  const { _meta: _meta, ...sanitized } = block
  if (Array.isArray(sanitized.content)) {
    return {
      ...sanitized,
      content: sanitized.content.map(sanitizeContentBlockForAPI),
    }
  }
  return sanitized
}

/**
 * Fix tool result pairing: ensure every tool_result has a
 * matching tool_use in the previous assistant message.
 */
function fixToolResultPairing(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  const result: Array<{ role: string; content: any }> = []

  for (const msg of messages) {
    if (!msg) continue

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Check for tool_result blocks
      const toolResults = (msg.content as any[]).filter(
        (block: any) => block.type === 'tool_result',
      )

      if (toolResults.length > 0 && result.length > 0) {
        // Find the previous assistant message
        const prevAssistant = result[result.length - 1]
        if (prevAssistant && prevAssistant.role === 'assistant' && Array.isArray(prevAssistant.content)) {
          const toolUseIds = new Set(
            (prevAssistant.content as any[])
              .filter((b: any) => b.type === 'tool_use')
              .map((b: any) => b.id),
          )

          // Filter out orphaned tool results
          const validContent = (msg.content as any[]).filter((block: any) => {
            if (block.type === 'tool_result') {
              return toolUseIds.has(block.tool_use_id)
            }
            return true
          })

          if (validContent.length > 0) {
            result.push({ ...msg, content: validContent })
          }
          continue
        }
      }
    }

    result.push(msg)
  }

  return result
}

/**
 * Strip multimodal blocks from messages (for compaction).
 */
export function stripImagesFromMessages(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  return messages.map((msg) => {
    const filtered = stripImagesFromValue(msg.content)
    return {
      ...msg,
      content: Array.isArray(filtered) && filtered.length === 0 ? '[content removed]' : filtered,
    }
  })
}

function stripImagesFromValue(value: any): any {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item?.type !== 'image' && item?.type !== 'document')
      .map(stripImagesFromValue)
  }
  if (!value || typeof value !== 'object') return value
  if (value.type === 'image') return '[image removed]'
  if (value.type === 'document') return '[document removed]'
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, stripImagesFromValue(item)]),
  )
}
