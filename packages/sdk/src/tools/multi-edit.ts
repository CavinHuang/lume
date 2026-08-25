/**
 * MultiEditTool - Multiple exact string replacements in one file, applied atomically.
 *
 * 全部 hunk 先在内存中依序求值，任一失配整体拒绝、零落盘（#570）；只有
 * 全部命中才单次 writeFileAtomic。匹配复用 Edit 的三层归一（精确/引号/
 * 等长空白），stale 校验复用 buildStaleReadRejection，两套判定不漂移。
 */

import { readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed, ensureWriteContained, getUnsafeFilePathReason, resolveInputPath } from '../utils/pathing.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'
import { withFileMutationLock } from '../utils/file-mutation-lock.js'
import { writeFileAtomic } from '../utils/fs-atomic.js'
import { assertWriteAllowed, buildStaleReadRejection, findMatchingRanges, replaceRanges } from './edit.js'
import type { EditNormalization } from './edit.js'

/** 单次审批的 hunk 护栏：超大批量改动应走 Write 全量重写，审批者也读不完 */
const MAX_MULTI_EDITS = 20

interface MultiEditHunk {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const MultiEditTool = defineTool({
  name: 'MultiEdit',
  description: 'Perform multiple exact string replacements in a single file within one atomic operation. Each edit applies in order against the evolving content; if ANY edit fails to match its old_string exactly (including whitespace and indentation), NOTHING is written and the whole operation is rejected with the failing index. The file must be read with Read before the first edit.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify',
      },
      edits: {
        type: 'array',
        description: `The edits to apply in order (max ${MAX_MULTI_EDITS}). Later edits see the results of earlier ones.`,
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'The exact text to find' },
            new_string: { type: 'string', description: 'The replacement text' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences of this old_string (default false; false requires a unique match)' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) return 'file_path is required.'
    if (!Array.isArray(input.edits) || input.edits.length === 0) return 'edits must be a non-empty array.'
    if (input.edits.length > MAX_MULTI_EDITS) {
      return `Too many edits (${input.edits.length}). At most ${MAX_MULTI_EDITS} per call — for rewriting most of the file, prefer the Write tool with the complete content.`
    }
    for (const [index, edit] of input.edits.entries()) {
      if (!edit || typeof edit !== 'object') return `edits[${index}] must be an object.`
      if (typeof edit.old_string !== 'string') return `edits[${index}].old_string must be a string.`
      if (typeof edit.new_string !== 'string') return `edits[${index}].new_string must be a string.`
      if (edit.old_string === edit.new_string) return `edits[${index}]: old_string and new_string are identical.`
      if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') return `edits[${index}].replace_all must be a boolean.`
    }
  },
  getPath(input, context) {
    return resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
  },
  async call(input, context) {
    const unsafePathReason = getUnsafeFilePathReason(input.file_path)
    if (unsafePathReason) return { data: `Error: ${unsafePathReason}`, is_error: true }
    const filePath = await resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
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

    const hunks = input.edits as MultiEditHunk[]

    return withFileMutationLock(filePath, async () => { try {
      const decoded = decodeTextFile(await readFile(filePath))
      const originalContent = decoded.content
      let content = originalContent

      // stale 判定与 Edit 共用一条路径（#570）：两套口径漂移比重复代码更贵
      const existing = await stat(filePath)
      const staleRejection = buildStaleReadRejection(context, filePath, content, existing)
      if (staleRejection) return staleRejection

      // 顺序模拟：后一 hunk 看得到前一 hunk 的结果；任一失配即整体拒绝。
      // 干扰表现为失配（零落盘），无需额外的重叠区间检测。
      const perHunkReplacements: number[] = []
      const normalizations: EditNormalization[] = []
      for (const [index, hunk] of hunks.entries()) {
        const matches = findMatchingRanges(content, hunk.old_string)
        if (matches.length === 0) {
          const attempts = (context.editFailureCounts?.get(filePath) ?? 0) + 1
          context.editFailureCounts?.set(filePath, attempts)
          return {
            data: `Error: edits[${index}]: old_string not found in ${filePath}. Nothing was written — the file still has its original content. Read the file again and copy each old_string exactly from its current content.`,
            is_error: true,
            _meta: { file: { path: filePath, conflict: 'not_found', failedEditIndex: index, attempts, retryable: true } },
          }
        }

        const ranges = matches
        if (!hunk.replace_all && matches.length > 1) {

          return {
            data: `Error: edits[${index}]: old_string appears ${matches.length} times in the file. Add surrounding context to make it unique, or set replace_all: true on this edit.`,
            is_error: true,
            _meta: { file: { path: filePath, conflict: 'ambiguous_match', failedEditIndex: index, retryable: true } },
          }
        }
        content = replaceRanges(content, ranges, hunk.new_string)
        perHunkReplacements.push(ranges.length)
        normalizations.push(...ranges.map((match) => match.normalized))
      }

      const totalReplacements = perHunkReplacements.reduce((sum, count) => sum + count, 0)
      const lineChanges = countLineChanges(originalContent, content)
      await writeFileAtomic(filePath, encodeTextFile(content, decoded), assertWriteAllowed(context))
      await updateFileState(context, filePath, content)
      context.editFailureCounts?.delete(filePath)

      // 模型可见文本注明归一命中：_meta 会被 sanitize 剥除（#569）。
      const usedQuotes = normalizations.some((value) => value === 'quotes')
      const usedWhitespace = normalizations.some((value) => value === 'whitespace')
      const toleranceNote = usedWhitespace
        ? ', matched after normalizing tabs and unicode spaces to plain spaces'
        : usedQuotes
          ? ', matched after normalizing curly quotes to straight quotes'
          : ''
      return {
        data: {
          filePath,
          editsApplied: hunks.length,
          replacements: totalReplacements,
          perEditReplacements: perHunkReplacements,
          message: `File edited: ${filePath} (${hunks.length} edits applied${toleranceNote})`,
        },
        _meta: {
          file: {
            path: filePath,
            replacements: totalReplacements,
            overwritten: true,
            checkpointable: true,
            checkpointId: context.currentUserMessageId,
            ...(usedQuotes ? { normalizedQuotes: true } : {}),
            ...(usedWhitespace ? { normalizedWhitespace: true } : {}),
            ...lineChanges,
          },
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error editing file ${filePath}: ${err.code ? `[${err.code}] ` : ''}${err.message}`, is_error: true }
    } })
  },
})

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
