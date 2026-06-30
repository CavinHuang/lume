import { readdir } from 'fs/promises'
import { join, relative } from 'path'
import { isNativeAvailable, nativeFuzzyFind } from '@lume/natives'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { defineTool } from './types.js'

interface FileMatch {
  path: string
  is_directory: boolean
  score: number
}

export const FindFilesTool = defineTool({
  name: 'FindFiles',
  description: 'Fuzzy-find files and directories by path using Rust native search when available.',
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

    const maxResults = input.max_results ?? 100
    if (isNativeAvailable()) {
      const matches = await nativeFuzzyFind(input.query, searchPath, maxResults)
      if (matches !== null) {
        return {
          data: {
            query: input.query,
            path: searchPath,
            matches,
            total_matches: matches.length,
          },
        }
      }
    }

    const matches = await findMatches(searchPath, String(input.query ?? ''), maxResults)

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

async function findMatches(root: string, query: string, maxResults: number): Promise<FileMatch[]> {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const matches: FileMatch[] = []
  await walk(root, async (entryPath, isDirectory) => {
    const rel = relative(root, entryPath).replace(/\\/g, '/')
    const score = fuzzyScore(normalizedQuery, rel.toLowerCase())
    if (score === null) return
    matches.push({ path: entryPath, is_directory: isDirectory, score })
  })

  return matches
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults)
}

async function walk(
  dir: string,
  visit: (entryPath: string, isDirectory: boolean) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > 16) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const entryPath = join(dir, entry.name)
    const isDirectory = entry.isDirectory()
    await visit(entryPath, isDirectory)
    if (isDirectory) {
      await walk(entryPath, visit, depth + 1)
    }
  }
}

function fuzzyScore(query: string, candidate: string): number | null {
  const exactIndex = candidate.indexOf(query)
  if (exactIndex >= 0) {
    return 10_000 - exactIndex - candidate.length
  }

  let queryIndex = 0
  let spread = 0
  let lastMatch = -1
  for (let candidateIndex = 0; candidateIndex < candidate.length && queryIndex < query.length; candidateIndex += 1) {
    if (candidate[candidateIndex] !== query[queryIndex]) continue
    if (lastMatch >= 0) spread += candidateIndex - lastMatch - 1
    lastMatch = candidateIndex
    queryIndex += 1
  }

  if (queryIndex !== query.length) return null
  return 1_000 - spread - candidate.length
}
