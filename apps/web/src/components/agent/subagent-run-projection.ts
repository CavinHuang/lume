import type { LumeRuntimeEvent } from '@lume/shared'

export interface SubagentRunActivitySummary {
  text?: string
  toolName?: string
  error?: string
}

/** 委派工具名:含 coordinator 时代的 'Agent'(历史回放)与现行 'Delegate'。 */
export function isDelegationToolName(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Delegate'
}

export function selectSubagentRunEvents(
  events: LumeRuntimeEvent[],
  run: { runId: string; runtimeRunIds?: string[] },
): LumeRuntimeEvent[] {
  const runIds = new Set(run.runtimeRunIds?.length ? run.runtimeRunIds : [run.runId])
  return events.filter((event) => runIds.has(event.runId))
}

export function summarizeSubagentRunActivity(events: LumeRuntimeEvent[]): SubagentRunActivitySummary {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'run.failed') return { error: event.error.message }
    if (event.type === 'run.cancelled') return { error: event.reason ?? 'Run cancelled' }
    if (event.type === 'tool.failed') return { error: event.error.message, ...(event.toolName ? { toolName: event.toolName } : {}) }
    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      return event.toolName ? { toolName: event.toolName } : {}
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta') {
      if (event.delta.trim()) return { text: event.delta.trim() }
    }
    if (event.type === 'assistant.final') {
      const text = event.blocks.map((block) => block.text).join('').trim()
      if (text) return { text }
    }
  }
  return {}
}
