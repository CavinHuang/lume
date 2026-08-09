// 工具/运行结果预览的截断策略（参考 wanta tool-output-preview.ts）。
// 结果可能是很大的 JSON，详情面板只需即时预览，超限避免在渲染进程同步解析排版整个结果。

export const TOOL_OUTPUT_PREVIEW_LIMIT = 24_000

export interface ToolOutputPreview {
  text: string
  truncated: boolean
}

/** 接收已序列化的字符串，返回美化 + 截断后的预览。 */
export function formatToolOutputPreview(output: string): ToolOutputPreview {
  if (output.length > TOOL_OUTPUT_PREVIEW_LIMIT) {
    return { text: `${output.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`, truncated: true }
  }
  try {
    const formatted = JSON.stringify(JSON.parse(output), null, 2)
    if (formatted.length > TOOL_OUTPUT_PREVIEW_LIMIT) {
      return { text: `${formatted.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`, truncated: true }
    }
    return { text: formatted, truncated: false }
  } catch {
    return { text: output, truncated: false }
  }
}

/** 任意值 → 预览（先序列化再截断）。 */
export function previewValue(value: unknown): ToolOutputPreview {
  return formatToolOutputPreview(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
