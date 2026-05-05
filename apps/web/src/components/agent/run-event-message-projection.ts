import type { LumeRunEvent } from '@lume/shared'

export interface RunEventToolCallView {
  id: string
  toolName: string
  input: unknown
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  isError?: boolean
}

export type RunEventAssistantBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool_call'; id: string; toolCall: RunEventToolCallView }
  | { type: 'task_progress'; id: string; event: Extract<LumeRunEvent, { type: 'task_progress' }> }

export interface RunEventAssistantMessageView {
  id: string
  type: 'assistant'
  text: string
  thinking: string
  blocks: RunEventAssistantBlock[]
  status: 'streaming' | 'completed' | 'failed'
  error?: string
  toolCalls: RunEventToolCallView[]
}

export interface RunEventUserMessageView {
  id: string
  type: 'user'
  text: string
  createdAt: string
  messageId?: string
  versionGroupId?: string
  versionIndex?: number
  versionCount?: number
}

export type RunEventMessageView = RunEventUserMessageView | RunEventAssistantMessageView

export function projectRunEventMessages(events: LumeRunEvent[]): RunEventMessageView[] {
  events = keepLatestVersionTurns(events)
  const messages: RunEventMessageView[] = []
  let currentAssistant: MutableAssistantMessage | null = null
  let terminalClosed = false

  events.forEach((event, index) => {
    if (event.type === 'user_message_submitted') {
      flushAssistant(messages, currentAssistant)
      messages.push({
        id: event.messageId ?? `user:${event.createdAt}`,
        type: 'user',
        text: event.text,
        createdAt: event.createdAt,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.versionGroupId ? { versionGroupId: event.versionGroupId } : {}),
        ...(typeof event.versionIndex === 'number' ? { versionIndex: event.versionIndex } : {}),
        ...(typeof event.versionCount === 'number' ? { versionCount: event.versionCount } : {}),
      })
      currentAssistant = createAssistantMessage(`assistant:${event.createdAt}`)
      terminalClosed = false
      return
    }

    if (event.type === 'task_progress') {
      if (terminalClosed || !currentAssistant) {
        currentAssistant = createAssistantMessage(`assistant:task:${event.createdAt}`)
      }
      terminalClosed = false
      currentAssistant.blocks.push({
        type: 'task_progress',
        id: `task:${event.taskRunId}:${event.createdAt}`,
        event,
      })
      currentAssistant.text += event.message ?? ''
      return
    }

    if (terminalClosed) {
      return
    }

    if (event.type === 'assistant_delta') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      currentAssistant.text += event.text
      appendAssistantTextBlock(currentAssistant, event.text)
      return
    }

    if (event.type === 'assistant_thinking_delta') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      currentAssistant.thinking += event.text
      appendAssistantThinkingBlock(currentAssistant, event.text)
      return
    }

    if (event.type === 'assistant_message_final') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      replaceAssistantContentBlocks(currentAssistant, event.blocks)
      return
    }

    if (event.type === 'tool_call_started') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      const toolCall: RunEventToolCallView = {
        id: event.item.id,
        toolName: event.item.toolName,
        input: event.item.input,
        status: 'running',
      }
      currentAssistant.toolCalls.set(event.item.id, toolCall)
      currentAssistant.toolBlockIds.set(event.item.id, currentAssistant.blocks.length)
      currentAssistant.blocks.push({ type: 'tool_call', id: `tool:${event.item.id}`, toolCall })
      currentAssistant.currentContentSegmentStart = currentAssistant.blocks.length
      return
    }

    if (event.type === 'tool_call_completed') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      const existing = currentAssistant.toolCalls.get(event.item.toolCallId)
      const toolCall: RunEventToolCallView = {
        id: event.item.toolCallId,
        toolName: event.item.toolName ?? existing?.toolName ?? event.item.toolCallId,
        input: existing?.input ?? {},
        status: event.item.isError ? 'failed' : 'completed',
        output: event.item.output,
        isError: event.item.isError === true,
      }
      currentAssistant.toolCalls.set(event.item.toolCallId, toolCall)
      const blockIndex = currentAssistant.toolBlockIds.get(event.item.toolCallId)
      if (blockIndex === undefined) {
        currentAssistant.toolBlockIds.set(event.item.toolCallId, currentAssistant.blocks.length)
        currentAssistant.blocks.push({ type: 'tool_call', id: `tool:${event.item.toolCallId}`, toolCall })
        currentAssistant.currentContentSegmentStart = currentAssistant.blocks.length
      } else {
        currentAssistant.blocks[blockIndex] = { type: 'tool_call', id: `tool:${event.item.toolCallId}`, toolCall }
      }
      return
    }

    if (event.type === 'run_completed') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      currentAssistant.status = 'completed'
      flushAssistant(messages, currentAssistant)
      currentAssistant = null
      terminalClosed = true
      return
    }

    if (event.type === 'run_failed') {
      currentAssistant ??= createAssistantMessage(`assistant:${index}`)
      currentAssistant.status = 'failed'
      currentAssistant.error = event.error.message
      flushAssistant(messages, currentAssistant)
      currentAssistant = null
      terminalClosed = true
    }
  })

  flushAssistant(messages, currentAssistant)
  return messages
}

