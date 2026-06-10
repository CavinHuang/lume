/**
 * GlobTool - File pattern matching
 */

import { spawn } from 'child_process'
import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { isNativeAvailable, nativeGlob } from '@lume/natives'

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

    // ── Try native glob first ────────────────────────
    if (isNativeAvailable()) {
      const result = await nativeGlob({
        pattern,
        path: searchDir,
        file_type: "file",
        hidden: false,
        max_results: 500,
        gitignore: true,
        cache: true,
        sort_by_mtime: true,
      })

      if (result !== null) {
        const matches = result.matches.map((m) => m.path)
        return {
          data: {
            pattern,
            path: searchDir,
            matches,
          },
        }
      }
    }

    // ── Fallback: Node.js glob or bash ───────────────
    try {
      const { glob } = await import('fs/promises')

      // @ts-ignore - glob is available in Node 22+
      if (typeof glob === 'function') {
        const matches: string[] = []
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir })) {
          matches.push(entry)
          if (matches.length >= 500) break
        }
        return {
          data: {
            pattern,
            path: searchDir,
            matches,
          },
        }
      }
    } catch {
      // Fall through to bash-based approach
    }

    // Fallback: use bash find/glob
    return new Promise<string>((resolvePromise) => {
      const cmd = `shopt -s globstar nullglob 2>/dev/null; cd ${JSON.stringify(searchDir)} && ls -1d ${pattern} 2>/dev/null | head -500`
      const proc = spawn('bash', ['-c', cmd], {
        cwd: searchDir,
        timeout: 30000,
      })

      const chunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.on('close', () => {
        const result = Buffer.concat(chunks).toString('utf-8').trim()
        resolvePromise(JSON.stringify({
          pattern,
          path: searchDir,
          matches: result ? result.split(/\r?\n/).filter(Boolean) : [],
        }, null, 2))
      })
      proc.on('error', () => {
        resolvePromise(`Error searching for files with pattern "${pattern}"`)
      })
    })
  },
})
