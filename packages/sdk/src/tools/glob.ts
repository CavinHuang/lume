/**
 * GlobTool - File pattern matching
 */

import { defineTool } from './types.js'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { isNativeAvailable, nativeGlob } from '@lume/natives'
import { stat } from 'fs/promises'
import { isAbsolute, join } from 'path'

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
        // pattern 显式点名点段（.env*、**\/.github\/**）时豁免隐藏过滤——
        // 模型明确要找的就是隐藏文件（#711 follow-up）
        const wantsHidden = pattern.split(/[\\/]/).some((segment: string) =>
          segment.startsWith('.') && segment.length > 1)
        const matches: string[] = []
        let truncated = false
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir, signal: context.abortSignal })) {
          // 与 native 对齐：默认跳过隐藏文件/目录（#538）
          if (!wantsHidden && entry.split(/[\\/]/).some((segment: string) => segment.startsWith('.'))) continue
          matches.push(entry)
          if (matches.length > 500) {
            truncated = true
            matches.pop()
            break
          }
        }
        // 与 native 对齐：mtime 排序是描述承诺的行为（#538）。
        // 截断时排序已无意义（非全量），保持收集序。
        // stat 上限 200：natives 缺失环境下全量 stat 是可感知的 IO 风暴；
        // ponytail ceiling——超出部分保持收集序，如需精确排序改 native 侧
        if (!truncated && matches.length > 1) {
          const head = matches.slice(0, 200)
          const paired = await Promise.all(head.map(async (entry) => ({
            entry,
            mtime: await stat(isAbsolute(entry) ? entry : join(searchDir, entry))
              .then((item) => item.mtimeMs)
              .catch(() => 0),
          })))
          paired.sort((left, right) => right.mtime - left.mtime)
          for (let i = 0; i < paired.length; i++) matches[i] = paired[i]!.entry
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
