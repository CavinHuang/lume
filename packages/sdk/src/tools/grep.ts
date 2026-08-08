/**
 * GrepTool - Search file contents using regex
 */

import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { resolveRipgrepInvocation } from '../utils/ripgrep.js'
import { isNativeAvailable, nativeGrep } from '@lume/natives'

const SEARCH_LIMIT = 250
const SEARCH_TIMEOUT_MS = 30_000
const MAX_COLUMNS = 500
const EXCLUDED_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

type SearchMode = 'content' | 'files_with_matches' | 'count'

interface SearchProcessResult {
  code: number | null
  stdout: string
  stderr: string
  error?: Error
  timedOut?: boolean
  aborted?: boolean
}

export const GrepTool = defineTool({
  name: 'Grep',
  description: 'Search file contents using regex patterns. Uses native ripgrep engine when available and falls back to rg/grep. Supports file type filtering, context lines, pagination, and explicit truncation metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in (defaults to cwd)' },
      glob: { type: 'string', description: 'Glob pattern to filter files' },
      type: { type: 'string', description: 'File type filter (e.g., ts, py, js)' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode (default: files_with_matches)',
      },
      '-i': { type: 'boolean', description: 'Case insensitive search' },
      '-n': { type: 'boolean', description: 'Show line numbers (default: true)' },
      '-A': { type: 'number', description: 'Lines after match' },
      '-B': { type: 'number', description: 'Lines before match' },
      '-C': { type: 'number', description: 'Context lines' },
      context: { type: 'number', description: 'Context lines (alias for -C)' },
      offset: { type: 'number', description: 'Number of matching entries to skip (default: 0)' },
      head_limit: { type: 'number', description: 'Maximum output entries (default: 250, 0 means unlimited)' },
      multiline: { type: 'boolean', description: 'Enable multiline regex matching' },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.pattern !== 'string' || !input.pattern) return 'pattern is required.'
    const outputMode = input.output_mode || 'files_with_matches'
    if (!['content', 'files_with_matches', 'count'].includes(outputMode)) return 'output_mode is invalid.'
    for (const key of ['offset', 'head_limit', '-A', '-B', '-C', 'context']) {
      if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0)) {
        return `${key} must be a non-negative integer.`
      }
    }
  },
  getPath(input, context) {
    return input.path
      ? resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
  },
  async call(input, context) {
    const searchPath = input.path
      ? await resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
    const outputMode = (input.output_mode || 'files_with_matches') as SearchMode
    const offset = input.offset ?? 0
    const headLimit = input.head_limit ?? SEARCH_LIMIT
    const sandboxError = ensurePathAllowed(
      searchPath,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) return { data: sandboxError, is_error: true }

    try {
      const searchStat = await stat(searchPath)
      if (!searchStat.isFile() && !searchStat.isDirectory()) {
        return { data: `Error: ${searchPath} is not a searchable file or directory.`, is_error: true }
      }
    } catch (error: any) {
      return { data: `Error: Search path not found: ${searchPath}`, is_error: true }
    }

    if (context.abortSignal?.aborted) return { data: 'Grep aborted.', is_error: true }

    // Explicit and bundled rg paths are deterministic package configuration.
    // For an ordinary PATH lookup keep the existing in-process engine first;
    // it avoids a process spawn when native search is available.
    if (resolveRipgrepInvocation(context.sandbox).source === 'system' && isNativeAvailable()) {
      const native = await runNativeSearch(input, searchPath, outputMode, offset, headLimit)
      if (native) return native
    }

    return runFallbackSearch({ input, searchPath, outputMode, offset, headLimit, context })
  },
})

function formatNativeResult(
  pattern: string,
  searchPath: string,
  outputMode: SearchMode,
  offset: number,
  headLimit: number,
  result: Awaited<ReturnType<typeof nativeGrep>> & {},
  engine: 'native' | 'rg' | 'grep',
): { data: string; _meta?: Record<string, unknown> } {
  if (!result || result.matches.length === 0) {
    return {
      data: `No matches found for pattern "${pattern}"`,
      _meta: { search: { engine, offset, limit: headLimit, total: 0, truncated: false, appliedOffset: offset, appliedLimit: headLimit } },
    }
  }

  const entries = outputMode === 'files_with_matches'
    ? [...new Set(result.matches.map((match) => match.path))]
    : outputMode === 'count'
      ? result.matches.map((match) => `${match.path}:${match.match_count ?? 0}`)
      : result.matches.map((match) => {
          const lines: string[] = []
          if (match.context_before) lines.push(...match.context_before.map((line) => `${match.path}-${line.line_number}-${line.line}`))
          lines.push(`${match.path}:${match.line_number}:${match.line}`)
          if (match.context_after) lines.push(...match.context_after.map((line) => `${match.path}-${line.line_number}-${line.line}`))
          return lines.join('\n')
        })
  const total = outputMode === 'files_with_matches'
    ? result.files_with_matches
    : result.total_matches
  const truncated = result.limit_reached === true || (headLimit > 0 && offset + entries.length < total)
  const matches = headLimit > 0 ? entries.slice(0, headLimit) : entries
  return {
    data: JSON.stringify({ pattern, path: searchPath, output_mode: outputMode, matches, total_matches: total }, null, 2),
    _meta: {
      search: {
        engine,
        offset,
        limit: headLimit,
        total,
        truncated,
        appliedOffset: offset,
        appliedLimit: headLimit,
      },
    },
  }
}

