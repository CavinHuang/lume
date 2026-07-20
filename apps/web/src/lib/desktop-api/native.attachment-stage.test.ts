import { afterEach, describe, expect, test } from 'bun:test'
import { stageAttachmentFile } from './native'

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('stageAttachmentFile', () => {
  test('按 256 KiB 分块上传而不构造整文件 base64', async () => {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          invoke: async (command: string, payload: Record<string, unknown>) => {
            calls.push({ command, payload })
            if (command === 'attachment_stage_begin') return { stagedAttachmentId: 'stage-1' }
            if (command === 'attachment_stage_finish') return { stagedAttachmentId: 'stage-1', previewUrl: 'file:///stage.png' }
            return { receivedBytes: 0 }
          },
        },
      },
    })

    const file = new File([new Uint8Array(600 * 1024)], 'image.png', { type: 'image/png' })
    const result = await stageAttachmentFile({ id: 'attachment-1', file, filename: file.name, mediaType: file.type })
    const chunks = calls.filter((call) => call.command === 'attachment_stage_append')

    expect(result).toEqual({ stagedAttachmentId: 'stage-1', previewUrl: 'file:///stage.png' })
    expect(chunks.map((call) => call.payload.offset)).toEqual([0, 256 * 1024, 512 * 1024])
    expect(chunks.every((call) => (call.payload.chunk as Uint8Array).byteLength <= 256 * 1024)).toBeTrue()
    expect(calls.some((call) => 'data' in call.payload || 'base64Content' in call.payload)).toBeFalse()
  })

  test('分块失败时撤销暂存文件', async () => {
    const commands: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          invoke: async (command: string) => {
            commands.push(command)
            if (command === 'attachment_stage_begin') return { stagedAttachmentId: 'stage-1' }
            if (command === 'attachment_stage_append') throw new Error('disk full')
            return null
          },
        },
      },
    })

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await expect(stageAttachmentFile({ id: 'attachment-1', file, filename: file.name, mediaType: file.type })).rejects.toThrow('disk full')
    expect(commands).toContain('attachment_stage_abort')
  })
})
