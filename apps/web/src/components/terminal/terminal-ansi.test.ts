// terminal-ansi 单测:SGR 全属性解析、CR 覆写、EL/OSC 剥离、跨行拆分、同型合并。
import { describe, expect, test } from 'bun:test'
import { parseAnsiSegments, splitAnsiLines, defaultStyle, type AnsiSegment } from './terminal-ansi'

const seg = (text: string, overrides?: Partial<ReturnType<typeof defaultStyle>>): AnsiSegment => ({
  text,
  style: { ...defaultStyle(), ...overrides },
})

describe('parseAnsiSegments', () => {
  test('无转义序列的纯文本产出单 segment', () => {
    expect(parseAnsiSegments('plain output')).toEqual([seg('plain output')])
  })

  test('SGR 前景色与加粗切换着色区间', () => {
    const segments = parseAnsiSegments('\x1b[31mred\x1b[1mbold-red\x1b[0mreset')
    expect(segments).toEqual([
      seg('red', { fg: 'red' }),
      seg('bold-red', { fg: 'red', bold: true }),
      seg('reset'),
    ])
  })

  test('亮色 90-97 与默认前景 39', () => {
    const segments = parseAnsiSegments('\x1b[92mgreen-bright\x1b[39mdefault')
    expect(segments).toEqual([
      seg('green-bright', { fg: 'bright-green' }),
      seg('default'),
    ])
  })

  test('相邻同样式文本合并为单 segment', () => {
    const segments = parseAnsiSegments('\x1b[32ma\x1b[32mb\x1b[0mc')
    expect(segments).toEqual([
      seg('ab', { fg: 'green' }),
      seg('c'),
    ])
  })

  test('背景色 SGR 41/49', () => {
    const segments = parseAnsiSegments('\x1b[41;37mInv\x1b[49mnorm')
    /* SGR 49 只清背景,前景 white 保持(与真实终端行为一致) */
    expect(segments).toEqual([
      seg('Inv', { fg: 'white', bg: 'bg-red' }),
      seg('norm', { fg: 'white' }),
    ])
  })

  test('下划线/斜体/删除线 SGR', () => {
    const segments = parseAnsiSegments('\x1b[4munder\x1b[24m ok \x1b[3mitalic\x1b[23m end \x1b[9mstrike\x1b[29m.')
    expect(segments).toEqual([
      seg('under', { underline: true }),
      seg(' ok '),
      seg('italic', { italic: true }),
      seg(' end '),
      seg('strike', { strikethrough: true }),
      seg('.'),
    ])
  })

  test('256 色 SGR 38;5;N 产出 CSS rgb 值', () => {
    const segments = parseAnsiSegments('\x1b[38;5;208morange\x1b[0m')
    expect(segments).toEqual([seg('orange', { fg: 'rgb(255,135,0)' })])
  })

  test('真彩 SGR 38;2;R;G;B', () => {
    const segments = parseAnsiSegments('\x1b[38;2;255;128;0mtruecolor\x1b[0m')
    expect(segments).toEqual([seg('truecolor', { fg: 'rgb(255,128,0)' })])
  })

  test('dim SGR 2', () => {
    const segments = parseAnsiSegments('\x1b[2mdim\x1b[22mnorm')
    expect(segments).toEqual([seg('dim', { dim: true }), seg('norm')])
  })

  test('非 SGR 的 CSI 序列(清屏/光标/背景色)被剥离', () => {
    const segments = parseAnsiSegments('a\x1b[2Jb\x1b[1;1Hc\x1b[41md\x1b[K')
    expect(segments.map(s => s.text).join('')).toBe('abcd')
  })

  test('OSC 序列(BEL/ST 终止)与单字符转义被剥离', () => {
    const segments = parseAnsiSegments('\x1b]0;title\x07body\x1b]8;;http://x\x1b\\link')
    expect(segments.map(s => s.text).join('')).toBe('bodylink')
    expect(parseAnsiSegments('x\x1bcy').map(s => s.text).join('')).toBe('xy')
  })

  test('未终止的转义序列消费到末尾(不渲染参数字面量)', () => {
    const segments = parseAnsiSegments('text\x1b[31')
    expect(segments.map(s => s.text).join('')).toBe('text')
  })
})

describe('splitAnsiLines', () => {
  test('按 \\n 拆行,\\r 覆写当前行,空行保留占位', () => {
    const lines = splitAnsiLines([
      seg('one\r\ntwo'),
      seg('\n'),
      seg('four', { fg: 'red' }),
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual([seg('one')])
    expect(lines[1]).toEqual([seg('two')])
    expect(lines[2]).toEqual([seg('four', { fg: 'red' })])
  })

  test('\\r 行覆写: 后段覆盖前段同等宽度', () => {
    const lines = splitAnsiLines([seg('loading 50%\rloading 100%')])
    expect(lines).toEqual([[seg('loading 100%')]])
  })
})
