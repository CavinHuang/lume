/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed, ensureWriteContained, getUnsafeFilePathReason, resolveInputPath } from '../utils/pathing.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'
import { withFileMutationLock } from '../utils/file-mutation-lock.js'
import { writeFileAtomic } from '../utils/fs-atomic.js'

// writeFileAtomic 检出 symlink 后的写入瞬间复检：containment 不以沙箱启用为
// 前提（#546），sandbox 启用时再叠加 deny/allow 规则
const assertWriteAllowed = (context: ToolContext) => (resolvedPath: string): string | null =>
  ensureWriteContained(resolvedPath, context.cwd, context.additionalDirectories)
  ?? ensurePathAllowed(resolvedPath, 'write', context.sandbox, context.additionalDirectories)

export const FileEditTool = defineTool({
  name: 'Edit',
  description: 'Perform exact string replacements in files. The file must be read with Read before the first edit. The old_string must match exactly (including whitespace and indentation). Use replace_all to change every occurrence.',
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
    const containmentError = ensureWriteContained(filePath, context.cwd, context.additionalDirectories)
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
      let content = decoded.content

      // 与 Write 对齐的 stale-read 防护：此前仅全量视图做内容比对，
      // 部分视图完全裸奔；补上 mtime/size 底线后两种视图都有硬校验（#333）。
      const existing = await stat(filePath)
      const previousRead = context.fileStateCache?.get(filePath)
      // Read-before-edit 强制（#569）：无读取记录的文件禁止盲改。
      if (!previousRead) {
        return {
          data: `Error: File has not been read yet: ${filePath}. Read it first, then retry this Edit.`,
          is_error: true,
          _meta: { file: { path: filePath, conflict: 'not_read', retryable: true } },
        }
      }
      const changedSinceRead =
        previousRead.timestamp !== existing.mtimeMs
        || (previousRead.size !== undefined && previousRead.size !== existing.size)
        || (!previousRead.isPartialView && previousRead.content !== content)
      if (changedSinceRead) {
        return {
          data: `Error: File has been modified since it was read: ${filePath}. The earlier edit may have succeeded or another process changed it. Read the file again before attempting another Edit.`,
          is_error: true,
          _meta: { file: { path: filePath, conflict: 'stale_read', retryable: true } },
        }
      }

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
        content = replaceRanges(content, [match], new_string, old_string.length)
        const lineChanges = countLineChanges(decoded.content, content)
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
            message: match.normalized
              ? `File edited: ${filePath} (matched after normalizing curly quotes to straight quotes)`
              : `File edited: ${filePath}`,
          },
          _meta: {
            file: {
              path: filePath,
              replacements: 1,
              overwritten: true,
              checkpointable: true,
              checkpointId: context.currentUserMessageId,
              ...(match.normalized ? { normalizedQuotes: true } : {}),
              ...lineChanges,
            },
          },
        }
      } else {
        const count = matches.length
        content = replaceRanges(content, matches, new_string, old_string.length)
        const lineChanges = countLineChanges(decoded.content, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded), assertWriteAllowed(context))
        await updateFileState(context, filePath, content)
        // 成功即清零连败计数，"consecutive" 名副其实。
        context.editFailureCounts?.delete(filePath)
        const normalizedUsed = matches.some((match) => match.normalized)
        return {
          data: {
            filePath,
            replacements: count,
            replaceAll: true,
            message: normalizedUsed
              ? `File edited: ${filePath} (matched after normalizing curly quotes to straight quotes)`
              : `File edited: ${filePath}`,
          },
          _meta: {
            file: {
              path: filePath,
              replacements: count,
              overwritten: true,
              checkpointable: true,
              checkpointId: context.currentUserMessageId,
              ...(normalizedUsed ? { normalizedQuotes: true } : {}),
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

type TextMatch = { index: number; normalized: boolean }

function findMatchingRanges(content: string, needle: string): TextMatch[] {
  const exact = collectMatches(content, needle)
  if (exact.length > 0) return exact.map((index) => ({ index, normalized: false }))

  const normalizedContent = normalizeQuotes(content)
  const normalizedNeedle = normalizeQuotes(needle)
  if (normalizedContent === content && normalizedNeedle === needle) return []
  return collectMatches(normalizedContent, normalizedNeedle).map((index) => ({ index, normalized: true }))
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

function replaceRanges(content: string, matches: TextMatch[], replacement: string, originalLength: number): string {
  let result = content
  for (const match of [...matches].sort((left, right) => right.index - left.index)) {
    result = result.slice(0, match.index) + replacement + result.slice(match.index + originalLength)
  }
  return result
}

function normalizeQuotes(value: string): string {
  return value
    .replace(/[“”＂]/g, '"')
    .replace(/[‘’＇]/g, "'")
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
