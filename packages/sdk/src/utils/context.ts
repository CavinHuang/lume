/**
 * System & User Context
 *
 * Builds context for the system prompt:
 * - Git status injection (branch, commits, status)
 * - AGENT.md / project context discovery and injection
 * - Working directory info
 * - Date injection
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

const execAsync = promisify(exec)

// Memoization cache
let cachedGitStatus: string | null = null
let cachedGitStatusCwd: string | null = null

/**
 * Get git status info for system prompt.
 * Memoized per cwd (cleared on new session).
 */
export async function getGitStatus(cwd: string): Promise<string> {
  if (cachedGitStatus && cachedGitStatusCwd === cwd) {
    return cachedGitStatus
  }

  try {
    const parts: string[] = []

    // Async since this runs while building the first system prompt: the sync
    // version froze every IPC request on the shared sidecar loop (#243).
    const gitExec = async (cmd: string, timeoutMs = 5000): Promise<string | null> => {
      try {
        const { stdout } = await execAsync(cmd, {
          cwd, timeout: timeoutMs, encoding: 'utf-8',
        })
        return stdout.trim()
      } catch {
        return null
      }
    }

    // Check if this is a git repo at all
    if (!await gitExec('git rev-parse --git-dir')) return ''

    // Current branch
    const branch = await gitExec('git rev-parse --abbrev-ref HEAD')
    if (branch) parts.push(`Current branch: ${branch}`)

    // Main branch detection
    const mainBranch = await detectMainBranch(cwd)
    if (mainBranch) parts.push(`Main branch: ${mainBranch}`)

    // Git user
    const user = await gitExec('git config user.name', 3000)
    if (user) parts.push(`Git user: ${user}`)

    // Status (staged + unstaged)
    const status = await gitExec('git status --short')
    if (status) {
      const truncated = status.length > 2000
        ? status.slice(0, 2000) + '\n...(truncated)'
        : status
      parts.push(`Status:\n${truncated}`)
    }

    // Recent commits (only if HEAD exists)
    const hasHead = await gitExec('git rev-parse HEAD')
    if (hasHead) {
      const log = await gitExec('git log --oneline -5 --no-decorate')
      if (log) parts.push(`Recent commits:\n${log}`)
    }

    cachedGitStatus = parts.join('\n\n')
    cachedGitStatusCwd = cwd

    return cachedGitStatus
  } catch {
    return ''
  }
}

/**
 * Detect the main branch name (main or master).
 */
async function detectMainBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git branch -l main master', {
      cwd, timeout: 3000, encoding: 'utf-8',
    })
    const branches = stdout.trim()
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    return null
  } catch {
    return null
  }
}

/**
 * Discover project context files (AGENT.md, CLAUDE.md) in the project.
 */
export async function discoverProjectContextFiles(cwd: string): Promise<string[]> {
  const candidates = [
    join(cwd, 'AGENT.md'),
  ]

  const found: string[] = []
  for (const path of candidates) {
    try {
      const s = await stat(path)
      if (s.isFile()) {
        found.push(path)
      }
    } catch {
      // File doesn't exist
    }
  }

  return found
}

/**
 * Read project context file content from discovered files.
 */
export async function readProjectContextContent(cwd: string): Promise<string> {
  const files = await discoverProjectContextFiles(cwd)
  if (files.length === 0) return ''

  const parts: string[] = []
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8')
      if (content.trim()) {
        parts.push(`# From ${file}:\n${content.trim()}`)
      }
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n\n')
}

/**
 * Get system context for the system prompt.
 */
export async function getSystemContext(cwd: string): Promise<string> {
  const parts: string[] = []

  const gitStatus = await getGitStatus(cwd)
  if (gitStatus) {
    parts.push(`gitStatus: ${gitStatus}`)
  }

  return parts.join('\n\n')
}

/**
 * Get user context (AGENT.md, date, etc).
 */
export async function getUserContext(cwd: string): Promise<string> {
  const parts: string[] = []

  // Current date
  parts.push(`# currentDate\nToday's date is ${new Date().toISOString().split('T')[0]}.`)

  // Project context files
  const projectCtx = await readProjectContextContent(cwd)
  if (projectCtx) {
    parts.push(projectCtx)
  }

  return parts.join('\n\n')
}

/**
 * Clear memoized context (call between sessions).
 */
export function clearContextCache(): void {
  cachedGitStatus = null
  cachedGitStatusCwd = null
}
