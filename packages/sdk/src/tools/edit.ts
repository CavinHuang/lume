/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed, ensureWriteContained, writeContainmentRoots, makeWriteInstantRecheck, getUnsafeFilePathReason, resolveInputPath } from '../utils/pathing.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'
import { withFileMutationLock } from '../utils/file-mutation-lock.js'
import { writeFileAtomic } from '../utils/fs-atomic.js'

// writeFileAtomic 检出 symlink 后的写入瞬间复检：containment 不以沙箱启用为
// 前提（#546），sandbox 启用时再叠加 deny/allow 规则。MultiEdit 复用同一
// 写入闸（#570）；与 write 共享单一实现（可维护性复审），根集含
// privateWriteRoots（#639 拆分通道）。
export const assertWriteAllowed = makeWriteInstantRecheck

/**
 * Read-before-edit 硬校验（#333/#569）：无读取记录禁止盲改；已读但 mtime/
 * size/内容任一变化判 stale。Edit 与 MultiEdit 共用此路径，两套判定不漂移。
 */
export function buildStaleReadRejection(
  context: ToolContext,
  filePath: string,
  decodedContent: string,
  existingStat: { mtimeMs: number; size: number },
): { data: string; is_error: true; _meta: Record<string, unknown> } | null {
  const previousRead = context.fileStateCache?.get(filePath)
  // Read-before-edit 强制（#569）：无读取记录的文件禁止盲改。
  if (!previousRead) {
    // 容量区分（#655 终局 review·并发方向发现 A）：长会话 LRU 驱逐会
    // 产生「明明读过却报未读」的伪错误；区分文案让模型自愈路径更短。
    const data = context.fileStateCache?.wasDroppedByCapacity(filePath)
      ? `Error: The read record for ${filePath} was dropped because the session's file-state cache hit its capacity limit (long sessions drop the oldest records). Read the file again, then retry this Edit.`
      : `Error: File has not been read yet: ${filePath}. Read it first, then retry this Edit.`
    return {
      data,
      is_error: true,
      _meta: { file: { path: filePath, conflict: 'not_read', retryable: true } },
    }
  }
  const changedSinceRead =
    previousRead.timestamp !== existingStat.mtimeMs
    || (previousRead.size !== undefined && previousRead.size !== existingStat.size)
    || (!previousRead.isPartialView && previousRead.content !== decodedContent)
  if (changedSinceRead) {
    return {
      data: `Error: File has been modified since it was read: ${filePath}. The earlier edit may have succeeded or another process changed it. Read the file again before attempting another Edit.`,
      is_error: true,
      _meta: { file: { path: filePath, conflict: 'stale_read', retryable: true } },
    }
  }
  return null
}

