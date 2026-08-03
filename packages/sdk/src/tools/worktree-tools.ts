/**
 * Git worktree tools and shared lifecycle helpers.
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../types.js'

export interface ManagedWorktree {
  id: string
  path: string
  branch: string
  originalCwd: string
  repoRoot?: string
  createdAt?: string
}

const activeWorktrees = new Map<string, ManagedWorktree>()
const registryPath = join(homedir(), '.lume', 'coding-worktrees.json')

function loadRegistry(): ManagedWorktree[] {
  try {
    const value = JSON.parse(readFileSync(registryPath, 'utf8'))
    return Array.isArray(value) ? value.filter(isManagedWorktree) : []
  } catch {
    return []
  }
}

function saveRegistry(worktrees: ManagedWorktree[]): void {
  mkdirSync(dirname(registryPath), { recursive: true })
  const temporary = `${registryPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(worktrees, null, 2), 'utf8')
  renameSync(temporary, registryPath)
}

function isManagedWorktree(value: unknown): value is ManagedWorktree {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ManagedWorktree>
  return typeof item.id === 'string'
    && typeof item.path === 'string'
    && typeof item.branch === 'string'
    && typeof item.originalCwd === 'string'
}

function assertValidBranch(branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.endsWith('.lock')) {
    throw new Error('Invalid worktree branch name')
  }
}

function resolveRepositoryRoot(cwd: string): string {
  return resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim())
}

function assertWorktreePath(repoRoot: string, worktreePath: string): void {
  const relativePath = relative(repoRoot, worktreePath)
  if (!relativePath || (!relativePath.startsWith('..' + '\\') && !relativePath.startsWith('../') && !isAbsolute(relativePath))) {
    throw new Error('Worktree path must be outside the main repository')
  }
}

function isWorktreeDirty(path: string): boolean {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: path, stdio: 'pipe', encoding: 'utf8' }).trim().length > 0
}

export function createManagedWorktree(input: {
  cwd: string
  branch?: string
  path?: string
}): ManagedWorktree {
  const originalCwd = resolve(input.cwd)
  const repoRoot = resolveRepositoryRoot(originalCwd)

  const branch = input.branch || `lume-worktree-${Date.now()}`
  assertValidBranch(branch)
  const worktreePath = resolve(input.path || join(originalCwd, '..', `.worktree-${branch}`))
  assertWorktreePath(repoRoot, worktreePath)

  const existing = [...activeWorktrees.values(), ...loadRegistry()].find((item) => item.branch === branch || item.path === worktreePath)
  if (existing && existsSync(existing.path)) {
    activeWorktrees.set(existing.id, existing)
    return existing
  }
  if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`)

  try {
    execFileSync('git', ['branch', branch], { cwd: repoRoot, stdio: 'pipe' })
  } catch {
    // The branch may already exist; worktree add will report the real error.
  }
  execFileSync('git', ['worktree', 'add', worktreePath, branch], {
    cwd: repoRoot,
    stdio: 'pipe',
  })

  const worktree: ManagedWorktree = {
    id: crypto.randomUUID(),
    path: worktreePath,
    branch,
    originalCwd,
    repoRoot,
    createdAt: new Date().toISOString(),
  }
  activeWorktrees.set(worktree.id, worktree)
  saveRegistry([...loadRegistry().filter((item) => item.id !== worktree.id), worktree])
  return worktree
}

export function getManagedWorktree(id: string): ManagedWorktree | undefined {
  const active = activeWorktrees.get(id)
  if (active) return active
  const persisted = loadRegistry().find((item) => item.id === id)
  if (persisted && existsSync(persisted.path)) {
    activeWorktrees.set(id, persisted)
    return persisted
  }
  return undefined
}

export function removeManagedWorktree(id: string, keep = false): ManagedWorktree | undefined {
  const worktree = activeWorktrees.get(id)
  if (!worktree) return undefined
  if (keep) return worktree

  if (!existsSync(worktree.path)) {
    activeWorktrees.delete(id)
    saveRegistry(loadRegistry().filter((item) => item.id !== id))
    return worktree
  }
  if (isWorktreeDirty(worktree.path)) throw new Error('Worktree has uncommitted or untracked changes; keep it or clean it explicitly before removal')
  execFileSync('git', ['worktree', 'remove', worktree.path], {
    cwd: worktree.repoRoot ?? worktree.originalCwd,
    stdio: 'pipe',
  })
  activeWorktrees.delete(id)
  saveRegistry(loadRegistry().filter((item) => item.id !== id))
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
