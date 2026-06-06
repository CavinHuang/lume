import { describe, expect, test } from 'bun:test'
import { extractPngBase64FromDataUrl } from './reading-card-export'

describe('reading card export', () => {
  test('extracts png base64 from a modern-screenshot data url', () => {
    expect(extractPngBase64FromDataUrl('data:image/png;base64,abc123')).toBe('abc123')
  })

  test('rejects non-png screenshot output', () => {
    expect(() => extractPngBase64FromDataUrl('data:image/jpeg;base64,abc123')).toThrow('PNG 数据生成失败')
  })
})
