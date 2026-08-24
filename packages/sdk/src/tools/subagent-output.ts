export interface SubagentResultSummary {
  textOutput: string
  lastAssistantMessage?: string
  toolCalls: string[]
  toolUseCount: number
}

export interface FinalizeSubagentOutputState {
  textOutput: string
  toolCalls: string[]
  lastAssistantMessage?: string
  errorMessage?: string
  status?: 'completed' | 'errored' | 'aborted'
}

function buildToolSummary(toolCalls: string[]): string {
  if (toolCalls.length === 0) return ''
  return `\n[Tools used: ${toolCalls.join(', ')}]`
}

// 子代理全文回传父级上下文前的截断上限：保留结尾（结论通常在最后）。
const MAX_SUBAGENT_OUTPUT_CHARS = 30_000

function truncateForParent(text: string): string {
  if (text.length <= MAX_SUBAGENT_OUTPUT_CHARS) return text
  return `[Subagent output truncated (${text.length} chars total), showing the tail]\n...\n${text.slice(-MAX_SUBAGENT_OUTPUT_CHARS)}`
}

export function summarizeSubagentAssistantEvent(
  content: Array<Record<string, unknown>>,
  previousTextOutput = '',
  previousToolCalls: string[] = [],
): SubagentResultSummary {
  let textOutput = previousTextOutput
  let lastAssistantMessage = previousTextOutput.trim() || undefined
  const toolCalls = [...previousToolCalls]
  let toolUseCount = 0

  for (const block of content) {
    if (!block || typeof block !== 'object') continue

    if (typeof block.text === 'string' && block.text.trim()) {
      const normalizedText = block.text.trim()
      textOutput = textOutput
        ? `${textOutput}\n\n${normalizedText}`
        : normalizedText
      lastAssistantMessage = normalizedText
    }

    if (typeof block.name === 'string' && block.name.trim()) {
      toolCalls.push(block.name)
      toolUseCount += 1
      if (!lastAssistantMessage) {
        lastAssistantMessage = `调用工具 ${block.name}`
      }
    }
  }

  return {
    textOutput,
    lastAssistantMessage,
    toolCalls,
    toolUseCount,
  }
}

export function finalizeSubagentOutput(
  textOutput: string,
  toolCalls: string[],
): { output: string; lastAssistantMessage?: string } {
  const normalizedText = textOutput.trim()
  if (normalizedText) {
    return {
      output: truncateForParent(normalizedText) + buildToolSummary(toolCalls),
      lastAssistantMessage: normalizedText.slice(-500),
    }
  }

  if (toolCalls.length > 0) {
    const summary = `子 Agent 已完成，未返回最终文本总结。已执行工具：${toolCalls.join('、')}`
    return {
      output: summary + buildToolSummary(toolCalls),
      lastAssistantMessage: summary,
    }
  }

  return {
    output: '(Subagent completed with no text output)',
  }
}

export function finalizeSubagentOutputFromState(
  state: FinalizeSubagentOutputState,
): { output: string; lastAssistantMessage?: string } {
  const normalizedError = state.errorMessage?.trim()
  if (normalizedError) {
    const summary = `Subagent error: ${normalizedError}`
    const partialText = state.textOutput.trim()
    // 失败时保留已产出的部分结果，父级不必从零重做
    if (partialText) {
      return {
        output: `${truncateForParent(partialText)}\n\n[${summary}]`,
        lastAssistantMessage: summary,
      }
    }
    return {
      output: summary,
      lastAssistantMessage: summary,
    }
  }

  const finalized = finalizeSubagentOutput(state.textOutput, state.toolCalls)
  if (finalized.lastAssistantMessage) {
    return finalized
  }

  const fallback = state.lastAssistantMessage?.trim()
  if (fallback) {
    return {
      output: fallback,
      lastAssistantMessage: fallback,
    }
  }

  if (state.status === 'aborted') {
    return {
      output: 'Subagent aborted before producing output.',
      lastAssistantMessage: 'Subagent aborted before producing output.',
    }
  }

  return finalized
}
