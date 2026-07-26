/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, stat, writeFile, rename, rm } from 'fs/promises'
import { dirname, basename, join } from 'path'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { notifyLspFileChanged } from '../lsp/client.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'
import { countLineChanges } from '../utils/line-change-stats.js'

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

    try {
      const decoded = decodeTextFile(await readFile(filePath))
      let content = decoded.content

      const previousRead = context.fileStateCache?.get(filePath)
      if (previousRead && !previousRead.isPartialView && previousRead.content !== content) {
        return {
          data: 'Error: File has been modified since it was read. Read it again before attempting to edit it.',
          is_error: true,
        }
      }

      if (!content.includes(old_string)) {
        return { data: `Error: old_string not found in ${filePath}. Make sure it matches exactly including whitespace.`, is_error: true }
      }

      if (!replace_all) {
        // Check uniqueness
        const count = content.split(old_string).length - 1
        if (count > 1) {
          return {
            data: `Error: old_string appears ${count} times in the file. Provide more context to make it unique, or set replace_all: true.`,
            is_error: true,
          }
        }
        content = content.replace(old_string, new_string)
        const lineChanges = countLineChanges(decoded.content, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded))
        await notifyLspFileChanged(filePath)
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
              ...lineChanges,
            }
          },
        }
      } else {
        const count = content.split(old_string).length - 1
        content = content.split(old_string).join(new_string)
        const lineChanges = countLineChanges(decoded.content, content)
        await writeFileAtomic(filePath, encodeTextFile(content, decoded))
        await notifyLspFileChanged(filePath)
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
              ...lineChanges,
            }
          },
        }
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error editing file: ${err.message}`, is_error: true }
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