export const FileEditTool = defineTool({
  name: 'Edit',
  description: 'Perform exact string replacements in files. The file must be read with Read before the first edit. The old_string must match exactly (including whitespace and indentation). Use replace_all to change every occurrence. If a replacement fails, re-read the file and fix the change within the same run instead of abandoning or working around it.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) return 'file_path is required.'
    if (typeof input.old_string !== 'string') return 'old_string must be a string.'
    if (typeof input.new_string !== 'string') return 'new_string must be a string.'
    if (input.replace_all !== undefined && typeof input.replace_all !== 'boolean') return 'replace_all must be a boolean.'
  },
  getPath(input, context) {
    return resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
  },
  async call(input, context) {
    const unsafePathReason = getUnsafeFilePathReason(input.file_path)
    if (unsafePathReason) return { data: `Error: ${unsafePathReason}`, is_error: true }
    const filePath = await resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
    const { old_string, new_string, replace_all } = input
    // containment 复核不以沙箱启用为前提（#546）：junction/symlink 可穿越词法边界
    const containmentError = ensureWriteContained(filePath, context.cwd, writeContainmentRoots(context))
    if (containmentError) {
      return { data: containmentError, is_error: true }
    }
    const sandboxError = ensurePathAllowed(
      filePath,
      'write',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    if (old_string === new_string) {
      return { data: 'Error: old_string and new_string are identical', is_error: true }
    }

    return withFileMutationLock(filePath, async () => { try {
      const decoded = decodeTextFile(await readFile(filePath))
      const originalContent = decoded.content
      let content = originalContent

      // 与 Write 对齐的 stale-read 防护：此前仅全量视图做内容比对，
      // 部分视图完全裸奔；补上 mtime/size 底线后两种视图都有硬校验（#333）。
      const existing = await stat(filePath)
      const staleRejection = buildStaleReadRejection(context, filePath, content, existing)
      if (staleRejection) return staleRejection

      const matches = findMatchingRanges(content, old_string)
      if (matches.length === 0) {
        // 连败升级文案（#569）：同文件连续失配时把"重读再抄原文"说死，
        // 大段替换则直接指路 Write。
        const attempts = (context.editFailureCounts?.get(filePath) ?? 0) + 1
        context.editFailureCounts?.set(filePath, attempts)
        let message = attempts >= 2
          ? `Error: old_string not found in ${filePath} (${attempts} consecutive failures). Stop guessing: Read the file again and copy old_string exactly from its current content.`
          : `Error: old_string not found in ${filePath}. Make sure it matches exactly including whitespace, or Read the file again to refresh your view.`
        if (old_string.split('\n').length >= 5) {
          message += ' For replacing a large block, prefer the Write tool with the complete file content.'
        }
        return {
          data: message,
          is_error: true,
          _meta: { file: { path: filePath, conflict: 'not_found', attempts, retryable: true } },
        }
      }

      if (!replace_all) {
        // Check uniqueness
        if (matches.length > 1) {
          return {
            data: `Error: old_string appears ${matches.length} times in the file. Provide more context to make it unique, or set replace_all: true.`,
            is_error: true,
          }
        }
        const match = matches[0]!
        content = replaceRanges(content, [match], new_string)
        const lineChanges = countLineChanges(originalContent, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded), assertWriteAllowed(context))
        await updateFileState(context, filePath, content)
        // 成功即清零连败计数，"consecutive" 名副其实。
        context.editFailureCounts?.delete(filePath)
        return {
          data: {
            filePath,
            replacements: 1,
            replaceAll: false,
            // 模型可见文本注明归一命中：_meta 会被 sanitize 剥除（#569）。
            message: buildEditedMessage(filePath, match.normalized),
          },
          _meta: {
            file: {
              path: filePath,
              replacements: 1,
              overwritten: true,
              checkpointable: true,
              checkpointId: context.currentUserMessageId,
              ...buildNormalizationMeta(match.normalized),
              ...lineChanges,
            },
          },
        }
      } else {
        const count = matches.length
        content = replaceRanges(content, matches, new_string)
        const lineChanges = countLineChanges(originalContent, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded), assertWriteAllowed(context))
        await updateFileState(context, filePath, content)
        // 成功即清零连败计数，"consecutive" 名副其实。
        context.editFailureCounts?.delete(filePath)
        const normalizedUsed = strongestNormalization(matches.map((match) => match.normalized))
        return {
          data: {
            filePath,
            replacements: count,
            replaceAll: true,
            message: buildEditedMessage(filePath, normalizedUsed),
          },
          _meta: {
            file: {
              path: filePath,
              replacements: count,
              overwritten: true,
              checkpointable: true,
              checkpointId: context.currentUserMessageId,
              ...buildNormalizationMeta(normalizedUsed),
              ...lineChanges,
            },
          },
        }
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error editing file ${filePath}: ${err.code ? `[${err.code}] ` : ''}${err.message}`, is_error: true }
    } })
  },
})

export type EditNormalization = false | 'quotes' | 'whitespace'

export type TextMatch = { index: number; length: number; normalized: EditNormalization }

/**
 * 三层匹配（#570）：精确 → 引号归一 → 空白游程归一。前两层等长、坐标直用；
 * 第三层把连续空白（tab/unicode 空白/普通空格）折叠成单空格——覆盖 tab↔
 * 多空格缩进的真实差异——经 starts 映射表把归一坐标回映为原文区间。
 * 命中不唯一仍走唯一性错误。
 */
export function findMatchingRanges(content: string, needle: string): TextMatch[] {
  const exact = collectMatches(content, needle)
  if (exact.length > 0) return exact.map((index) => ({ index, length: needle.length, normalized: false as const }))

  const quoteContent = normalizeQuotes(content)
  const quoteNeedle = normalizeQuotes(needle)
  if (quoteContent !== content || quoteNeedle !== needle) {
    const matches = collectMatches(quoteContent, quoteNeedle)
    if (matches.length > 0) return matches.map((index) => ({ index, length: needle.length, normalized: 'quotes' as const }))
  }

  const wsContent = collapseWhitespaceRuns(content)
  const wsNeedle = collapseWhitespaceRuns(needle)
  if (wsContent.text !== content || wsNeedle.text !== needle) {
    const matches = collectMatches(wsContent.text, wsNeedle.text)
    if (matches.length > 0) {
      return matches.map((start) => ({
        index: wsContent.starts[start]!,
        length: normalizedEndToSourceIndex(wsContent, start + wsNeedle.text.length) - wsContent.starts[start]!,
        normalized: 'whitespace' as const,
      }))
    }
  }

  return []
}

function collectMatches(content: string, needle: string): number[] {
  if (!needle) return []
  const matches: number[] = []
  let index = content.indexOf(needle)
  while (index >= 0) {
    matches.push(index)
    index = content.indexOf(needle, index + needle.length)
  }
  return matches
}

interface CollapsedText {
  text: string
  /** starts[i] = 归一文本第 i 个字符在原文中的起始下标 */
  starts: number[]
  sourceLength: number
}

const INVISIBLE_SPACE = /[\t\u00A0\u2000-\u200A\u202F\u205F\u3000\u0020]/

function collapseWhitespaceRuns(value: string): CollapsedText {
  const starts: number[] = []
  let text = ''
  let i = 0
  while (i < value.length) {
    if (INVISIBLE_SPACE.test(value[i]!)) {
      // 连续空白游程折叠成一个半角空格，坐标记游程起点（覆盖 tab 与 N 空格缩进的互换）
      text += ' '
      starts.push(i)
      while (i < value.length && INVISIBLE_SPACE.test(value[i]!)) i += 1
    } else {
      text += value[i]!
      starts.push(i)
      i += 1
    }
  }
  return { text, starts, sourceLength: value.length }
}

/** 归一文本终点 e 映射回原文终点：e 处字符的原文起点；越过末尾时取原文长度 */
function normalizedEndToSourceIndex(collapsed: CollapsedText, normalizedEnd: number): number {
  return normalizedEnd < collapsed.starts.length ? collapsed.starts[normalizedEnd]! : collapsed.sourceLength
}

export function replaceRanges(content: string, matches: TextMatch[], replacement: string): string {
  let result = content
  for (const match of [...matches].sort((left, right) => right.index - left.index)) {
    result = result.slice(0, match.index) + replacement + result.slice(match.index + match.length)
  }
  return result
}

function normalizeQuotes(value: string): string {
  return value
    .replace(/[“”＂]/g, '"')
    .replace(/[‘’＇]/g, "'")
}

function strongestNormalization(values: EditNormalization[]): EditNormalization {
  // whitespace 层比引号层更宽，混合命中时优先示警，避免模型误以为字面命中
  if (values.includes('whitespace')) return 'whitespace'
  if (values.includes('quotes')) return 'quotes'
  return false
}

// 模型可见文本注明归一命中：_meta 会被 sanitize 剥除（#569）。
function buildEditedMessage(filePath: string, normalization: EditNormalization): string {
  if (normalization === 'quotes') return `File edited: ${filePath} (matched after normalizing curly quotes to straight quotes)`
  if (normalization === 'whitespace') return `File edited: ${filePath} (matched after normalizing tabs and unicode spaces to plain spaces)`
  return `File edited: ${filePath}`
}

function buildNormalizationMeta(normalization: EditNormalization): Record<string, true> {
  if (normalization === 'quotes') return { normalizedQuotes: true }
  if (normalization === 'whitespace') return { normalizedWhitespace: true }
  return {}
}

async function updateFileState(context: ToolContext, filePath: string, content: string): Promise<void> {
  if (!context.fileStateCache) return
  const fileStat = await stat(filePath)
  context.fileStateCache.set(filePath, {
    content,
    timestamp: fileStat.mtimeMs,
    size: fileStat.size,
    isPartialView: false,
  })
}
