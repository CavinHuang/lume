/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, stat, writeFile, rename, rm } from 'fs/promises'
import { dirname, basename, join } from 'path'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed, getUnsafeFilePathReason, resolveInputPath } from '../utils/pathing.js'
import { prepareLspWritethrough } from '../lsp/writethrough.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'
import { withFileMutationLock } from '../utils/file-mutation-lock.js'

export const FileEditTool = defineTool({
  name: 'Edit',
  description: 'Perform exact string replacements in files. The old_string must match exactly (including whitespace and indentation). Use replace_all to change every occurrence.',
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
      const changedSinceRead = previousRead && (
        previousRead.timestamp !== existing.mtimeMs
        || (previousRead.size !== undefined && previousRead.size !== existing.size)
        || (!previousRead.isPartialView && previousRead.content !== content)
      )
      if (changedSinceRead) {
        return {
          data: `Error: File has been modified since it was read: ${filePath}. The earlier edit may have succeeded or another process changed it. Read the file again before attempting another Edit.`,
          is_error: true,
          _meta: { file: { path: filePath, conflict: 'stale_read', retryable: true } },
        }
      }

      const matches = findMatchingRanges(content, old_string)
      if (matches.length === 0) {
        return { data: `Error: old_string not found in ${filePath}. Make sure it matches exactly including whitespace.`, is_error: true }
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
        const lsp = await prepareLspWritethrough({ filePath, content, context, existedBefore: true })
        content = lsp.content
        const lineChanges = countLineChanges(decoded.content, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded))
        const lspResult = await lsp.commit()
        await updateFileState(context, filePath, content)
        return {
          data: {
            filePath,
            replacements: 1,
            replaceAll: false,
            message: `File edited: ${filePath}`,
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
            lsp: lspResult,
          },
        }
      } else {
        const count = matches.length
        content = replaceRanges(content, matches, new_string, old_string.length)
        const lsp = await prepareLspWritethrough({ filePath, content, context, existedBefore: true })
        content = lsp.content
        const lineChanges = countLineChanges(decoded.content, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded))
        const lspResult = await lsp.commit()
        await updateFileState(context, filePath, content)
        return {
          data: {
            filePath,
            replacements: count,
            replaceAll: true,
            message: `File edited: ${filePath}`,
          },
          _meta: {
            file: {
              path: filePath,
              replacements: count,
              overwritten: true,
              checkpointable: true,
              checkpointId: context.currentUserMessageId,
              ...(matches.some((match) => match.normalized) ? { normalizedQuotes: true } : {}),
              ...lineChanges,
            },
            lsp: lspResult,
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

async function writeFileAtomic(filePath: string, content: Uint8Array): Promise<void> {
  const dir = dirname(filePath)
  const tempPath = join(dir, `.${basename(filePath)}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content)
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
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
