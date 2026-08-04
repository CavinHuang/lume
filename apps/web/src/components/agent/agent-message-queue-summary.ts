import type { AgentQueuedMessage } from '@lume/shared'

/**
 * 队列消息的可读摘要(对齐 Codex:有文本用文本;否则按附件降级)。
 * 仅用于 UI 单行展示,不参与发给模型的上下文。
 */
export function summarizeQueuedMessage(item: AgentQueuedMessage): string {
  const text = item.text?.trim() ?? ''
  if (text.length > 0) return text

  const browserCount = item.browserAttachments?.length ?? 0
  const fileCount = item.messageAttachments?.length ?? 0
  const commentCount = item.commentAttachments?.length ?? 0

  if (browserCount > 0) return `${browserCount} 条浏览器注释`
  if (commentCount > 0) return `${commentCount} 条代码注释`
  if (fileCount > 0) return `${fileCount} 个文件附件`
  return '（空消息）'
}
