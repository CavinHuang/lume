/**
 * 终端输出的极简 ANSI 处理 —— SGR 前景色/加粗解析 + 其余转义序列剥离。
 *
 * MVP 范围（非 xterm，输出面为 <pre> + span 着色）：
 *  - SGR 0（复位）/ 1（加粗）/ 2,22（去加粗）/ 39（默认前景）/ 30-37 / 90-97；
 *  - 其余 CSI 序列（光标移动/清屏/背景色等）与 OSC 序列（标题/超链接）原样剥离；
 *  - 相同样式的相邻文本合并为一个 segment，控制渲染 span 数量。
 */
import type { AnsiColorName } from './terminal-ansi-types'

export type { AnsiColorName } from './terminal-ansi-types'

export interface AnsiSegment {
  text: string
  color: AnsiColorName
  bold: boolean
}

/** SGR 参数 → 颜色名（背景色 40-47/100-107 暂不支持，忽略）。 */
function sgrParamToColor(param: number): AnsiColorName | undefined {
  if (param >= 30 && param <= 37) {
    return (['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const)[param - 30]
  }
  if (param >= 90 && param <= 97) {
    return ([ 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const)[param - 90]
  }
  return undefined
}

function applySgr(params: readonly number[], state: { color: AnsiColorName; bold: boolean }): void {
  for (const param of params) {
    if (param === 0) {
      state.color = null
      state.bold = false
      continue
    }
    if (param === 1) {
      state.bold = true
      continue
    }
    if (param === 2 || param === 22) {
      state.bold = false
      continue
    }
    if (param === 39) {
      state.color = null
      continue
    }
    const color = sgrParamToColor(param)
    if (color) state.color = color
  }
}

/** 解析整段缓冲（含跨 chunk 残留转义序列时按字面丢弃，不做跨帧状态机）。 */
export function parseAnsiSegments(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const state = { color: null as AnsiColorName, bold: false }
  let runStart = 0
  let i = 0

  const flushRun = (end: number): void => {
    if (end <= runStart) return
    const chunk = text.slice(runStart, end)
    const last = segments.at(-1)
    if (last && last.color === state.color && last.bold === state.bold) {
      last.text += chunk
    } else {
      segments.push({ text: chunk, color: state.color, bold: state.bold })
    }
  }

  while (i < text.length) {
    if (text[i] !== '\x1b') {
      i += 1
      continue
    }
    flushRun(i)
    const kind = text[i + 1]
    if (kind === '[') {
      // CSI：参数字节 0x30-0x3F，中间字节 0x20-0x2F，终止字节 0x40-0x7E。
      let j = i + 2
      while (j < text.length && !isCsiFinal(text.charCodeAt(j))) j += 1
      if (j >= text.length) {
        // 未终止序列：消费到末尾，避免参数被当字面文本渲染（runStart 同步推进，
        // 否则结尾 flushRun 会把整段缓冲重复外发一次）。
        i = runStart = text.length
        break
      }
      if (text[j] === 'm') {
        applySgr(
          text.slice(i + 2, j).split(';').map((part) => (part === '' ? 0 : Number.parseInt(part, 10) || 0)),
          state,
        )
      }
      i = j + 1
    } else if (kind === ']') {
      // OSC：以 BEL 或 ST(ESC \) 终止。
      const bel = text.indexOf('\x07', i + 2)
      const st = text.indexOf('\x1b\\', i + 2)
      if (bel < 0 && st < 0) {
        i = runStart = text.length
        break
      }
      i = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st + 2
    } else {
      // 其它双字符转义（ESC c 等）与 ESC 后无字符的悬挂序列。
      i += kind === undefined ? 1 : 2
    }
    runStart = i
  }
  flushRun(text.length)
  return segments
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e
}

/** 渲染前把缓冲按行拆分（\r 剥离；空行保留占位）。 */
export function splitAnsiLines(segments: readonly AnsiSegment[]): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]]
  for (const segment of segments) {
    const pieces = segment.text.replace(/\r/g, '').split('\n')
    for (let index = 0; index < pieces.length; index += 1) {
      if (index > 0) lines.push([])
      const piece = pieces[index]!
      if (piece) lines.at(-1)!.push({ text: piece, color: segment.color, bold: segment.bold })
    }
  }
  return lines
}
