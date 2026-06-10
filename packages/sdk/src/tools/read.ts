/**
 * FileReadTool - Read file contents with line numbers
 */

import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { isNativeAvailable, nativeSummarize } from '@lume/natives'

/** File extensions that have tree-sitter grammar support for summarization. */
const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go', '.java',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh',
  '.html', '.htm', '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.md',
])

const SUMMARIZE_THRESHOLD_LINES = 500

export const FileReadTool = defineTool({
  name: 'Read',
  description: 'Read a text file from the filesystem and return content with line numbers. Large files (>500 lines) are automatically summarized to save context. Image files return metadata only.',
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

      // If user specified offset/limit, always return raw content (explicit read)
      const hasExplicitRange = input.offset !== undefined || input.limit !== undefined

      // Auto-summarize large files with native tree-sitter
      if (
        !hasExplicitRange
        && lines.length > SUMMARIZE_THRESHOLD_LINES
        && isNativeAvailable()
      ) {
        const ext = extname(filePath).toLowerCase()
        if (SUMMARIZABLE_EXTENSIONS.has(ext)) {
          const summary = nativeSummarize({
            code: content,
            path: filePath,
            min_body_lines: 4,
            min_comment_lines: 6,
            unfold_until_lines: 200,
          })

          if (summary && summary.parsed && summary.segments.length > 0) {
            const keptSegments: string[] = []
            let keptLines = 0
            for (const seg of summary.segments) {
              if (seg.kind === 'kept' && seg.text) {
                const segLines = seg.text.split('\n').length
                keptSegments.push(seg.text)
                keptLines += segLines
              } else if (seg.kind === 'elided') {
                const lineCount = seg.endLine - seg.startLine + 1
                keptSegments.push(`/* ... ${lineCount} lines elided (lines ${seg.startLine}-${seg.endLine}) ... */`)
              }
            }

            return {
              data: {
                filePath,
                content: keptSegments.join('\n'),
                totalLines: lines.length,
                summarized: true,
                keptLines,
                language: summary.language,
              },
            }
          }
        }
      }

      // Default: return raw content with line numbers
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
