import { describe, expect, test } from 'bun:test'
import {
  createPendingAttachmentsFromFiles,
  extractClipboardFiles,
  handleAttachmentPaste,
} from './editor-attachment-paste'

describe('editor attachment paste helpers', () => {
  test('uses clipboard files before item fallbacks', () => {
    const directFile = new File(['direct'], 'direct.txt', { type: 'text/plain' })
    const fallbackFile = new File(['fallback'], 'fallback.txt', { type: 'text/plain' })

    expect(extractClipboardFiles({
      files: [directFile],
      items: [{ kind: 'file', getAsFile: () => fallbackFile }],
    } as unknown as DataTransfer)).toEqual([directFile])
  })

  test('falls back to file clipboard items', () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    expect(extractClipboardFiles({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => file },
      ],
    } as unknown as DataTransfer)).toEqual([file])
  })

  test('streams files into desktop staging without creating base64 payloads', async () => {
    const image = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' })
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const ids = ['image-id', 'text-id']

    const attachments = await createPendingAttachmentsFromFiles([image, text], {
      createId: () => ids.shift() ?? 'unexpected-id',
      now: 123,
      stageFile: async ({ id }) => ({
        stagedAttachmentId: `stage-${id}`,
        ...(id === 'image-id' ? { previewUrl: 'file:///staging/image.png' } : {}),
      }),
    })

    expect(attachments).toEqual([
      {
        id: 'image-id',
        filename: 'pasted-image-123-1.png',
        mediaType: 'image/png',
        size: 3,
        stagedAttachmentId: 'stage-image-id',
        previewUrl: 'file:///staging/image.png',
      },
      {
        id: 'text-id',
        filename: 'notes.txt',
        mediaType: text.type,
        size: 5,
        stagedAttachmentId: 'stage-text-id',
      },
    ])
  })

  test('consumes file paste events and reports converted attachments', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    let prevented = false
    let settled = false
    let resolveSettled: () => void = () => undefined
    const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve })
    const attachments = new Promise<Awaited<ReturnType<typeof createPendingAttachmentsFromFiles>>>((resolve) => {
      const consumed = handleAttachmentPaste({
        clipboardData: { files: [file], items: [] },
        preventDefault: () => { prevented = true },
      } as unknown as ClipboardEvent, {
        stageFile: async ({ id }) => ({ stagedAttachmentId: `stage-${id}` }),
        onAttachments: resolve,
        onError: () => resolve([]),
        onSettled: () => {
          settled = true
          resolveSettled()
        },
      })
      expect(consumed).toBeTrue()
    })

    expect((await attachments)[0]).toEqual(expect.objectContaining({
      filename: 'notes.txt',
      stagedAttachmentId: expect.any(String),
    }))
    await settledPromise
    expect(prevented).toBeTrue()
    expect(settled).toBeTrue()
  })
})
