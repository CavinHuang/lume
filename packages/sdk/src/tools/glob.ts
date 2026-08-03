/**
 * GlobTool - File pattern matching
 */

import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { isNativeAvailable, nativeGlob } from '@lume/natives'
import { stat } from 'fs/promises'

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.js".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (defaults to cwd)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) return 'pattern is required.'
    if (input.path !== undefined && (typeof input.path !== 'string' || !input.path.trim())) return 'path must be a non-empty string.'
  },
  getPath(input, context) {
    return input.path
      ? resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
  },
  async call(input, context) {
    const searchDir = input.path
      ? await resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
    const { pattern } = input
    const sandboxError = ensurePathAllowed(
      searchDir,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    try {
      if (!(await stat(searchDir)).isDirectory()) {
        return { data: `Error: ${searchDir} is not a directory.`, is_error: true }
      }
    } catch {
      return { data: `Error: Search path not found: ${searchDir}`, is_error: true }
    }
    if (context.abortSignal?.aborted) return { data: 'Glob aborted.', is_error: true }

    if (isNativeAvailable()) {
      const result = await nativeGlob({
        pattern,
        path: searchDir,
        file_type: 'file',
        hidden: false,
        max_results: 501,
        gitignore: true,
        cache: true,
        sort_by_mtime: true,
      })

      if (result !== null) {
        const total = result.total_matches
        const truncated = result.matches.length > 500 || total > 500
        return {
          data: {
            pattern,
            path: searchDir,
            matches: result.matches.slice(0, 500).map((match) => match.path),
          },
          _meta: { search: { offset: 0, limit: 500, total, truncated, appliedOffset: 0, appliedLimit: 500 } },
        }
      }
    }

    try {
      const { glob } = await import('fs/promises')

      // @ts-ignore - glob is available in Node 22+
      if (typeof glob === 'function') {
        const matches: string[] = []
        let truncated = false
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir, signal: context.abortSignal })) {
          matches.push(entry)
          if (matches.length > 500) {
            truncated = true
            matches.pop()
            break
          }
        }
        return {
          data: {
            pattern,
            path: searchDir,
            matches,
          },
          _meta: { search: { offset: 0, limit: 500, total: truncated ? undefined : matches.length, truncated, appliedOffset: 0, appliedLimit: 500 } },
        }
      }
    } catch {
      // Fall through to an explicit unavailable result.
    }

    return {
      data: 'Glob is unavailable: native glob failed and Node fs.promises.glob is not available',
      is_error: true,
    }
  },
})
