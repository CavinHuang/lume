/**
 * Git worktree tools and shared lifecycle helpers.
 */

import { execFileSync } from 'child_process'
import { join, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../types.js'

export interface ManagedWorktree {
  id: string
  path: string
  branch: string
  originalCwd: string
}

const activeWorktrees = new Map<string, ManagedWorktree>()

export function createManagedWorktree(input: {
  cwd: string
  branch?: string
  path?: string
}): ManagedWorktree {
  const originalCwd = resolve(input.cwd)
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: originalCwd, stdio: 'pipe' })

  const branch = input.branch || `lume-worktree-${Date.now()}`
  const worktreePath = resolve(input.path || join(originalCwd, '..', `.worktree-${branch}`))
  try {
    execFileSync('git', ['branch', branch], { cwd: originalCwd, stdio: 'pipe' })
  } catch {
    // The branch may already exist; worktree add will report the real error.
  }
  execFileSync('git', ['worktree', 'add', worktreePath, branch], {
    cwd: originalCwd,
    stdio: 'pipe',
  })

  const worktree: ManagedWorktree = {
    id: crypto.randomUUID(),
    path: worktreePath,
    branch,
    originalCwd,
  }
  activeWorktrees.set(worktree.id, worktree)
  return worktree
}

export function getManagedWorktree(id: string): ManagedWorktree | undefined {
  return activeWorktrees.get(id)
}

export function removeManagedWorktree(id: string, keep = false): ManagedWorktree | undefined {
  const worktree = activeWorktrees.get(id)
  if (!worktree) return undefined
  if (keep) return worktree

  execFileSync('git', ['worktree', 'remove', worktree.path, '--force'], {
    cwd: worktree.originalCwd,
    stdio: 'pipe',
  })
  try {
    execFileSync('git', ['branch', '-D', worktree.branch], {
      cwd: worktree.originalCwd,
      stdio: 'pipe',
    })
  } catch {
    // Keep the worktree cleanup successful when a branch has already moved.
  }
  activeWorktrees.delete(id)
  return worktree
}

export const EnterWorktreeTool: ToolDefinition = {
  name: 'EnterWorktree',
  description: 'Create an isolated git worktree for parallel work.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name for the worktree' },
      path: { type: 'string', description: 'Path for the worktree' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create an isolated git worktree for parallel work.' },
  async call(input: any, context: { cwd: string; setWorkingDirectory?: (cwd: string) => void }): Promise<ToolResult> {
    try {
      const worktree = createManagedWorktree({ cwd: context.cwd, branch: input.branch, path: input.path })
      context.setWorkingDirectory?.(worktree.path)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree created:\n  ID: ${worktree.id}\n  Path: ${worktree.path}\n  Branch: ${worktree.branch}`,
        _meta: { worktree },
      }
    } catch (err: any) {
      return { type: 'tool_result', tool_use_id: '', content: `Error creating worktree: ${err.message}`, is_error: true }
    }
  },
}

export const ExitWorktreeTool: ToolDefinition = {
  name: 'ExitWorktree',
  description: 'Exit and optionally remove a git worktree.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Worktree ID' },
      action: { type: 'string', enum: ['keep', 'remove'], description: 'Whether to keep or remove the worktree' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit a git worktree.' },
  async call(input: any, context: { setWorkingDirectory?: (cwd: string) => void }): Promise<ToolResult> {
    const worktree = getManagedWorktree(input.id)
    if (!worktree) return { type: 'tool_result', tool_use_id: '', content: `Worktree not found: ${input.id}`, is_error: true }
    try {
      const keep = input.action === 'keep'
      if (!keep) removeManagedWorktree(input.id)
      else removeManagedWorktree(input.id, true)
      context.setWorkingDirectory?.(worktree.originalCwd)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree ${keep ? 'kept' : 'removed'}: ${worktree.path}`,
        _meta: { worktree: { ...worktree, retained: keep } },
      }
    } catch (err: any) {
      return { type: 'tool_result', tool_use_id: '', content: `Error: ${err.message}`, is_error: true }
    }
  },
}
