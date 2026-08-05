import type { AgentQueuedMessage } from '@lume/shared'
import { parseQuotedSelectionRefs } from '@/lib/quoted-selection'

/**
 * 队列消息的可读摘要(对齐 Codex J 函数:有文本用文本;否则多类型附件联合计数)。
 * 仅用于 UI 单行展示,不参与发给模型的上下文。剥离引用 XML 块(避免裸露 <quoted_context>)。
 */
export function summarizeQueuedMessage(item: AgentQueuedMessage): string {
  const { text } = parseQuotedSelectionRefs(item.text?.trim() ?? '')
  if (text.length > 0) return text

  const parts: string[] = []
  const fileCount = item.messageAttachments?.length ?? 0
  const commentCount = item.commentAttachments?.length ?? 0
  const browserCount = item.browserAttachments?.length ?? 0
  if (fileCount > 0) parts.push(`${fileCount} 文件`)
  if (commentCount > 0) parts.push(`${commentCount} 评论`)
  if (browserCount > 0) parts.push(`${browserCount} 浏览器注释`)

  return parts.length > 0 ? parts.join(' · ') : '（空消息）'
}
