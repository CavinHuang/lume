export interface SubagentResultSummary {
  textOutput: string
  lastAssistantMessage?: string
  toolCalls: string[]
  toolUseCount: number
}

function buildToolSummary(toolCalls: string[]): string {
  if (toolCalls.length === 0) return ''
  return `\n[Tools used: ${toolCalls.join(', ')}]`
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
      output: normalizedText + buildToolSummary(toolCalls),
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
