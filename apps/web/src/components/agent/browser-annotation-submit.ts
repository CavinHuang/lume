import type { AgentBrowserAttachment, AgentBrowserAnnotationAttachment, AgentMessageAttachmentInput, AgentSendInput, BrowserAnnotationSessionSnapshot } from '@lume/shared'

export type BrowserAnnotationDirectRequest = {
  version: 1
  threadId: string
  tabId: string
  annotation: AgentBrowserAnnotationAttachment
  attempts: number
  createdAt: string
}

export type BrowserAnnotationDirectPayload = Pick<AgentSendInput, 'threadId' | 'userMessage' | 'browserAttachments' | 'messageAttachments'>

const MAX_REQUEST_SIZE = 1_000_000

export function projectBrowserAnnotationSnapshot(
  attachments: AgentBrowserAttachment[],
  snapshot: Pick<BrowserAnnotationSessionSnapshot, 'threadId' | 'tabId' | 'comments'>,
): AgentBrowserAttachment[] {
  const scoped = (attachment: AgentBrowserAttachment) => attachment.origin === 'browser-annotation'
    && attachment.tab.tabId === snapshot.tabId
    && attachment.tab.ownerThreadId === snapshot.threadId
  return [...attachments.filter((attachment) => !scoped(attachment)), ...snapshot.comments]
}

export function buildDirectBrowserAnnotationPayload(input: {
  threadId: string
  annotation: AgentBrowserAnnotationAttachment
  screenshot?: AgentMessageAttachmentInput
}): BrowserAnnotationDirectPayload {
  return {
    threadId: input.threadId,
    userMessage: input.annotation.body || '请处理这条网页批注。',
    browserAttachments: [input.annotation],
    ...(input.screenshot ? { messageAttachments: [input.screenshot] } : {}),
  }
}

export function resolveBrowserAnnotationBatchText(input: { rawText: string; hasSnapshot: boolean; hasCodeComments: boolean; hasBrowserAttachments: boolean }): string {
  if (input.rawText) return input.rawText
  if (input.hasSnapshot) return '请处理这些网页批注。'
  if (input.hasCodeComments) return '请处理这些代码审阅意见。'
  if (input.hasBrowserAttachments) return '请处理这些浏览器标签与网页批注。'
  return '请解读这些附件。'
}

export function serializeBrowserAnnotationDirectRequest(request: BrowserAnnotationDirectRequest): string {
  const value = JSON.stringify(request)
  if (value.length > MAX_REQUEST_SIZE) throw new Error('annotation_request_too_large')
  return value
}

export function parseBrowserAnnotationDirectRequest(value: string | null): BrowserAnnotationDirectRequest | null {
  if (!value || value.length > MAX_REQUEST_SIZE) return null
  try {
    const parsed = JSON.parse(value) as Partial<BrowserAnnotationDirectRequest>
    if (parsed.version !== 1 || typeof parsed.threadId !== 'string' || typeof parsed.tabId !== 'string' || typeof parsed.attempts !== 'number' || !parsed.annotation || typeof parsed.annotation.id !== 'string') return null
    return parsed as BrowserAnnotationDirectRequest
  } catch {
    return null
  }
}

export function resolveBrowserAnnotationSubmission(input: {
  attachments: AgentBrowserAttachment[]
  directAttachment?: AgentBrowserAttachment | null
}): { attachments: AgentBrowserAttachment[]; preserveComposer: boolean; text: string } {
  if (input.directAttachment) {
    return {
      attachments: [input.directAttachment],
      preserveComposer: true,
      text: ('body' in input.directAttachment && typeof input.directAttachment.body === 'string' && input.directAttachment.body) ? input.directAttachment.body : '请处理这条网页批注。',
    }
  }
  return {
    attachments: input.attachments,
    preserveComposer: false,
    text: input.attachments.length > 0 ? '请处理这些浏览器标签与网页批注。' : '请解读这些附件。',
  }
}
