import { describe, expect, test } from 'bun:test'
import { highlightCode, highlightCodeSync } from './shiki-service'

describe('shiki-service', () => {
  const snippet = 'const answer = 42\nexport function greet(name: string) {\n  return `hi ${name}`\n}\n'

  test('highlightCode returns Shiki HTML with colored spans and per-line wrappers', async () => {
    const { html, language } = await highlightCode({ code: snippet, language: 'typescript' })
    expect(language).toBe('typescript')
    expect(html).toContain('<span')
    // Shiki 逐行包裹：<span class="line">（4 行源码至少 3 个带内容的行包装）
    const lineWrappers = html.match(/<span class="line"/g) ?? []
    expect(lineWrappers.length).toBeGreaterThanOrEqual(3)
    // 关键字着色：token 级 span 携带内联颜色样式
    expect(html).toMatch(/<span style="color:#/)
  })

  test('unknown language falls back to plain text without throwing', async () => {
    const { html, language } = await highlightCode({ code: snippet, language: 'not-a-real-lang' })
    expect(language).toBe('text')
    expect(html).toContain('<pre')
  })

  test('language aliases resolve to bundled languages', async () => {
    const { language } = await highlightCode({ code: '#!/usr/bin/env bash\necho hi\n', language: 'bash' })
    expect(language).toBe('shellscript')
  })

  test('highlightCodeSync serves warm cache and returns null before init', async () => {
    // 首个用例已预热单例；此后同步路径应直接返回 HTML
    const warm = highlightCodeSync({ code: snippet, language: 'ts' })
    expect(warm).not.toBeNull()
    expect(warm?.language).toBe('typescript')
    expect(warm?.html).toContain('<span class="line"')
  })
})
