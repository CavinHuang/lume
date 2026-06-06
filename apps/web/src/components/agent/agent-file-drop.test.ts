import { describe, expect, test } from 'bun:test'
import {
  createPendingAttachmentsFromSourcePaths,
  isFileDragPayload,
  type DragDropPayload,
} from './agent-file-drop'

describe('agent file drop helpers', () => {
  test('detects Tauri enter/drop payloads with file paths', () => {
    expect(isFileDragPayload({ type: 'enter', paths: ['/tmp/a.md'] })).toBeTrue()
    expect(isFileDragPayload({ type: 'drop', paths: ['/tmp/a.md'] })).toBeTrue()
    expect(isFileDragPayload({ type: 'enter', paths: [] })).toBeFalse()
    expect(isFileDragPayload({ type: 'over' } as DragDropPayload)).toBeFalse()
    expect(isFileDragPayload({ type: 'leave' } as DragDropPayload)).toBeFalse()
  })

  test('creates pending attachments from desktop source paths', async () => {
    const attachments = await createPendingAttachmentsFromSourcePaths(['/tmp/brief.md'], {
      createId: () => 'att-1',
      statPaths: async (paths) => ({
        files: paths.map((path) => ({
          filename: 'brief.md',
          mediaType: 'text/markdown',
          size: 7,
          sourcePath: path,
        })),
      }),
    })

    expect(attachments).toEqual([{
      id: 'att-1',
      filename: 'brief.md',
      mediaType: 'text/markdown',
      size: 7,
      sourcePath: '/tmp/brief.md',
    }])
  })

  test('uses desktop image base64 data for pending image previews', async () => {
    const attachments = await createPendingAttachmentsFromSourcePaths(['/tmp/screen.png'], {
      createId: () => 'att-1',
      statPaths: async (paths) => ({
        files: paths.map((path) => ({
          filename: 'screen.png',
          mediaType: 'image/png',
          size: 7,
          sourcePath: path,
          data: 'abc123',
        })),
      }),
    })

    expect(attachments).toEqual([{
      id: 'att-1',
      filename: 'screen.png',
      mediaType: 'image/png',
      size: 7,
      sourcePath: '/tmp/screen.png',
      data: 'abc123',
      previewUrl: 'data:image/png;base64,abc123',
    }])
  })
})
