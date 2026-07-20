import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttachmentStageRegistry,
  attachmentStageIdFromPreviewUrl,
  attachmentStagePreviewUrl,
} from '../src/attachment-staging.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRegistry() {
  const root = mkdtempSync(join(tmpdir(), 'lume-attachment-stage-test-'))
  roots.push(root)
  return new AttachmentStageRegistry({ rootDir: root, createId: () => 'stage-1' })
}

describe('AttachmentStageRegistry', () => {
  test('按 offset 接收分块并只在完整后开放读取', () => {
    const registry = createRegistry()
    const stage = registry.begin({ ownerWebContentsId: 7, attachmentId: 'a-1', filename: 'note.txt', mediaType: 'text/plain', size: 5 })
    registry.append({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, offset: 0, chunk: new Uint8Array([1, 2]) })
    expect(() => registry.finish({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId })).toThrow('不完整')
    registry.append({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, offset: 2, chunk: new Uint8Array([3, 4, 5]) })
    registry.finish({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId })
    expect(registry.resolve({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, attachmentId: 'a-1', clientSubmissionId: 's-1' })).toBe(stage.path)
    expect(existsSync(stage.path)).toBeTrue()
  })

  test('拒绝跨窗口和乱序分块', () => {
    const registry = createRegistry()
    const stage = registry.begin({ ownerWebContentsId: 7, attachmentId: 'a-1', filename: 'note.txt', mediaType: 'text/plain', size: 1 })
    expect(() => registry.append({ ownerWebContentsId: 8, stagedAttachmentId: stage.stagedAttachmentId, offset: 0, chunk: new Uint8Array([1]) })).toThrow('不存在或已过期')
    expect(() => registry.append({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, offset: 1, chunk: new Uint8Array([1]) })).toThrow('顺序无效')
    registry.append({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, offset: 0, chunk: new Uint8Array([1]) })
    registry.finish({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId })
    expect(registry.resolve({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, attachmentId: 'a-1' })).toBe(stage.path)
  })

  test('路径 grant 在源文件变化后失效', () => {
    const registry = createRegistry()
    const source = join(roots[0], 'source.txt')
    writeFileSync(source, 'one')
    const stage = registry.grantPath({ ownerWebContentsId: 7, attachmentId: 'a-1', sourcePath: source, filename: 'source.txt', mediaType: 'text/plain' })
    writeFileSync(source, 'changed')
    expect(() => registry.resolve({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, attachmentId: 'a-1' })).toThrow('发生变化')
  })

  test('完成后的图片通过归属受控的 lume-file 地址预览', () => {
    const registry = createRegistry()
    const stage = registry.begin({ ownerWebContentsId: 7, attachmentId: 'a-1', filename: '截图 1.png', mediaType: 'image/png', size: 1 })
    expect(registry.owns(stage.stagedAttachmentId, 7)).toBeFalse()
    registry.append({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId, offset: 0, chunk: new Uint8Array([1]) })
    const completed = registry.finish({ ownerWebContentsId: 7, stagedAttachmentId: stage.stagedAttachmentId })
    const previewUrl = attachmentStagePreviewUrl(completed)

    expect(previewUrl).toBe('lume-file://attachment/stage-1/%E6%88%AA%E5%9B%BE%201.png')
    expect(attachmentStageIdFromPreviewUrl(previewUrl)).toBe(stage.stagedAttachmentId)
    expect(attachmentStageIdFromPreviewUrl('lume-file://preview/token/image.png')).toBeNull()
    expect(registry.owns(stage.stagedAttachmentId, 7)).toBeTrue()
    expect(registry.owns(stage.stagedAttachmentId, 8)).toBeFalse()
    expect(registry.preview(stage.stagedAttachmentId)?.path).toBe(stage.path)
  })
})