function keepLatestVersionTurns(events: LumeRunEvent[]): LumeRunEvent[] {
  const latestTurnByGroup = new Map<string, number>()
  let turnIndex = -1
  for (const event of events) {
    if (event.type !== 'user_message_submitted') continue
    turnIndex += 1
    if (!event.versionGroupId) continue
    const current = latestTurnByGroup.get(event.versionGroupId)
    if (current === undefined || (event.versionIndex ?? 0) >= current) {
      latestTurnByGroup.set(event.versionGroupId, event.versionIndex ?? turnIndex)
    }
  }
  if (latestTurnByGroup.size === 0) return events

  const filtered: LumeRunEvent[] = []
  let includeCurrentTurn = true
  for (const event of events) {
    if (event.type === 'user_message_submitted') {
      includeCurrentTurn = !event.versionGroupId
        || latestTurnByGroup.get(event.versionGroupId) === (event.versionIndex ?? 0)
    }
    if (includeCurrentTurn) {
      filtered.push(event)
    }
  }
  return filtered
}

interface MutableAssistantMessage {
  id: string
  text: string
  thinking: string
  status: RunEventAssistantMessageView['status']
  error?: string
  toolCalls: Map<string, RunEventToolCallView>
  toolBlockIds: Map<string, number>
  blocks: RunEventAssistantBlock[]
  currentContentSegmentStart: number
}

function createAssistantMessage(id: string): MutableAssistantMessage {
  return {
    id,
    text: '',
    thinking: '',
    status: 'streaming',
    toolCalls: new Map(),
    toolBlockIds: new Map(),
    blocks: [],
    currentContentSegmentStart: 0,
  }
}

function appendAssistantTextBlock(assistant: MutableAssistantMessage, text: string): void {
  const last = assistant.blocks.at(-1)
  if (last?.type === 'text') {
    last.text += text
    return
  }
  assistant.blocks.push({
    type: 'text',
    id: `text:${assistant.blocks.length}`,
    text,
  })
}

function appendAssistantThinkingBlock(assistant: MutableAssistantMessage, text: string): void {
  const last = assistant.blocks.at(-1)
  if (last?.type === 'thinking') {
    last.text += text
    return
  }

  assistant.blocks.push({
    type: 'thinking',
    id: `thinking:${assistant.blocks.length}`,
    text,
  })
}

function reindexToolBlocks(assistant: MutableAssistantMessage): void {
  assistant.toolBlockIds.clear()
  assistant.blocks.forEach((block, index) => {
    if (block.type === 'tool_call') {
      assistant.toolBlockIds.set(block.toolCall.id, index)
    }
  })
}

function replaceAssistantContentBlocks(
  assistant: MutableAssistantMessage,
  blocks: Array<{ type: 'text' | 'thinking'; text: string }>,
): void {
  const finalHasThinking = blocks.some((block) => block.type === 'thinking' && block.text.trim())
  const segmentStart = Math.min(assistant.currentContentSegmentStart, assistant.blocks.length)
  const beforeSegment = assistant.blocks.slice(0, segmentStart)
  const currentSegment = assistant.blocks.slice(segmentStart)
  const preservedCurrentSegment = currentSegment.filter((block) => (
    block.type === 'tool_call'
    || (!finalHasThinking && block.type === 'thinking')
  ))
  assistant.blocks = [...beforeSegment, ...preservedCurrentSegment]
  reindexToolBlocks(assistant)

  for (const block of blocks) {
    if (block.type === 'text') {
      assistant.text += block.text
      appendAssistantTextBlock(assistant, block.text)
    } else {
      assistant.thinking += block.text
      appendAssistantThinkingBlock(assistant, block.text)
    }
  }
  recomputeAssistantContent(assistant)
}

function recomputeAssistantContent(assistant: MutableAssistantMessage): void {
  assistant.text = assistant.blocks
    .filter((block): block is Extract<RunEventAssistantBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
  assistant.thinking = assistant.blocks
    .filter((block): block is Extract<RunEventAssistantBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map((block) => block.text)
    .join('')
}

function flushAssistant(
  messages: RunEventMessageView[],
  assistant: MutableAssistantMessage | null,
): void {
  if (!assistant) return
  const hasContent = assistant.text.trim()
    || assistant.thinking.trim()
    || assistant.toolCalls.size > 0
    || assistant.error
  const shouldRenderPlaceholder = assistant.status === 'streaming'
  if (!hasContent && !shouldRenderPlaceholder) return
  messages.push({
    id: assistant.id,
    type: 'assistant',
    text: assistant.text,
    thinking: assistant.thinking,
    blocks: assistant.blocks,
    status: assistant.status,
    ...(assistant.error ? { error: assistant.error } : {}),
    toolCalls: [...assistant.toolCalls.values()],
  })
}
