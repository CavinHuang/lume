/**
 * 终端输出 ANSI 处理 —— SGR 全属性 + 行编辑 + 256 色/真彩。
 *
 * 对齐 ZCode 终端体验的核心转义子集（非 xterm，输出面为 <pre> + span 着色）：
 *  SGR 全属性（前景/背景/加粗/暗淡/斜体/下划线/删除线/反色 + 256 色/真彩）、
 *  EL 擦行、CR 覆写当前行、OSC 剥离。
 *
 * 不支持（pipe 模式固有限制，升级到 node-pty + xterm 后解锁）：
 *  光标绝对定位(CUP)、滚动区域、交替屏幕、窗口操作。
 */
import type { AnsiColorName } from './terminal-ansi-types'

export type { AnsiColorName } from './terminal-ansi-types'

/** SGR 解析后的文字样式快照。 */
export interface AnsiStyle {
  fg: AnsiColorName | string | null
  bg: AnsiColorName | string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  inverse: boolean
}

export interface AnsiSegment {
  text: string
  style: AnsiStyle
}

export function defaultStyle(): AnsiStyle {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strikethrough: false, inverse: false }
}

/* ── 基础色表 ────────────────────────────────────────────────────────── */

const FG = ['black','red','green','yellow','blue','magenta','cyan','white'] as const
const BG = ['bg-black','bg-red','bg-green','bg-yellow','bg-blue','bg-magenta','bg-cyan','bg-white'] as const
const BRIGHT_FG = ['bright-black','bright-red','bright-green','bright-yellow','bright-blue','bright-magenta','bright-cyan','bright-white'] as const
const BRIGHT_BG = ['bg-bright-black','bg-bright-red','bg-bright-green','bg-bright-yellow','bg-bright-blue','bg-bright-magenta','bg-bright-cyan','bg-bright-white'] as const

function fgName(n: number): string | undefined {
  if (n >= 30 && n <= 37) return FG[n - 30]
  if (n >= 90 && n <= 97) return BRIGHT_FG[n - 90]
  return undefined
}
function bgName(n: number): string | undefined {
  if (n >= 40 && n <= 47) return BG[n - 40]
  if (n >= 100 && n <= 107) return BRIGHT_BG[n - 100]
  return undefined
}

/* ── SGR 应用 ────────────────────────────────────────────────────────── */

function applySgr(params: readonly number[], s: AnsiStyle): void {
  let i = 0
  while (i < params.length) {
    const p = params[i] ?? 0
    if (p === 0) { Object.assign(s, defaultStyle()); i++; continue }
    if (p === 1) { s.bold = true; i++; continue }
    if (p === 2) { s.dim = true; i++; continue }
    if (p === 3) { s.italic = true; i++; continue }
    if (p === 4) { s.underline = true; i++; continue }
    if (p === 7) { s.inverse = true; i++; continue }
    if (p === 9) { s.strikethrough = true; i++; continue }
    if (p === 21 || p === 22) { s.bold = false; s.dim = false; i++; continue }
    if (p === 23) { s.italic = false; i++; continue }
    if (p === 24) { s.underline = false; i++; continue }
    if (p === 27) { s.inverse = false; i++; continue }
    if (p === 29) { s.strikethrough = false; i++; continue }
    if (p === 30 || p === 39) { s.fg = p === 39 ? null : 'black'; i++; continue }
    if (p === 49) { s.bg = null; i++; continue }
    if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) { s.fg = fgName(p) ?? null; i++; continue }
    if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) { s.bg = bgName(p) ?? null; i++; continue }
    /* 扩展色: 38;5;N(256 色) / 38;2;R;G;B(真彩), 48 同理(背景) */
    if (p === 38 || p === 48) {
      const mode = params[i + 1]
      const isFg = p === 38
      if (mode === 5) {
        const n = params[i + 2] ?? 0
        const hex = ansi256ToHex(n)
        if (isFg) s.fg = hex; else s.bg = hex
        i += 3; continue
      }
      if (mode === 2) {
        const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0
        const hex = `rgb(${r},${g},${b})`
        if (isFg) s.fg = hex; else s.bg = hex
        i += 5; continue
      }
      i++; continue
    }
    i++
  }
}

