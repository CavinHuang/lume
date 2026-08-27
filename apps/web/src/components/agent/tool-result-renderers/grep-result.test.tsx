import { describe, expect, test } from 'bun:test'
import { formatGrepResult } from './grep-result'

describe('formatGrepResult', () => {
  test('renders structured grep matches as readable lines', () => {
    expect(formatGrepResult({
      pattern: 'Wiki',
      output_mode: 'content',
      matches: ['src/wiki.ts:12:const Wiki = true', 'src/view.tsx:8:WikiView'],
    })).toBe('src/wiki.ts:12:const Wiki = true\nsrc/view.tsx:8:WikiView')
  })

  test('does not stringify structured results as object identity', () => {
    expect(formatGrepResult({ matches: [{ path: 'src/wiki.ts', line_number: 12, line: 'Wiki' }] })).toContain('"path": "src/wiki.ts"')
    expect(formatGrepResult({ matches: [{ path: 'src/wiki.ts' }] })).not.toBe('[object Object]')
  })

  // #565 后 Grep 正文是纯文本流，string 直通分支是主渲染路径
  test('passes plain-text output through verbatim', () => {
    const text = 'src/a.ts:1:needle\nsrc/b.ts:2:needle'
    expect(formatGrepResult(text)).toBe(text)
  })
})
