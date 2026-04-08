/**
 * FileWriteTool - Write/create files
 */

import { writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed } from '../utils/pathing.js'

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
      await writeFile(filePath, input.content, 'utf-8')

      const lines = input.content.split('\n').length
      const bytes = Buffer.byteLength(input.content, 'utf-8')
      return {
        data: {
          filePath,
          lines,
          bytes,
          message: `File written: ${filePath} (${lines} lines, ${bytes} bytes)`,
        },
      }
    } catch (err: any) {
      return { data: `Error writing file: ${err.message}`, is_error: true }
    }
  },
})
