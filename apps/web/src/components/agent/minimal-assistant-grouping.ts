import type { RuntimeAssistantBlock } from './runtime-message-view'

/**
 * 极简模式分组：相邻的 thinking / tool_call 合并成一个 process 段；
 * text / plan_preview 等保持原位作为 inline 段。保留 blocks 原顺序。
 */
export type AssistantSegment =
  | { kind: 'inline'; block: RuntimeAssistantBlock }
  | { kind: 'process'; blocks: RuntimeAssistantBlock[] }
  | { kind: 'memory_mutation'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }
  | { kind: 'ask_user_question'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }
  | { kind: 'image_tools'; blocks: Array<Extract<RuntimeAssistantBlock, { type: 'tool_call' }>> }
  | { kind: 'wiki_proposal'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }

export function groupAssistantBlocksForMinimal(blocks: RuntimeAssistantBlock[]): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  let buffer: RuntimeAssistantBlock[] = []
  let imageBuffer: Array<Extract<RuntimeAssistantBlock, { type: 'tool_call' }>> = []

  const flushProcess = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'process', blocks: buffer })
      buffer = []
    }
  }

  const flushImages = () => {
    if (imageBuffer.length > 0) {
      segments.push({ kind: 'image_tools', blocks: imageBuffer })
      imageBuffer = []
    }
  }

  for (const block of blocks) {
    if (block.type === 'tool_call' && isAskUserQuestion(block)) {
      flushProcess()
      flushImages()
      segments.push({ kind: 'ask_user_question', block })
      continue
    }
    if (block.type === 'tool_call' && isCompletedWikiProposal(block)) {
      flushProcess()
      flushImages()
      segments.push({ kind: 'wiki_proposal', block })
      continue
    }
    if (block.type === 'tool_call' && isMemoryMutation(block)) {
      flushProcess()
      flushImages()
      segments.push({ kind: 'memory_mutation', block })
      continue
    }
    if (block.type === 'tool_call' && block.toolCall.toolName === 'image_gen') {
      flushProcess()
      imageBuffer.push(block)
      continue
    }
    flushImages()
    if (block.type === 'thinking' || block.type === 'tool_call' || block.type === 'todo_update') {
      buffer.push(block)
    } else {
      flushProcess()
      segments.push({ kind: 'inline', block })
    }
  }
  flushImages()
  flushProcess()
  return segments
}

export type StandardAssistantSegment =
  | { kind: 'inline'; block: RuntimeAssistantBlock }
  | { kind: 'memory_mutation'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }
  | { kind: 'ask_user_question'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }
  | { kind: 'image_tools'; blocks: Array<Extract<RuntimeAssistantBlock, { type: 'tool_call' }>> }
  | { kind: 'wiki_proposal'; block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }> }

/** 标准模式只合并相邻图片生成调用，其余块保持原有逐块展示。 */
export function groupAssistantBlocksForStandard(blocks: RuntimeAssistantBlock[]): StandardAssistantSegment[] {
  const segments: StandardAssistantSegment[] = []
  let imageBuffer: Array<Extract<RuntimeAssistantBlock, { type: 'tool_call' }>> = []

  const flushImages = () => {
    if (imageBuffer.length > 0) {
      segments.push({ kind: 'image_tools', blocks: imageBuffer })
      imageBuffer = []
    }
  }

  for (const block of blocks) {
    if (block.type === 'tool_call' && isAskUserQuestion(block)) {
      flushImages()
      segments.push({ kind: 'ask_user_question', block })
      continue
    }
    if (block.type === 'tool_call' && isCompletedWikiProposal(block)) {
      flushImages()
      segments.push({ kind: 'wiki_proposal', block })
      continue
    }
    if (block.type === 'tool_call' && isMemoryMutation(block)) {
      flushImages()
      segments.push({ kind: 'memory_mutation', block })
      continue
    }
    if (block.type === 'tool_call' && block.toolCall.toolName === 'image_gen') {
      imageBuffer.push(block)
      continue
    }
    flushImages()
    segments.push({ kind: 'inline', block })
  }
  flushImages()
  return segments
}

export function isAskUserQuestion(
  block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }>,
): boolean {
  return block.toolCall.toolName === 'AskUserQuestion'
}

function isCompletedWikiProposal(
  block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }>,
): boolean {
  return block.toolCall.toolName === 'wiki.propose_changes'
    && block.toolCall.status === 'completed'
}

function isMemoryMutation(block: Extract<RuntimeAssistantBlock, { type: 'tool_call' }>): boolean {
  return block.toolCall.toolName === 'memory.remember' || block.toolCall.toolName === 'memory.forget'
}
