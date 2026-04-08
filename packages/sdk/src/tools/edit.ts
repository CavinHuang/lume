/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed } from '../utils/pathing.js'

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
  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path)
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
      let content = await readFile(filePath, 'utf-8')

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
        await writeFile(filePath, content, 'utf-8')
        return {
          data: {
            filePath,
            replacements: 1,
            replaceAll: false,
            message: `File edited: ${filePath}`,
          },
        }
      } else {
        const count = content.split(old_string).length - 1
        content = content.split(old_string).join(new_string)
        await writeFile(filePath, content, 'utf-8')
        return {
          data: {
            filePath,
            replacements: count,
            replaceAll: true,
            message: `File edited: ${filePath}`,
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
