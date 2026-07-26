/**
 * FileWriteTool - Write/create files
 */

import { writeFile, mkdir, rename, rm, readFile, stat } from 'fs/promises'
import { dirname, basename, join } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed, getUnsafeFilePathReason, resolveInputPath } from '../utils/pathing.js'
import { notifyLspFileChanged } from '../lsp/client.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'

const DEFAULT_MAX_WRITE_BYTES = 4 * 1024 * 1024

export const FileWriteTool = defineTool({
  name: 'Write',
  description: 'Write complete file content. Creates the file or overwrites it while preserving an existing text file encoding and line endings. Use Edit for localized changes; stale reads and oversized writes are rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) return 'file_path is required.'
    if (typeof input.content !== 'string') return 'content must be a string.'
  },
  getPath(input, context) {
    return resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
  },
  async call(input, context) {
    const unsafePathReason = getUnsafeFilePathReason(input.file_path)
    if (unsafePathReason) return { data: `Error: ${unsafePathReason}`, is_error: true }
    const filePath = await resolveInputPath(context.cwd, input.file_path, context.additionalDirectories)
    const sandboxError = ensurePathAllowed(
      filePath,
      'write',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    try {
      const bytes = Buffer.byteLength(input.content, 'utf8')
      const maxBytes = configuredPositiveNumber(context, 'writeMaxBytes', DEFAULT_MAX_WRITE_BYTES)
      if (bytes > maxBytes) {
        return {
          data: `Error: Write content for ${filePath} is ${bytes} bytes, exceeding the ${maxBytes}-byte limit. Use Edit or write the file in smaller, deliberate steps.`,
          is_error: true,
          _meta: { file: { path: filePath, rejected: 'size', bytes, maxBytes } },
        }
      }
      await mkdir(dirname(filePath), { recursive: true })
      let encoded: Uint8Array = Buffer.from(input.content, 'utf8')
      let overwritten = false
      let previousContent = ''
      const existing = await stat(filePath).catch(() => undefined)
      if (existing?.isDirectory()) {
        return { data: `Error writing file: ${filePath} is a directory`, is_error: true }
      }
      if (existing) {
        overwritten = true
        const decoded = decodeTextFile(await readFile(filePath))
        previousContent = decoded.content
        const previousRead = context.fileStateCache?.get(filePath)
        const changedSinceRead = previousRead && (
          (previousRead.timestamp !== existing.mtimeMs)
          || (previousRead.size !== undefined && previousRead.size !== existing.size)
          || (!previousRead.isPartialView && previousRead.content !== decoded.content)
        )
        if (changedSinceRead) {
          return {
            data: 'Error: File has been modified since it was read. Read it again before attempting to overwrite it.',
            is_error: true,
          }
        }
        encoded = encodeTextFile(input.content, decoded)
      }
      await writeFileAtomic(filePath, encoded)
      await notifyLspFileChanged(filePath)

      const updated = await stat(filePath)
      context.fileStateCache?.set(filePath, {
        content: input.content,
        timestamp: updated.mtimeMs,
        size: updated.size,
        isPartialView: false,
      })

      const lines = input.content.length === 0 ? 0 : input.content.split('\n').length
      const lineChanges = overwritten
        ? countLineChanges(previousContent, input.content)
        : { linesAdded: lines, linesRemoved: 0 }
      return {
        data: {
          filePath,
          overwritten,
          lines,
          bytes,
          message: `File written: ${filePath} (${lines} lines, ${bytes} bytes)`,
        },
        _meta: {
          file: {
            path: filePath,
            overwritten,
            checkpointable: true,
            checkpointId: context.currentUserMessageId,
            ...lineChanges,
          }
        },
      }
    } catch (err: any) {
      return { data: `Error writing file: ${err.message}`, is_error: true }
    }
  },
})

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

function configuredPositiveNumber(context: { toolConfig?: Record<string, unknown> }, key: string, fallback: number): number {
  const value = context.toolConfig?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
