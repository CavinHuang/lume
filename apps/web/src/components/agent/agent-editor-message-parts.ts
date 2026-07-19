import type { JSONContent } from '@tiptap/core'
import type { AgentUserMessagePart } from '@lume/shared'

function appendText(parts: AgentUserMessagePart[], text: string): void {
  if (!text) return
  const previous = parts.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    parts.push({ type: 'text', text })
  }
}

function serializeInline(node: JSONContent, parts: AgentUserMessagePart[]): void {
  if (node.type === 'text') {
    appendText(parts, node.text ?? '')
    return
  }
  if (node.type === 'hardBreak') {
    appendText(parts, '\n')
    return
  }
  if (node.type === 'capabilityMention') {
    const uri = typeof node.attrs?.uri === 'string' ? node.attrs.uri : ''
    const occurrenceId = typeof node.attrs?.occurrenceId === 'string' ? node.attrs.occurrenceId : ''
    if (uri && occurrenceId) parts.push({ type: 'capability_ref', occurrenceId, uri })
    return
  }
  if (node.type === 'mention') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : node.attrs?.id
    appendText(parts, `@${typeof label === 'string' ? label : ''}`)
    return
  }
  for (const child of node.content ?? []) serializeInline(child, parts)
}

function trimBoundaryWhitespace(parts: AgentUserMessagePart[]): AgentUserMessagePart[] {
  const result = parts.map((part) => ({ ...part }))
  if (result[0]?.type === 'text') result[0].text = result[0].text.trimStart()
  if (result.at(-1)?.type === 'text') {
    const last = result.at(-1) as Extract<AgentUserMessagePart, { type: 'text' }>
    last.text = last.text.trimEnd()
  }
  return result.filter((part) => part.type !== 'text' || part.text.length > 0)
}

export function serializeAgentEditorMessage(
  json: JSONContent,
  transformText: (text: string) => string = (text) => text,
): { userMessage: string; messageParts: AgentUserMessagePart[] } {
  const parts: AgentUserMessagePart[] = []
  const blocks = json.content ?? []
  blocks.forEach((block, index) => {
    serializeInline(block, parts)
    if (index < blocks.length - 1) appendText(parts, '\n')
  })
  const transformed = parts.map((part) => part.type === 'text'
    ? { ...part, text: transformText(part.text) }
    : part)
  const messageParts = trimBoundaryWhitespace(transformed)
  return {
    userMessage: messageParts.map((part) => part.type === 'text' ? part.text : part.uri).join(''),
    messageParts,
  }
}
