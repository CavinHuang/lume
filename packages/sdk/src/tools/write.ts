/**
 * FileWriteTool - Write/create files
 */

import { writeFile, mkdir, rename, rm, readFile, stat } from 'fs/promises'
import { resolve, dirname, basename, join } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed } from '../utils/pathing.js'
import { notifyLspFileChanged } from '../lsp/client.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'

export const FileWriteTool = defineTool({
  name: 'Write',
  description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does. Creates parent directories as needed.',
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
    return resolve(context.cwd, input.file_path)
  },
  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path)
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
      await mkdir(dirname(filePath), { recursive: true })
      let encoded: Uint8Array = Buffer.from(input.content, 'utf8')
      let overwritten = false
      const existing = await stat(filePath).catch(() => undefined)
      if (existing?.isDirectory()) {
        return { data: `Error writing file: ${filePath} is a directory`, is_error: true }
      }
      if (existing) {
        overwritten = true
        const decoded = decodeTextFile(await readFile(filePath))
        const previousRead = context.fileStateCache?.get(filePath)
        if (previousRead && !previousRead.isPartialView && previousRead.content !== decoded.content) {
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
        isPartialView: false,
      })

      const lines = input.content.split('\n').length
      const bytes = Buffer.byteLength(input.content, 'utf-8')
      return {
        data: {
          filePath,
          overwritten,
          lines,
          bytes,
          message: `File written: ${filePath} (${lines} lines, ${bytes} bytes)`,
        },
        _meta: { file: { path: filePath, overwritten, checkpointable: true, checkpointId: context.currentUserMessageId } },
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
