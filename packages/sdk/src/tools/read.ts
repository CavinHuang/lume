/**
 * FileReadTool - Read file contents with line numbers
 */

import { readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'

export const FileReadTool = defineTool({
  name: 'Read',
  description: 'Read a text file from the filesystem and return content with line numbers. Image files return metadata only.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['file_path'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const filePath = await resolveInputPath(
      context.cwd,
      input.file_path,
      context.additionalDirectories,
    )
    const sandboxError = ensurePathAllowed(
      filePath,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    try {
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        return { data: `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`, is_error: true }
      }

      // Check for binary/image files
      const ext = filePath.split('.').pop()?.toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext || '')) {
        return {
          data: {
            filePath,
            mediaType: ext || 'image',
            size: fileStat.size,
            notice: `[Image file: ${filePath} (${fileStat.size} bytes)]`,
          },
        }
      }

      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      const offset = input.offset || 0
      const limit = input.limit || 2000
      const selectedLines = lines.slice(offset, offset + limit)

      // Format with line numbers (cat -n style)
      const numbered = selectedLines.map((line: string, i: number) => {
        const lineNum = offset + i + 1
        return `${lineNum}\t${line}`
      }).join('\n')

      return {
        data: {
          filePath,
          content: numbered || '(empty file)',
          offset,
          limit,
          totalLines: lines.length,
          remainingLines: Math.max(0, lines.length - offset - limit),
        },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error reading file: ${err.message}`, is_error: true }
    }
  },
})
