import type { RuntimeAssistantBlock } from './runtime-message-view'

/**
 * 极简模式分组：相邻的 thinking / tool_call 合并成一个 process 段；
 * text / plan_preview 等保持原位作为 inline 段。保留 blocks 原顺序。
 */
export type AssistantSegment =
  | { kind: 'inline'; block: RuntimeAssistantBlock }
  | { kind: 'process'; blocks: RuntimeAssistantBlock[] }

export function groupAssistantBlocksForMinimal(blocks: RuntimeAssistantBlock[]): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  let buffer: RuntimeAssistantBlock[] = []

  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'process', blocks: buffer })
      buffer = []
    }
  }

  for (const block of blocks) {
    if (block.type === 'thinking' || block.type === 'tool_call' || block.type === 'todo_update') {
      buffer.push(block)
    } else {
      flush()
      segments.push({ kind: 'inline', block })
    }
  }
  flush()
  return segments
}
