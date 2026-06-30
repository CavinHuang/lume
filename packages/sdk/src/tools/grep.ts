/**
 * GrepTool - Search file contents using regex
 */

import { spawn } from 'child_process'
import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { isNativeAvailable, nativeGrep } from '@lume/natives'

export const GrepTool = defineTool({
  name: 'Grep',
  description: 'Search file contents using regex patterns. Uses native ripgrep engine when available and falls back to rg/grep. Supports file type filtering and context lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in (defaults to cwd)',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")',
      },
      type: {
        type: 'string',
        description: 'File type filter (e.g., "ts", "py", "js")',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode (default: files_with_matches)',
      },
      '-i': {
        type: 'boolean',
        description: 'Case insensitive search',
      },
      '-n': {
        type: 'boolean',
        description: 'Show line numbers (default: true)',
      },
      '-A': { type: 'number', description: 'Lines after match' },
      '-B': { type: 'number', description: 'Lines before match' },
      '-C': { type: 'number', description: 'Context lines' },
      context: { type: 'number', description: 'Context lines (alias for -C)' },
      head_limit: { type: 'number', description: 'Limit output entries (default: 250)' },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchPath = input.path
      ? await resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
    const outputMode = input.output_mode || 'files_with_matches'
    const headLimit = input.head_limit ?? 250
    const sandboxError = ensurePathAllowed(
      searchPath,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    if (isNativeAvailable()) {
      const ctx = input['-C'] ?? input.context
      const mode = outputMode === 'files_with_matches'
        ? 'filesWithMatches' as const
        : outputMode === 'count'
          ? 'count' as const
          : 'content' as const

      const result = await nativeGrep({
        pattern: input.pattern,
        path: searchPath,
        glob: input.glob,
        type: input.type,
        ignore_case: input['-i'] ?? false,
        context: ctx,
        context_before: input['-B'],
        context_after: input['-A'],
        max_count: headLimit,
        mode,
        cache: true,
        gitignore: true,
        timeout_ms: 30_000,
      })

      if (result !== null) {
        if (result.matches.length === 0) {
          return `No matches found for pattern "${input.pattern}"`
        }

        if (mode === 'filesWithMatches') {
          const files = [...new Set(result.matches.map((m) => m.path))]
          return JSON.stringify({
            pattern: input.pattern,
            path: searchPath,
            output_mode: outputMode,
            matches: files.slice(0, headLimit),
            total_matches: result.total_matches,
            files_with_matches: result.files_with_matches,
          }, null, 2)
        }

        if (mode === 'count') {
          return JSON.stringify({
            pattern: input.pattern,
            path: searchPath,
            output_mode: outputMode,
            matches: result.matches
              .map((m) => `${m.path}:${m.match_count ?? 0}`)
              .slice(0, headLimit),
          }, null, 2)
        }

        const lines = result.matches.map((m) => {
          const parts: string[] = []
          if (m.context_before) {
            parts.push(...m.context_before.map((c) => `${m.path}-${c.line_number}-${c.line}`))
          }
          parts.push(`${m.path}:${m.line_number}:${m.line}`)
          if (m.context_after) {
            parts.push(...m.context_after.map((c) => `${m.path}-${c.line_number}-${c.line}`))
          }
          return parts.join('\n')
        })
        return JSON.stringify({
          pattern: input.pattern,
          path: searchPath,
          output_mode: outputMode,
          matches: lines.slice(0, headLimit),
          total_matches: result.total_matches,
        }, null, 2)
      }
    }

    const args: string[] = []
    let cmd = 'rg'

    if (outputMode === 'files_with_matches') {
      args.push('--files-with-matches')
    } else if (outputMode === 'count') {
      args.push('--count')
    } else {
      if (input['-n'] !== false) args.push('--line-number')
    }

    if (input['-i']) args.push('--ignore-case')
    if (input['-A']) args.push('-A', String(input['-A']))
    if (input['-B']) args.push('-B', String(input['-B']))
    const ctx = input['-C'] ?? input.context
    if (ctx) args.push('-C', String(ctx))
    if (input.glob) args.push('--glob', input.glob)
    if (input.type) args.push('--type', input.type)

    args.push('--', input.pattern, searchPath)

    return new Promise<string>((resolvePromise) => {
      const proc = spawn(cmd, args, {
        cwd: context.cwd,
        timeout: 30000,
      })

      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.stderr?.on('data', (d: Buffer) => errChunks.push(d))

      proc.on('close', (code) => {
        let result = Buffer.concat(chunks).toString('utf-8').trim()

        if (!result && code !== 0) {
          // Try fallback to grep
          const grepArgs = ['-r']
          if (input['-i']) grepArgs.push('-i')
          if (outputMode === 'files_with_matches') grepArgs.push('-l')
          if (outputMode === 'count') grepArgs.push('-c')
          if (outputMode === 'content' && input['-n'] !== false) grepArgs.push('-n')
          if (input.glob) grepArgs.push('--include', input.glob)
          grepArgs.push('--', input.pattern, searchPath)

          const grepProc = spawn('grep', grepArgs, {
            cwd: context.cwd,
            timeout: 30000,
          })

          const grepChunks: Buffer[] = []
          grepProc.stdout?.on('data', (d: Buffer) => grepChunks.push(d))
          grepProc.on('close', () => {
            const grepResult = Buffer.concat(grepChunks).toString('utf-8').trim()
            if (!grepResult) {
              resolvePromise(`No matches found for pattern "${input.pattern}"`)
            } else {
              const lines = grepResult.split('\n')
              if (headLimit > 0 && lines.length > headLimit) {
                resolvePromise(lines.slice(0, headLimit).join('\n') + `\n... (${lines.length - headLimit} more)`)
              } else {
                resolvePromise(grepResult)
              }
            }
          })
          grepProc.on('error', () => {
            resolvePromise(`Error: native grep unavailable and grep fallback failed`)
          })
          return
        }

        if (!result) {
          resolvePromise(JSON.stringify({
            pattern: input.pattern,
            path: searchPath,
            output_mode: outputMode,
            matches: [],
          }))
          return
        }

        const lines = result.split('\n')
        if (headLimit > 0 && lines.length > headLimit) {
          result = lines.slice(0, headLimit).join('\n') + `\n... (${lines.length - headLimit} more)`
        }

        resolvePromise(JSON.stringify({
          pattern: input.pattern,
          path: searchPath,
          output_mode: outputMode,
          matches: result.split(/\r?\n/).filter(Boolean),
        }, null, 2))
      })

      proc.on('error', () => {
        const grepArgs = ['-r', '-n', '--', input.pattern, searchPath]
        const grepProc = spawn('grep', grepArgs, {
          cwd: context.cwd,
          timeout: 30000,
        })
        const grepChunks: Buffer[] = []
        grepProc.stdout?.on('data', (d: Buffer) => grepChunks.push(d))
        grepProc.on('close', () => {
          const grepResult = Buffer.concat(grepChunks).toString('utf-8').trim()
          resolvePromise(JSON.stringify({
            pattern: input.pattern,
            path: searchPath,
            output_mode: outputMode,
            matches: grepResult ? grepResult.split(/\r?\n/).filter(Boolean) : [],
          }, null, 2))
        })
        grepProc.on('error', () => {
          resolvePromise(`Error: neither rg nor grep available`)
        })
      })
    })
  },
})
