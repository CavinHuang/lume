import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { isNativeAvailable, nativeListWorkspace } from '@lume/natives'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { defineTool } from './types.js'

interface WorkspaceEntry {
  path: string
  file_type: 'file' | 'dir' | 'symlink'
  mtime: number | null
  size: number | null
}

export const ListWorkspaceTreeTool = defineTool({
  name: 'ListWorkspaceTree',
  description: 'List a bounded workspace tree.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace directory to scan (defaults to cwd)' },
      max_depth: { type: 'number', description: 'Maximum tree depth to return (default: 2)' },
      hidden: { type: 'boolean', description: 'Include hidden files and directories' },
      gitignore: { type: 'boolean', description: 'Respect .gitignore files when native scanner is available' },
      collect_agents_md: { type: 'boolean', description: 'Also collect nested AGENTS.md files' },
    },
    required: [],
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

    if (isNativeAvailable()) {
      const result = await nativeListWorkspace({
        path: searchPath,
        max_depth: input.max_depth ?? 2,
        hidden: input.hidden,
        gitignore: input.gitignore,
        collect_agents_md: input.collect_agents_md,
      })

      if (result !== null) {
        return {
          data: {
            path: searchPath,
            entries: result.entries,
            agentsMdFiles: result.agents_md_files,
            truncated: result.truncated,
          },
        }
      }
    }

    const result = await listWorkspaceTree(searchPath, {
      maxDepth: input.max_depth ?? 2,
      hidden: input.hidden ?? false,
      collectAgentsMd: input.collect_agents_md ?? false,
    })

    return {
      data: {
        path: searchPath,
        entries: result.entries,
        agentsMdFiles: result.agentsMdFiles,
        truncated: result.truncated,
      },
    }
  },
})

async function listWorkspaceTree(
  root: string,
  options: { maxDepth: number; hidden: boolean; collectAgentsMd: boolean },
): Promise<{ entries: WorkspaceEntry[]; agentsMdFiles: string[]; truncated: boolean }> {
  const entries: WorkspaceEntry[] = []
  const agentsMdFiles: string[] = []
  let truncated = false
  const maxEntries = 2_000

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || entries.length >= maxEntries) {
      truncated = entries.length >= maxEntries
      return
    }

    let children
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      if (!options.hidden && child.name.startsWith('.')) continue
      if (child.name === 'node_modules' || child.name === 'dist' || child.name === 'target') continue

      const childPath = join(dir, child.name)
      const childStats = await safeStat(childPath)
      const fileType = child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'dir' : 'file'
      entries.push({
        path: childPath,
        file_type: fileType,
        mtime: childStats?.mtimeMs ?? null,
        size: fileType === 'file' ? childStats?.size ?? null : null,
      })

      if (options.collectAgentsMd && child.name === 'AGENTS.md') {
        agentsMdFiles.push(childPath)
      }
      if (child.isDirectory()) {
        await visit(childPath, depth + 1)
      }
    }
  }

  await visit(root, 1)
  return { entries, agentsMdFiles, truncated }
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}
