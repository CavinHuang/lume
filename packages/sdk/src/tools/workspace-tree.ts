import { isNativeAvailable, nativeListWorkspace } from '@lume/natives'
import { ensurePathAllowed, resolveInputPath } from '../utils/pathing.js'
import { defineTool } from './types.js'

export const ListWorkspaceTreeTool = defineTool({
  name: 'ListWorkspaceTree',
  description: 'List a bounded workspace tree using the native Rust workspace scanner.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace directory to scan (defaults to cwd)' },
      max_depth: { type: 'number', description: 'Maximum tree depth to return (default: 2)' },
      hidden: { type: 'boolean', description: 'Include hidden files and directories' },
      gitignore: { type: 'boolean', description: 'Respect .gitignore files' },
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

    if (!isNativeAvailable()) {
      return { data: 'Native workspace scan is unavailable', is_error: true }
    }

    const options: {
      path: string
      max_depth: number
      hidden?: boolean
      gitignore?: boolean
      collect_agents_md?: boolean
    } = {
      path: searchPath,
      max_depth: input.max_depth ?? 2,
    }
    if (input.hidden !== undefined) options.hidden = input.hidden
    if (input.gitignore !== undefined) options.gitignore = input.gitignore
    if (input.collect_agents_md !== undefined) options.collect_agents_md = input.collect_agents_md

    const result = await nativeListWorkspace(options)
    if (result === null) {
      return { data: 'Native workspace scan is unavailable', is_error: true }
    }

    return {
      data: {
        path: searchPath,
        entries: result.entries,
        agentsMdFiles: result.agents_md_files,
        truncated: result.truncated,
      },
    }
  },
})
