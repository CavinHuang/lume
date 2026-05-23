import type { AgentMessage, AgentMessageAttachmentInput } from '@lume/shared'
import type { RuntimeMessageView } from './runtime-message-view'

const SCROLL_BOTTOM_THRESHOLD_PX = 80

type ScrollMetrics = {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold
}

export function shouldAutoScrollAfterUserScroll({
  currentScrollTop,
  previousScrollTop,
  nearBottom,
}: {
  currentScrollTop: number
  previousScrollTop: number
  nearBottom: boolean
}): boolean {
  if (currentScrollTop < previousScrollTop) return false
  return nearBottom
}

export function getPreservedScrollTopAfterResize({
  currentScrollTop,
  previousScrollHeight,
  nextScrollHeight,
}: {
  currentScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
}): number {
  if (previousScrollHeight <= 0 || previousScrollHeight === nextScrollHeight) {
    return currentScrollTop
  }
  return currentScrollTop + nextScrollHeight - previousScrollHeight
}

export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
): RuntimeMessageView[] {
  const visibleUsers = visibleThreadMessages.filter((message) => message.role === 'user')
  if (visibleUsers.length === 0) return messages
  const usedVisibleIds = new Set<string>()

  return messages.map((message) => {
    if (message.type === 'user') {
      if (message.messageId) {
        const visible = visibleUsers.find((item) => item.id === message.messageId)
        return visible ? withPersistedUserAttachments(message, visible) : message
      }

      const visible = visibleUsers.find((item) => (
        !usedVisibleIds.has(item.id)
        && item.content === message.text
        && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
      )) ?? visibleUsers.find((item) => !usedVisibleIds.has(item.id) && item.content === message.text)

      if (visible) {
        usedVisibleIds.add(visible.id)
        return withPersistedUserAttachments({
          ...message,
          id: visible.id,
          messageId: visible.id,
          versionGroupId: visible.versionGroupId,
          versionIndex: visible.versionIndex,
          versionCount: visible.versionCount,
        }, visible)
      }
      return message
    }

    return message
  })
}

export function collectNewRuntimeMessageIds(
  previousIds: ReadonlySet<string>,
  messages: RuntimeMessageView[],
): Set<string> {
  const next = new Set<string>()
  for (const message of messages) {
    if (!previousIds.has(message.id)) {
      next.add(message.id)
    }
  }
  return next
}

export function collectRuntimeMessageIds(messages: RuntimeMessageView[]): Set<string> {
  return new Set(messages.map((message) => message.id))
}

function withPersistedUserAttachments(
  message: Extract<RuntimeMessageView, { type: 'user' }>,
  visible: AgentMessage,
): Extract<RuntimeMessageView, { type: 'user' }> {
  if (message.attachments?.length) return message
  const attachments = readPersistedMessageAttachments(visible.metadata)
  return attachments.length > 0 ? { ...message, attachments } : message
}

function readPersistedMessageAttachments(metadata: Record<string, unknown> | undefined): AgentMessageAttachmentInput[] {
  const raw = metadata?.messageAttachments
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AgentMessageAttachmentInput => (
    item !== null
    && typeof item === 'object'
    && typeof (item as AgentMessageAttachmentInput).id === 'string'
    && typeof (item as AgentMessageAttachmentInput).filename === 'string'
    && typeof (item as AgentMessageAttachmentInput).mediaType === 'string'
    && typeof (item as AgentMessageAttachmentInput).size === 'number'
    && typeof (item as AgentMessageAttachmentInput).threadPath === 'string'
  ))
}
