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
  if (node.type === 'planningTodoMention') {
    const todoId = typeof node.attrs?.todoId === 'string' ? node.attrs.todoId : ''
    const uri = typeof node.attrs?.uri === 'string' ? node.attrs.uri : ''
    const displayText = typeof node.attrs?.displayText === 'string' ? node.attrs.displayText : ''
    const relation = node.attrs?.relation === 'primary' ? 'primary' : 'mentioned'
    if (todoId && uri && displayText) parts.push({ type: 'planning_todo_ref', schemaVersion: 1, uri, todoId, relation, displayText })
    return
  }
  if (node.type === 'linkConnectionMention') {
    const service = typeof node.attrs?.service === 'string' ? node.attrs.service : ''
    const connectionName = typeof node.attrs?.connectionName === 'string' ? node.attrs.connectionName : ''
    const displayText = typeof node.attrs?.displayText === 'string' ? node.attrs.displayText : ''
    if (service && connectionName && displayText) {
      parts.push({ type: 'link_connection_ref', schemaVersion: 1, service, connectionName, displayText })
    }
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
    userMessage: messageParts.map((part) => part.type === 'text'
      ? part.text
      : part.type === 'planning_todo_ref'
        ? `&${part.displayText}`
        : part.type === 'link_connection_ref'
          ? `@${part.displayText}`
          : part.uri).join(''),
    messageParts,
  }
}

function visibleReferenceText(part: Exclude<AgentUserMessagePart, { type: 'text' }>): string {
  if (part.type === 'planning_todo_ref') return `&${part.displayText}`
  if (part.type === 'link_connection_ref') return `@${part.displayText}`
  return part.uri
}

/** Preserve existing structured references when editing their surrounding plain text. */
export function remapAgentMessagePartsForEditedText(
  originalParts: AgentUserMessagePart[] | undefined,
  nextText: string,
): AgentUserMessagePart[] | undefined {
  const references = originalParts?.filter((part): part is Exclude<AgentUserMessagePart, { type: 'text' }> => part.type !== 'text') ?? []
  if (references.length === 0) return undefined
  const visibleCounts = new Map<string, number>()
  for (const reference of references) {
    const visible = visibleReferenceText(reference)
    visibleCounts.set(visible, (visibleCounts.get(visible) ?? 0) + 1)
  }
  const hasAmbiguousIdentity = [...visibleCounts.values()].some((count) => count > 1)
  const originalText = originalParts?.map((part) => part.type === 'text' ? part.text : visibleReferenceText(part)).join('') ?? ''
  if (hasAmbiguousIdentity && nextText !== originalText) return undefined
  const nextParts: AgentUserMessagePart[] = []
  let cursor = 0
  for (const reference of references) {
    const visible = visibleReferenceText(reference)
    const index = nextText.indexOf(visible, cursor)
    if (index < 0) continue
    appendText(nextParts, nextText.slice(cursor, index))
    nextParts.push({ ...reference })
    cursor = index + visible.length
  }
  appendText(nextParts, nextText.slice(cursor))
  return nextParts.some((part) => part.type !== 'text') ? nextParts : undefined
}
