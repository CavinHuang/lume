import type { RuntimeToolCallView } from '../runtime-message-view'

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function asString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input : undefined
}

// link 工具摘要（参考 wanta connectorTarget）：
// link_call_action→"service · action" / link_inspect_actions→actions 列表 / link_list_apps→service
// link_search_actions 已由 record.query 命中，不进此分支
function linkTarget(record: Record<string, unknown>): string | undefined {
  const service = asString(record.service)
  const action = asString(record.action)
  if (service && action) return `${service} · ${action}`
  if (action) return action
  if (service) return service
  if (Array.isArray(record.actions) && record.actions.length > 0) {
    return record.actions.map((value) => String(value)).join(', ')
  }
  return undefined
}

function summarizeInput(input: unknown): string {
  const record = asRecord(input)
  const value = record.command
    ?? record.file_path
    ?? record.path
    ?? record.query
    ?? record.planFilePath
    ?? record.summary
    ?? record.goal
    ?? record.description
    ?? record.prompt
    ?? linkTarget(record)
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}...` : value
  if (value === undefined) return '正在执行工具调用'
  return JSON.stringify(value)
}

function parseToolCallOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function formatToolErrorOutput(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 8_000)
  if (!output || typeof output !== 'object') return String(output ?? '')
  try { return JSON.stringify(output, null, 2).slice(0, 8_000) } catch { return String(output) }
}

function memoryMutationLabel(toolCall: RuntimeToolCallView): string | null {
  if (toolCall.toolName !== 'memory.remember' && toolCall.toolName !== 'memory.forget') return null
  if (toolCall.status === 'running') return toolCall.toolName === 'memory.remember' ? '正在记住…' : '正在遗忘…'
  if (toolCall.status === 'failed') return toolCall.toolName === 'memory.remember' ? '记忆失败' : '遗忘失败'
  let output = toolCall.output
  if (typeof output === 'string') {
    try { output = JSON.parse(output) } catch { return toolCall.toolName === 'memory.remember' ? '记忆已处理' : '遗忘已处理' }
  }
  const record = asRecord(output)
  const data = asRecord(record.data)
  const summary = asString(data.summary ?? record.summary)
  return summary ?? (toolCall.toolName === 'memory.remember' ? '记忆已处理' : '遗忘已处理')
}

function memoryMutationError(toolCall: RuntimeToolCallView): string | null {
  if (toolCall.status !== 'failed') return null
  const error = formatToolErrorOutput(toolCall.output).trim()
  return error || null
}

export { asRecord, asString, formatToolErrorOutput, linkTarget, memoryMutationError, memoryMutationLabel, parseToolCallOutput, summarizeInput }
