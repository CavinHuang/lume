import type { RuntimeToolCallView } from '../runtime-message-view'

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function asString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input : undefined
}

function summarizeInput(input: unknown, toolName?: string): string {
  if (toolName?.startsWith(BROWSER_TOOL_PREFIX)) return summarizeBrowserInput(toolName, input)
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
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}...` : value
  if (value === undefined) return '正在执行工具调用'
  return JSON.stringify(value)
}

/** #601:内置浏览器工具的统一前缀 */
export const BROWSER_TOOL_PREFIX = 'mcp__browser__'

const BROWSER_TOOL_LABELS: Record<string, string> = {
  open: '新建标签页', list_tabs: '列出标签页', switch_tab: '切换标签页',
  navigate: '打开网页', back: '网页后退', forward: '网页前进', reload: '刷新页面',
  snapshot: '读取页面快照', screenshot: '截取页面截图',
  click: '点击', double_click: '双击', hover: '悬停',
  fill: '填写', type: '输入文字', press: '按键',
  select: '选择选项', check: '勾选',
  scroll: '滚动页面', upload: '上传文件', download: '下载文件',
  fill_secret: '填写已存密码', list_secrets: '列出已存密码',
  run_script: '执行脚本', dialog: '处理对话框', handle_dialog: '处理对话框',
}

/** #601:去掉 mcp__browser__ 前缀并映射为中文动作名 */
export function displayToolName(name: string): string {
  if (!name.startsWith(BROWSER_TOOL_PREFIX)) return name
  const action = name.slice(BROWSER_TOOL_PREFIX.length)
  return `浏览器 · ${BROWSER_TOOL_LABELS[action] ?? action}`
}

function compactValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return text.length > 48 ? `${text.slice(0, 45)}...` : text
}

function summarizeRef(record: Record<string, unknown>): string {
  // schema 允许模型传 "@e12" 或 "e12"，剥掉前导 @ 防 "@@e12" 双前缀
  const ref = (asString(record.ref) ?? asString(record.element_ref))?.replace(/^@/, '')
  if (!ref) return ''
  // @e12(search button)：ref 恒在，label/描述有则附上
  const label = asString(record.label) ?? asString(record.semanticIntent) ?? asString(record.description)
  return label ? `@${ref}(${compactValue(label)})` : `@${ref}`
}

/** #601:浏览器动作的语义摘要——「打开 example.com」「点击 @e12(搜索)」 */
function summarizeBrowserInput(toolName: string, input: unknown): string {
  const action = toolName.slice(BROWSER_TOOL_PREFIX.length)
  const record = asRecord(input)
  // check 兼作取消勾选：checked===false 时语义反转
  const label = action === 'check' && record.checked === false ? '取消勾选' : BROWSER_TOOL_LABELS[action] ?? action
  switch (action) {
    case 'navigate': case 'open': {
      const url = asString(record.url)
      if (!url) return label
      try { return `${label} ${new URL(url).host}${new URL(url).pathname === '/' ? '' : new URL(url).pathname.slice(0, 24)}` } catch { return `${label} ${compactValue(url)}` }
    }
    case 'click': case 'double_click': case 'hover': case 'check': {
      const target = summarizeRef(record)
      return target ? `${label} ${target}` : label
    }
    case 'fill': case 'type': {
      const target = summarizeRef(record)
      const text = asString(record.text)
      // 隐私：fill/type 常用于密码等敏感输入框，只显长度不摘录明文
      return `${label} ${target}${text ? ` 「已输入 ${text.length} 字符」` : ''}`.trimEnd()
    }
    case 'press': {
      const key = asString(record.key) ?? asString(record.keys)
      return key ? `${label} ${compactValue(key)}` : label
    }
    case 'select': {
      const target = summarizeRef(record)
      const option = asString(record.option) ?? asString(record.value)
      return `${label} ${target}${option ? ` → ${compactValue(option)}` : ''}`.trimEnd()
    }
    case 'scroll': {
      // schema 为 delta_x/delta_y，按符号给方向
      const deltaY = typeof record.delta_y === 'number' ? record.delta_y : undefined
      const direction = deltaY === undefined ? undefined : deltaY > 0 ? '向下' : deltaY < 0 ? '向上' : '横向'
      const target = summarizeRef(record)
      return [label, direction, target].filter(Boolean).join(' ')
    }
    default: {
      const target = summarizeRef(record) || (asString(record.url) ? compactValue(record.url) : '')
      return target ? `${label} ${target}` : label
    }
  }
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

export { asRecord, asString, formatToolErrorOutput, memoryMutationError, memoryMutationLabel, parseToolCallOutput, summarizeInput }
