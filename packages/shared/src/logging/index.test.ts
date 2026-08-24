import { describe, expect, test } from 'bun:test'
import { REDACT_KEY_PARTS, CONTENT_PREVIEW_KEYS, LOG_PREVIEW_MAX_CHARS, QUIET_RPC_METHODS, clipLogPreview, summarizeValue } from './index'

describe('clipLogPreview', () => {
  test('短字符串原样返回', () => {
    expect(clipLogPreview('hello')).toBe('hello')
  })
  test('超长字符串截断并附原长标注', () => {
    const text = 'a'.repeat(LOG_PREVIEW_MAX_CHARS + 10)
    const clipped = clipLogPreview(text)
    expect(clipped.startsWith('a'.repeat(LOG_PREVIEW_MAX_CHARS))).toBe(true)
    expect(clipped.endsWith('…(+10)')).toBe(true)
    expect(clipped.length).toBeLessThanOrEqual(LOG_PREVIEW_MAX_CHARS + 12)
  })
})

describe('summarizeValue', () => {
  test('凭据键完全 redact（含子串匹配）', () => {
    const out = summarizeValue({ apiKey: 'sk-secret', Authorization: 'Bearer x' }) as Record<string, unknown>
    expect(out.apiKey).toBe('[redacted]')
    expect(out.Authorization).toBe('[redacted]')
  })
  test('内容键输出截断预览而非 [redacted]', () => {
    const long = 'b'.repeat(500)
    const out = summarizeValue({ prompt: long }) as Record<string, unknown>
    expect(typeof out.prompt).toBe('string')
    expect((out.prompt as string).length).toBeLessThan(long.length)
    expect(out.prompt).not.toBe('[redacted]')
  })
  test('普通标量保留、嵌套对象限深、数组给骨架', () => {
    const out = summarizeValue({ id: 7, ok: true, nested: { deep: { deeper: 1 } }, list: [1, 2, 3] }) as Record<string, unknown>
    expect(out.id).toBe(7)
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out.nested)).toContain('[MaxDepth]')
    expect((out.list as { length: number }).length).toBe(3)
  })
  test('对象键数量截断到 30', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(summarizeValue(big) as Record<string, unknown>).length).toBe(30)
  })
  test('原始类型直接摘要', () => {
    expect(summarizeValue('plain')).toBe('plain')
    expect(summarizeValue(undefined)).toBeUndefined()
    expect(summarizeValue(null)).toBeNull()
  })
  test('Error 对象摘要为 name/message/stack', () => {
    const err = new Error('boom')
    const out = summarizeValue(err) as { name: string; message: string; stack?: string }
    expect(out.name).toBe('Error')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
  })
  test('循环引用安全终止', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(JSON.stringify(summarizeValue(cyc))).toContain('[MaxDepth]')
  })
  test('TypedArray 输出骨架摘要而非键物化', () => {
    expect(summarizeValue(new Uint8Array(256 * 1024))).toEqual({ type: 'Uint8Array', byteLength: 262144 })
  })
  test('Buffer 与普通对象混合回归', () => {
    const out = summarizeValue({ chunk: Buffer.from('hello'), name: 'a' }) as Record<string, unknown>
    expect(out.chunk).toEqual({ type: 'Buffer', byteLength: 5 })
    expect(out.name).toBe('a')
  })
})

describe('常量', () => {
  test('REDACT_KEY_PARTS 含 token/password/apikey/authorization', () => {
    for (const part of ['token', 'password', 'apikey', 'authorization']) {
      expect(REDACT_KEY_PARTS).toContain(part)
    }
  })
  test('CONTENT_PREVIEW_KEYS 含 body/prompt/content', () => {
    for (const key of ['body', 'prompt', 'content']) {
      expect(CONTENT_PREVIEW_KEYS.has(key)).toBe(true)
    }
  })
  test('QUIET_RPC_METHODS 为双端并集（含 channel:oauth-status）', () => {
    expect(QUIET_RPC_METHODS.has('channel:oauth-status')).toBe(true)
    expect(QUIET_RPC_METHODS.has('healthcheck')).toBe(true)
  })
})