async function runFallbackSearch({
  input,
  searchPath,
  outputMode,
  offset,
  headLimit,
  context,
}: {
  input: any
  searchPath: string
  outputMode: SearchMode
  offset: number
  headLimit: number
  context: Parameters<NonNullable<typeof GrepTool['call']>>[1]
}): Promise<{ data: string; is_error?: boolean; _meta?: Record<string, unknown> }> {
  const args = buildRgArgs(input, outputMode, searchPath)
  const ripgrep = resolveRipgrepInvocation(context.sandbox)
  const rg = await runSearchProcess(ripgrep.command, [...ripgrep.args, ...args], context.abortSignal)
  if (isCommandNotFound(rg.error) && ripgrep.source === 'system' && isNativeAvailable()) {
    const native = await runNativeSearch(input, searchPath, outputMode, offset, headLimit)
    if (native) return native
  }
  const processResult = isCommandNotFound(rg.error)
    ? await runSearchProcess('grep', buildGrepArgs(input, outputMode, searchPath), context.abortSignal)
    : rg
  const engine = processResult === rg ? 'rg' : 'grep'

  if (processResult.aborted) return { data: 'Grep aborted.', is_error: true }
  if (processResult.timedOut) return { data: `Grep timed out after ${SEARCH_TIMEOUT_MS}ms.`, is_error: true }
  if (processResult.error) return { data: `Error: grep unavailable: ${processResult.error.message}`, is_error: true }
  if (processResult.code !== 0 && processResult.code !== 1) {
    return { data: `Error: grep failed${processResult.stderr ? `: ${processResult.stderr.trim()}` : ''}`, is_error: true }
  }

  const allEntries = processResult.stdout.trim()
    ? processResult.stdout.trim().split(/\r?\n/).filter(Boolean)
    : []
  if (allEntries.length === 0) {
    return {
      data: `No matches found for pattern "${input.pattern}"`,
      _meta: { search: { engine, ripgrepSource: engine === 'rg' ? ripgrep.source : undefined, offset, limit: headLimit, total: 0, truncated: false, appliedOffset: offset, appliedLimit: headLimit } },
    }
  }
  const total = allEntries.length
  const matches = headLimit > 0 ? allEntries.slice(offset, offset + headLimit) : allEntries.slice(offset)
  const truncated = offset + matches.length < total
  return {
    data: JSON.stringify({
      pattern: input.pattern,
      path: searchPath,
      output_mode: outputMode,
      matches,
      total_matches: total,
    }, null, 2),
    _meta: { search: { engine, ripgrepSource: engine === 'rg' ? ripgrep.source : undefined, offset, limit: headLimit, total, truncated, appliedOffset: offset, appliedLimit: headLimit } },
  }
}

function isCommandNotFound(error?: Error): boolean {
  return Boolean(error && (
    ('code' in error && error.code === 'ENOENT')
    || error.message.includes('ENOENT')
  ))
}

async function runNativeSearch(input: any, searchPath: string, outputMode: SearchMode, offset: number, headLimit: number): Promise<{ data: string; _meta?: Record<string, unknown> } | undefined> {
  const context = input['-C'] ?? input.context
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
    multiline: input.multiline ?? false,
    context,
    context_before: input['-B'],
    context_after: input['-A'],
    ...(headLimit > 0 ? { max_count: headLimit } : {}),
    ...(offset > 0 ? { offset } : {}),
    max_columns: MAX_COLUMNS,
    mode,
    cache: true,
    gitignore: true,
    timeout_ms: SEARCH_TIMEOUT_MS,
  })
  return result && !result.error
    ? formatNativeResult(input.pattern, searchPath, outputMode, offset, headLimit, result, 'native')
    : undefined
}

function buildRgArgs(input: any, outputMode: SearchMode, searchPath: string): string[] {
  const args: string[] = []
  if (outputMode === 'files_with_matches') args.push('--files-with-matches')
  else if (outputMode === 'count') args.push('--count')
  else {
    if (input['-n'] !== false) args.push('--line-number')
    args.push('--max-columns', String(MAX_COLUMNS), '--max-columns-preview')
  }
  if (input['-i']) args.push('--ignore-case')
  if (input.multiline) args.push('--multiline')
  if (input['-A']) args.push('-A', String(input['-A']))
  if (input['-B']) args.push('-B', String(input['-B']))
  const ctx = input['-C'] ?? input.context
  if (ctx) args.push('-C', String(ctx))
  if (input.glob) args.push('--glob', input.glob)
  if (input.type) args.push('--type', input.type)
  for (const directory of EXCLUDED_DIRS) args.push('--glob', `!${directory}/**`)
  args.push('--', input.pattern, searchPath)
  return args
}

function buildGrepArgs(input: any, outputMode: SearchMode, searchPath: string): string[] {
  const args = ['-r']
  if (input['-i']) args.push('-i')
  if (outputMode === 'files_with_matches') args.push('-l')
  if (outputMode === 'count') args.push('-c')
  if (outputMode === 'content' && input['-n'] !== false) args.push('-n')
  if (input.glob) args.push('--include', input.glob)
  for (const directory of EXCLUDED_DIRS) args.push('--exclude-dir', directory)
  args.push('--', input.pattern, searchPath)
  return args
}

function runSearchProcess(command: string, args: string[], signal?: AbortSignal): Promise<SearchProcessResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    let aborted = false
    const finish = (result: SearchProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const kill = (kind: 'timeout' | 'abort') => {
      if (settled) return
      if (kind === 'timeout') timedOut = true
      else aborted = true
      proc.kill()
    }
    const onAbort = () => kill('abort')
    const timer = setTimeout(() => kill('timeout'), SEARCH_TIMEOUT_MS)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    proc.on('error', (error) => finish({ code: null, stdout: '', stderr: '', error, timedOut, aborted }))
    proc.on('close', (code) => finish({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      aborted,
    }))
  })
}
