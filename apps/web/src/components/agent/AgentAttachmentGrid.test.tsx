import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentAttachmentGrid, attachmentDataUrl, isImageAttachment } from './AgentAttachmentGrid'

describe('AgentAttachmentGrid', () => {
  test('classifies image attachments by media type and common image extension', () => {
    expect(isImageAttachment({ filename: 'screen.png', mediaType: 'image/png' })).toBe(true)
    expect(isImageAttachment({ filename: 'photo.JPG', mediaType: 'application/octet-stream' })).toBe(true)
    expect(isImageAttachment({ filename: 'brief.md', mediaType: 'text/markdown' })).toBe(false)
  })

  test('builds image preview data urls from base64 file data', () => {
    expect(attachmentDataUrl('image/png', 'abc123')).toBe('data:image/png;base64,abc123')
    expect(attachmentDataUrl('image/png')).toBeUndefined()
  })

  test('renders compact image thumbnails and file cards in a wrapping row', () => {
    const markup = renderToStaticMarkup(
      <AgentAttachmentGrid
        attachments={[
          { id: 'att-1', filename: 'screen.png', mediaType: 'image/png', size: 1024, previewUrl: 'asset://screen.png' },
          { id: 'att-2', filename: 'brief.xlsx', mediaType: 'application/vnd.ms-excel', size: 2048 },
          { id: 'att-3', filename: 'notes.md', mediaType: 'text/markdown', size: 4096 },
          { id: 'att-4', filename: 'photo.webp', mediaType: 'image/webp', size: 8192, previewUrl: 'asset://photo.webp' },
        ]}
      />,
    )

    expect(markup).toContain('data-agent-attachment-grid="true"')
    expect(markup).toContain('flex')
    expect(markup).toContain('flex-wrap')
    expect(markup).toContain('w-[108px]')
    expect(markup).toContain('h-[108px]')
    expect(markup).toContain('w-[250px]')
    expect(markup).toContain('data-agent-attachment-kind="image"')
    expect(markup).toContain('data-agent-attachment-kind="file"')
    expect(markup).toContain('brief.xlsx')
    expect(markup).toContain('XLSX')
  })
})
