import { describe, expect, test } from 'bun:test'
import { buildDirectBrowserAnnotationPayload, parseBrowserAnnotationDirectRequest, projectBrowserAnnotationSnapshot, resolveBrowserAnnotationBatchText, resolveBrowserAnnotationSubmission, serializeBrowserAnnotationDirectRequest } from './browser-annotation-submit'

const annotation = { id: 'annotation-1', origin: 'browser-annotation' as const, tab: { id: 'tab', origin: 'browser-tab' as const, tabId: 'tab', ownerThreadId: 'thread-1', title: 'Example', url: 'https://example.test/' }, anchor: { kind: 'element' as const, url: 'https://example.test/', generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } }, body: 'Review this' }

describe('browser annotation submission', () => {
  test('direct send keeps the existing composer and submits only the current annotation', () => {
    expect(resolveBrowserAnnotationSubmission({ attachments: [annotation], directAttachment: annotation })).toEqual({ attachments: [annotation], preserveComposer: true, text: '请处理这条网页批注。' })
  })

  test('normal composer submission retains all annotations for send or queue', () => {
    const second = { ...annotation, id: 'annotation-2', body: 'Check spacing' }
    expect(resolveBrowserAnnotationSubmission({ attachments: [annotation, second] })).toEqual({ attachments: [annotation, second], preserveComposer: false, text: '请处理这些浏览器标签与网页批注。' })
  })

  test('snapshot projection replaces only the matching annotation session, including clear/delete', () => {
    const other = { ...annotation, id: 'other', tab: { ...annotation.tab, tabId: 'other-tab', ownerThreadId: 'thread-1' } }
    const nonAnnotation = { ...annotation.tab, id: 'browser-tab:other', tabId: 'other-tab' }
    expect(projectBrowserAnnotationSnapshot([annotation, other, nonAnnotation], { threadId: 'thread-1', tabId: 'tab', comments: [] })).toEqual([other, nonAnnotation])
  })

  test('direct isolation keeps files/tabs but removes other page comments', () => {
    const second = { ...annotation, id: 'annotation-2' }
    expect(resolveBrowserAnnotationSubmission({ attachments: [annotation, second, { ...annotation.tab, id: 'tab-attachment' }], directAttachment: annotation }).attachments).toEqual([annotation])
  })

  test('direct payload excludes every composer field and carries only the current annotation', () => {
    const payload = buildDirectBrowserAnnotationPayload({
      threadId: 'thread-1',
      annotation,
      screenshot: { id: 'screenshot', filename: 'annotation.png', mediaType: 'image/png', size: 10, threadPath: 'annotation.png' },
    })
    expect(payload).toEqual({
      threadId: 'thread-1',
      userMessage: '请处理这条网页批注。',
      browserAttachments: [annotation],
      messageAttachments: [{ id: 'screenshot', filename: 'annotation.png', mediaType: 'image/png', size: 10, threadPath: 'annotation.png' }],
    })
    expect('messageParts' in payload).toBe(false)
    expect('commentAttachments' in payload).toBe(false)
    expect('messageMetadata' in payload).toBe(false)
  })

  test('direct requests serialize and validate for retry', () => {
    const encoded = serializeBrowserAnnotationDirectRequest({ version: 1, threadId: 'thread-1', tabId: 'tab', annotation, attempts: 1, createdAt: new Date().toISOString() })
    expect(parseBrowserAnnotationDirectRequest(encoded)?.annotation.id).toBe(annotation.id)
    expect(parseBrowserAnnotationDirectRequest('{"version":2}')).toBeNull()
  })

  test('batch snapshots resume with the exact fallback only when composer text is empty', () => {
    expect(resolveBrowserAnnotationBatchText({ rawText: '', hasSnapshot: true, hasCodeComments: false, hasBrowserAttachments: true })).toBe('请处理这些网页批注。')
    expect(resolveBrowserAnnotationBatchText({ rawText: 'Keep this composer text', hasSnapshot: true, hasCodeComments: false, hasBrowserAttachments: true })).toBe('Keep this composer text')
  })
})
