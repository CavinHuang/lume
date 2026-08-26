/**
 * Message Utilities
 *
 * Message normalization for API, synthetic placeholders,
 * and content processing.
 */

import { readFile } from 'node:fs/promises'
import { DESKTOP_ACTION_PHASES } from '@lume/shared'

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

const FACT_FIELD_MAX_CHARS = 64
const FACT_APP_MAX_CHARS = 80

/**
 * Normalize a raw computer-use ledger fact into the minimal validated shape
 * allowed on the persistent track and in rendered "Authoritative" context
 * (#709 item 2): phase must be a known enum value, string fields are
 * length-capped, unknown fields are dropped. Returns null when validation fails.
 */
export function normalizeComputerUseActionFact(value: unknown): {
  actionId: string
  action: string
  phase: string
  window?: { id?: number; app: string }
} | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, any>
  if (typeof record.actionId !== 'string' || !record.actionId) return null
  if (typeof record.action !== 'string' || !record.action) return null
  const phase = typeof record.phase === 'string' && (DESKTOP_ACTION_PHASES as readonly string[]).includes(record.phase)
    ? record.phase
    : null
  if (!phase) return null
  const app = typeof record.window?.app === 'string' && record.window.app ? record.window.app : undefined
  const id = typeof record.window?.id === 'number' && Number.isFinite(record.window.id)
    ? record.window.id
    : undefined
  return {
    actionId: record.actionId.slice(0, FACT_FIELD_MAX_CHARS),
    action: record.action.slice(0, FACT_FIELD_MAX_CHARS),
    phase,
    ...(app ? { window: { ...(id !== undefined ? { id } : {}), app: app.slice(0, FACT_APP_MAX_CHARS) } } : {}),
  }
}

/**
 * `_meta` whitelist projection for tool_result blocks entering the persistent
 * sessionMessages track (#567 item 5; shape-tightened in #709 items 1+2): only
 * cross-run consumers survive, and the computer-use fact is shape-validated
 * instead of copied wholesale. The live push path and the history rebuild path
 * both route through here so the minimal-set invariant holds structurally.
 */
export function projectPersistedToolResultMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const source = meta as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  const actionFact = normalizeComputerUseActionFact(source.computerUseAction)
  if (actionFact) projected.computerUseAction = actionFact
  if (typeof source.toolName === 'string' && source.toolName) projected.toolName = source.toolName
  return Object.keys(projected).length > 0 ? projected : undefined
}

export function renderComputerUseActionFacts(messages: Array<{ role: string; content: any }>): string {
  const facts = new Map<string, string>()
  const recordFact = (fact: any): void => {
    // 形状收紧（#709 第 2 项）：phase 枚举校验 + 字段截断后渲染，非法事实整条丢弃。
    const normalized = normalizeComputerUseActionFact(fact)
    if (!normalized) return
    const { actionId, action, phase } = normalized
    const app = normalized.window?.app ?? 'unknown app'
    const windowId = typeof normalized.window?.id === 'number' ? `#${normalized.window.id}` : ''
    const suffix = phase === 'verified' ? 'verified complete' : 'not verified complete'
    facts.set(actionId, `${actionId}: ${action} on ${app}${windowId}; phase=${phase}; ${suffix}`)
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
