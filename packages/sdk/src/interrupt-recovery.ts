// packages/sdk/src/interrupt-recovery.ts
import type { NormalizedMessageParam } from './providers/types.js'
import type { PersistedToolContinuation } from './types.js'

export interface DanglingToolUse {
  id: string
  name: string
  input: unknown
}

/**
 * Detect tool_use blocks in the trailing assistant message that have no
 * matching tool_result — the residue of an interrupted or crashed run.
 * Only the trailing assistant is inspected; earlier gaps are historical
 * damage and are intentionally ignored.
 */
export function detectDanglingToolUses(messages: NormalizedMessageParam[]): DanglingToolUse[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const blocks = message.content as Array<Record<string, unknown>>
    const toolUses = blocks.filter((block) => block.type === 'tool_use')
    if (toolUses.length === 0) continue

    const answered = new Set<string>()
    for (let j = i + 1; j < messages.length; j++) {
      const later = messages[j] as { role?: string; content?: unknown }
      if (later.role !== 'user' || !Array.isArray(later.content)) continue
      for (const block of later.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          answered.add(block.tool_use_id)
        }
      }
    }
    return toolUses
      .filter((block) => !answered.has(block.id as string))
      .map((block) => ({
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      }))
  }
  return []
}

export interface ResumeToolInfo {
  /** Unknown tools must answer false: never auto-replay a possibly-mutating tool. */
  isReadOnly: (toolName: string) => boolean
}

/**
 * Build persisted tool continuations from dangling tool uses. Read-only /
 * concurrency-safe tools replay once (toolCall only); everything else gets an
 * interrupted error placeholder so the model knows the actual state is
 * unknown. Duplicate tool_call ids are deduped here (keeping the first)
 * because the engine does not dedupe within one continuation batch.
 */
export function buildResumeContinuations(
  dangling: DanglingToolUse[],
  toolInfo: ResumeToolInfo,
): PersistedToolContinuation[] {
  const seen = new Set<string>()
  const continuations: PersistedToolContinuation[] = []
  for (const use of dangling) {
    if (seen.has(use.id)) continue
    seen.add(use.id)
    const toolCall = { id: use.id, name: use.name, input: use.input }
    continuations.push(
      toolInfo.isReadOnly(use.name)
        ? { toolCall }
        : {
            toolCall,
            toolResult: {
              type: 'tool_result' as const,
              tool_use_id: use.id,
              content:
                'Error: interrupted before completion; actual state unknown — inspect the workspace before retrying.',
              is_error: true,
            },
          },
    )
  }
  return continuations
}