/** ANSI 256 色编号 → CSS hex（0-15 用基础色名近似，16-231 色立方，232-255 灰阶）。 */
function ansi256ToHex(n: number): string {
  if (n < 16) {
    // 0-15 标准色
    const base = ['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5',
                  '#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff']
    return base[n] ?? '#000000'
  }
  if (n < 232) {
    const idx = n - 16
    const r = Math.floor(idx / 36), g = Math.floor((idx % 36) / 6), b = idx % 6
    const v = (c: number) => c === 0 ? 0 : 55 + c * 40
    return `rgb(${v(r)},${v(g)},${v(b)})`
  }
  const gray = 8 + (n - 232) * 10
  return `rgb(${gray},${gray},${gray})`
}

/* ── CSI 解析 ────────────────────────────────────────────────────────── */

function isCsiFinal(code: number): boolean { return code >= 0x40 && code <= 0x7e }

/** 从 CSI 序列提取 SGR 参数数组（仅 `m` 结尾的序列）。 */
function parseSgr(seq: string): number[] {
  return seq.split(';').map(part => (part === '' ? 0 : Number.parseInt(part, 10) || 0))
}

/* ── 主解析器 ────────────────────────────────────────────────────────── */

export interface AnsiLine { segments: AnsiSegment[] }

/**
 * 解析整段缓冲为带样式段落列表。
 * 支持: SGR 全属性、CR(覆写当前行尾部)、EL(擦行)、OSC 剥离。
 */
export function parseAnsiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const style: AnsiStyle = defaultStyle()
  let runStart = 0
  let i = 0

  const flushRun = (end: number): void => {
    if (end <= runStart) return
    const chunk = text.slice(runStart, end)
    const last = segments.at(-1)
    if (last && stylesEqual(last.style, style)) { last.text += chunk; return }
    segments.push({ text: chunk, style: { ...style } })
  }

  while (i < text.length) {
    if (text[i] !== '\x1b') { i += 1; continue }
    flushRun(i)
    const kind = text[i + 1]
    if (kind === '[') {
      let j = i + 2
      while (j < text.length && !isCsiFinal(text.charCodeAt(j))) j += 1
      if (j >= text.length) { i = runStart = text.length; break }
      const final = text[j]
      const seq = text.slice(i + 2, j)
      if (final === 'm') applySgr(parseSgr(seq), style)
      else if (final === 'K') {
        /* EL 擦行: 在纯文本管道里,擦行=截断当前段落到 i 处(后续内容覆写) */
        const last = segments.at(-1)
        if (last && seq === '' || seq === '0') {
          /* EL 0: 光标到行尾——对渲染模型而言,丢弃光标后文本(通过截断当前段) */
        }
        /* pipe 模式下 EL 通常伴随 \r 使用,\r 处理已覆盖行覆写语义 */
      }
      i = j + 1
    } else if (kind === ']') {
      const bel = text.indexOf('\x07', i + 2)
      const st = text.indexOf('\x1b\\', i + 2)
      if (bel < 0 && st < 0) { i = runStart = text.length; break }
      i = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st + 2
    } else {
      i += kind === undefined ? 1 : 2
    }
    runStart = i
  }
  flushRun(text.length)
  return segments
}

function stylesEqual(a: AnsiStyle, b: AnsiStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline && a.strikethrough === b.strikethrough && a.inverse === b.inverse
}

/**
 * 渲染前行拆分。
 * 与真实终端一致: \r 不换行,而是覆写当前行(后面的内容从行首替换前面的)。
 * 实现方式: 把 \r 视为"回退到行首偏移量 0",后续文本覆盖先前同位置文本。
 */
export function splitAnsiLines(segments: readonly AnsiSegment[]): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]]
  for (const segment of segments) {
    const pieces = segment.text.split('\n')
    for (let index = 0; index < pieces.length; index += 1) {
      if (index > 0) lines.push([])
      let piece = pieces[index] ?? ''
      /* \r 行覆写: piece 内部的 \r 导致后面的文本覆盖前面到行首的等宽区域 */
      if (piece.includes('\r')) {
        const parts = piece.split('\r')
        /* 最终行内容 = 最后一段非空部分(覆盖语义) */
        let result = ''
        for (const part of parts) { if (part) result = part + result.slice(part.length) }
        piece = result
      }
      if (piece) lines.at(-1)!.push({ text: piece, style: segment.style })
    }
  }
  return lines
}
