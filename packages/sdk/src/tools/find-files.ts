import { isNativeAvailable, nativeFuzzyFind } from '@lume/natives'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { defineTool } from './types.js'

export const FindFilesTool = defineTool({
  name: 'FindFiles',
  description: 'Fuzzy-find files and directories by path using the native Rust file indexer.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Fuzzy query to match against file paths' },
      path: { type: 'string', description: 'Directory to search in (defaults to cwd)' },
      max_results: { type: 'number', description: 'Maximum number of matches to return (default: 100)' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchPath = input.path
      ? await resolveInputPath(context.cwd, input.path, context.additionalDirectories)
      : context.cwd
    const sandboxError = ensurePathAllowed(
      searchPath,
      'read',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) return { data: sandboxError, is_error: true }

    if (!isNativeAvailable()) {
      return { data: 'Native fuzzy find is unavailable', is_error: true }
    }

    const matches = await nativeFuzzyFind(input.query, searchPath, input.max_results ?? 100)
    if (matches === null) {
      return { data: 'Native fuzzy find is unavailable', is_error: true }
    }

    return {
      data: {
        query: input.query,
        path: searchPath,
        matches,
        total_matches: matches.length,
      },
    }
  },
})
