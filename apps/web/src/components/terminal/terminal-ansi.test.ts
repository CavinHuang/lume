// terminal-ansi 单测:SGR 前景色/加粗解析、其余转义剥离、跨行拆分、同型合并。
import { describe, expect, test } from 'bun:test'
import { parseAnsiSegments, splitAnsiLines } from './terminal-ansi'

describe('parseAnsiSegments', () => {
  test('无转义序列的纯文本产出单 segment', () => {
    expect(parseAnsiSegments('plain output')).toEqual([
      { text: 'plain output', color: null, bold: false },
    ])
  })

  test('SGR 前景色与加粗切换着色区间', () => {
    const segments = parseAnsiSegments('\x1b[31mred\x1b[1mbold-red\x1b[0mreset')
    expect(segments).toEqual([
      { text: 'red', color: 'red', bold: false },
      { text: 'bold-red', color: 'red', bold: true },
      { text: 'reset', color: null, bold: false },
    ])
  })

  test('亮色 90-97 与默认前景 39', () => {
    const segments = parseAnsiSegments('\x1b[92mgreen-bright\x1b[39mdefault')
    expect(segments).toEqual([
      { text: 'green-bright', color: 'brightGreen', bold: false },
      { text: 'default', color: null, bold: false },
    ])
  })

  test('相邻同样式文本合并为单 segment', () => {
    const segments = parseAnsiSegments('\x1b[32ma\x1b[32mb\x1b[0mc')
    expect(segments).toEqual([
      { text: 'ab', color: 'green', bold: false },
      { text: 'c', color: null, bold: false },
    ])
  })

  test('非 SGR 的 CSI 序列（清屏/光标/背景色）被剥离', () => {
    const segments = parseAnsiSegments('a\x1b[2Jb\x1b[1;1Hc\x1b[41md\x1b[K')
    expect(segments.map((segment) => segment.text).join('')).toBe('abcd')
    expect(segments.every((segment) => segment.color === null)).toBe(true)
  })

  test('OSC 序列（BEL/ST 终止）与单字符转义被剥离', () => {
    const segments = parseAnsiSegments('\x1b]0;title\x07body\x1b]8;;http://x\x1b\\link')
    expect(segments.map((segment) => segment.text).join('')).toBe('bodylink')
    expect(parseAnsiSegments('x\x1bcy').map((segment) => segment.text).join('')).toBe('xy')
  })

  test('未终止的转义序列消费到末尾（不渲染参数字面量）', () => {
    const segments = parseAnsiSegments('text\x1b[31')
    expect(segments.map((segment) => segment.text).join('')).toBe('text')
  })
})

describe('splitAnsiLines', () => {
  test('按 \\n 拆行并剥离 \\r，空行保留占位', () => {
    const lines = splitAnsiLines([
      { text: 'one\r\ntwo', color: null, bold: false },
      { text: '\n', color: null, bold: false },
      { text: 'four', color: 'red', bold: false },
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual([{ text: 'one', color: null, bold: false }])
    expect(lines[1]).toEqual([{ text: 'two', color: null, bold: false }])
    expect(lines[2]).toEqual([{ text: 'four', color: 'red', bold: false }])
  })
})
