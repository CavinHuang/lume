import { describe, expect, test } from 'bun:test'
import { REDACT_KEY_PARTS, CONTENT_PREVIEW_KEYS, LOG_PREVIEW_MAX_CHARS, QUIET_RPC_METHODS, clipLogPreview, summarizeValue, extractCorrelationIds, isLumeLogSource, normalizeHostLevel, parseLumeLogLine, normalizeLogValue } from './index'

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
  test('内容键的对象值递归分类，嵌套凭据不泄漏', () => {
    const out = summarizeValue({
      prompt: { apiKey: 'sk-secret', note: 'hello', nested: { password: 'p' } },
    }) as { prompt: { apiKey: string; note: string; nested: unknown } }
    // 第一层字段照常分类；更深层被深度帽截断（凭据同样不可达）。
    expect(out.prompt.apiKey).toBe('[redacted]')
    expect(out.prompt.note).toBe('hello')
    expect(out.prompt.nested).toBe('[MaxDepth]')
    expect(JSON.stringify(out)).not.toContain('sk-secret')
    expect(JSON.stringify(out)).not.toContain('"p"')
  })
  test('内容键的数组值逐项分类而非 JSON 原样序列化', () => {
    const out = summarizeValue({ body: [{ token: 't' }, 'plain'] }) as { body: { length: number; items: unknown[] } }
    expect(out.body.length).toBe(2)
    // 数组元素位于深度 2 → 骨架化，凭据不可达；标量项仍可见。
    expect(out.body.items[0]).toBe('[MaxDepth]')
    expect(out.body.items[1]).toBe('plain')
    expect(JSON.stringify(out)).not.toContain('"t"')
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
  test('contents 键纳入内容预览名单（评审 Minor）', () => {
    expect(CONTENT_PREVIEW_KEYS.has('contents')).toBe(true)
  })
})

describe('extractCorrelationIds', () => {
  test('顶层与一层嵌套的已知 ID 提升为顶层字段', () => {
    const out = extractCorrelationIds({ threadId: 'thread-abc', command: 'x', params: { sessionId: 'sess-1', runId: 'run-9' } })
    expect(out).toEqual({ threadId: 'thread-abc', runId: 'run-9' })
    // sessionId 归一化为 threadId，但显式 threadId 优先不被覆盖
  })
  test('非法形状（过长/空白/非字符串）不采纳', () => {
    expect(extractCorrelationIds({ threadId: 'has space' })).toEqual({})
    expect(extractCorrelationIds({ threadId: 42 })).toEqual({})
    expect(extractCorrelationIds({ threadId: `${'a'.repeat(200)}` })).toEqual({})
  })
  test('深度超过一层不再下钻；数组与非对象直接返回空', () => {
    expect(extractCorrelationIds({ a: { b: { threadId: 'deep-1' } } })).toEqual({})
    expect(extractCorrelationIds([1, 2])).toEqual({})
    expect(extractCorrelationIds('text')).toEqual({})
  })
})

describe('跨进程工具（第二波收敛）', () => {
  test('isLumeLogSource 派生自 LUME_LOG_SOURCES', () => {
    expect(isLumeLogSource('main')).toBe(true)
    expect(isLumeLogSource('node-repl')).toBe(true)
    expect(isLumeLogSource('nope')).toBe(false)
    expect(isLumeLogSource(42)).toBe(false)
  })
  test('normalizeHostLevel：fatal→error、白名单直通、未知回落 info', () => {
    expect(normalizeHostLevel('fatal')).toBe('error')
    expect(normalizeHostLevel('warn')).toBe('warn')
    expect(normalizeHostLevel('trace')).toBe('trace')
    expect(normalizeHostLevel('bogus')).toBe('info')
    expect(normalizeHostLevel(undefined)).toBe('info')
  })
  test('parseLumeLogLine：合法/坏 JSON/null/数组/非前缀', () => {
    expect(parseLumeLogLine('LUMELOG {"level":"warn","event":"e"}')).toEqual({ level: 'warn', event: 'e' })
    expect(parseLumeLogLine('LUMELOG not-json')).toBeNull()
    expect(parseLumeLogLine('LUMELOG null')).toBeNull()
    expect(parseLumeLogLine('LUMELOG [1]')).toBeNull()
    expect(parseLumeLogLine('plain text')).toBeNull()
  })
  test('normalizeLogValue：凭据遮蔽、TypedArray 骨架、循环引用、深度帽', () => {
    const out = normalizeLogValue({ apiKey: 'sk-x', chunk: new Uint8Array(8), body: 'ok' }) as Record<string, unknown>
    expect(out.apiKey).toBe('[redacted]')
    expect(out.chunk).toEqual({ type: 'Uint8Array', byteLength: 8 })
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(JSON.stringify(normalizeLogValue(cyc))).toContain('[Circular]')
  })
})
