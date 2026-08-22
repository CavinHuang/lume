import { type QuotedSelection, type QuotedSelectionSourceType } from '@/atoms'

/**
 * 划线引用序列化（Quoted Selection serialization）
 *
 * 复刻自 Proma apps/electron/src/renderer/lib/quoted-selection.ts，纯函数无副作用。
 * 引用块以 XML 形式 prepend 到 userMessage text（随 user 消息持久化/传输），
 * 渲染时 parseQuotedSelectionRefs 无损还原为引用卡片 + 纯文本。
 *
 * 选择 XML 而非 markdown blockquote：XML 可携带 source/role/messageId 等结构化元数据，
 * 便于反解；blockquote 做不到。
 */


export interface ParsedQuotedSelectionRef {
  path: string
  filename: string
  sourceType: QuotedSelectionSourceType
  label?: string
}

/** 浮动动作菜单的 DOM 选择器（采集层用它排除菜单内的点击） */
export const SELECTION_ACTION_POPOVER_SELECTOR = '[data-selection-action-popover]'

const QUOTED_FILE_REGEX = /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g
const QUOTED_CONTEXT_REGEX = /<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** 破坏引用文本中嵌套的闭合标签，防止 XML 注入 */
function sanitizeQuotedText(value: string): string {
  return value
    .replace(/<\/quoted_file>/gi, '</quoted_file_>')
    .replace(/<\/quoted_context>/gi, '</quoted_context_>')
}

/**
 * 把一条 QuotedSelection 序列化为 prepend 用的 XML 块。
 * - file 来源 → <quoted_file path="…">
 * - 其余（agent-history/reading）→ <quoted_context source label message_id role>
 */
export function buildQuotedSelectionBlock(quotedSelection: QuotedSelection): string {
  const safeText = sanitizeQuotedText(quotedSelection.text)

  if (quotedSelection.sourceType && quotedSelection.sourceType !== 'file') {
    const safeSource = escapeXmlAttribute(quotedSelection.sourceType)
    const safeLabel = escapeXmlAttribute(quotedSelection.sourceLabel ?? quotedSelection.filePath)
    const safeMessageId = escapeXmlAttribute(quotedSelection.messageId ?? '')
    const safeRole = escapeXmlAttribute(quotedSelection.messageRole ?? '')
    return `<quoted_context source="${safeSource}" label="${safeLabel}" message_id="${safeMessageId}" role="${safeRole}">\n${safeText}\n</quoted_context>\n\n`
  }

  const safePath = escapeXmlAttribute(quotedSelection.filePath)
  return `<quoted_file path="${safePath}">\n${safeText}\n</quoted_file>\n\n`
}

function normalizeContextSourceType(value: string | undefined): QuotedSelectionSourceType {
  if (value === 'file') return 'file'
  if (value === 'reading') return 'reading'
  return 'agent-history'
}

/**
 * 反解消息内容中的引用块，返回引用列表 + 剥离 XML 后的纯文本。
 * 渲染层用它在 user 消息上还原「引用卡片 + 干净文本」。
 */
export function parseQuotedSelectionRefs(content: string): { quotes: ParsedQuotedSelectionRef[]; text: string } {
  const quotes: ParsedQuotedSelectionRef[] = []

  let quoteMatch: RegExpExecArray | null
  QUOTED_FILE_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_FILE_REGEX.exec(content)) !== null) {
    const pathMatch = quoteMatch[0].match(/path="([^"]*)"/)
    if (!pathMatch) continue
    const filePath = decodeXmlAttribute(pathMatch[1]!)
    quotes.push({
      path: filePath,
      filename: filePath.split('/').pop() ?? filePath,
      sourceType: 'file',
    })
  }

  QUOTED_CONTEXT_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_CONTEXT_REGEX.exec(content)) !== null) {
    const labelMatch = quoteMatch[0].match(/label="([^"]*)"/)
    const sourceMatch = quoteMatch[0].match(/source="([^"]*)"/)
    const label = labelMatch ? decodeXmlAttribute(labelMatch[1]!) : 'Agent 历史'
    const sourceType = normalizeContextSourceType(sourceMatch ? decodeXmlAttribute(sourceMatch[1]!) : 'agent-history')
    quotes.push({
      path: label,
      filename: label,
      sourceType,
      label,
    })
  }

  const text = content
    .replace(QUOTED_FILE_REGEX, '')
    .replace(QUOTED_CONTEXT_REGEX, '')
    .trim()

  return { quotes, text }
}
