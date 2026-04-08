import { readFile, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import type { AgentOptions, SettingSource } from '../types.js'

export interface LoadedSettingsSource {
  source: SettingSource
  path: string
  settings: Partial<AgentOptions> & Record<string, unknown>
}

function getSettingsFileForSource(cwd: string, source: SettingSource): string {
  const home = process.env.HOME || process.env.USERPROFILE || cwd
  switch (source) {
    case 'user':
      return join(home, '.claude', 'settings.json')
    case 'project':
      return join(cwd, '.claude', 'settings.json')
    case 'local':
      return join(cwd, '.claude', 'settings.local.json')
  }
}

export async function loadSettingsFromSources(
  cwd: string,
  sources: SettingSource[] = [],
): Promise<LoadedSettingsSource[]> {
  const loaded: LoadedSettingsSource[] = []

  for (const source of sources) {
    const filePath = getSettingsFileForSource(cwd, source)
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(content) as Partial<AgentOptions> & Record<string, unknown>
      loaded.push({ source, path: filePath, settings: parsed })
    } catch {
      // Missing or invalid settings files are ignored by design.
    }
  }

  return loaded
}

function mergeValue(current: unknown, next: unknown): unknown {
  if (Array.isArray(next)) return [...next]
  if (
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    next &&
    typeof next === 'object' &&
    !Array.isArray(next)
  ) {
    return mergeRecord(
      current as Record<string, unknown>,
      next as Record<string, unknown>,
    )
  }
  return next
}

function mergeRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = mergeValue(out[key], value)
  }
  return out
}

export function mergeAgentOptions(
  base: AgentOptions,
  patches: Array<Partial<AgentOptions> & Record<string, unknown>>,
): AgentOptions {
  let merged = { ...base } as Record<string, unknown>
  for (const patch of patches) {
    merged = mergeRecord(merged, patch as Record<string, unknown>)
  }
  return merged as AgentOptions
}

// --------------------------------------------------------------------------
// CLAUDE.md Loading
// --------------------------------------------------------------------------

export type ClaudeMdMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

export interface LoadedClaudeMd {
  path: string
  content: string
  memoryType: ClaudeMdMemoryType
}

/**
 * Load CLAUDE.md files from the standard hierarchy:
 * 1. User:    ~/.claude/CLAUDE.md
 * 2. Project: <cwd>/CLAUDE.md, <cwd>/.claude/CLAUDE.md, <cwd>/.claude/rules/*.md
 * 3. Local:   <cwd>/CLAUDE.local.md
 *
 * Files closer to cwd have higher priority (loaded last = higher precedence).
 * Returns loaded files in ascending priority order.
 */
export async function loadClaudeMdFiles(cwd: string): Promise<LoadedClaudeMd[]> {
  const loaded: LoadedClaudeMd[] = []
  const home = process.env.HOME || process.env.USERPROFILE || cwd

  // 1. User-level: ~/.claude/CLAUDE.md
  const userMd = join(home, '.claude', 'CLAUDE.md')
  const userContent = await tryReadFile(userMd)
  if (userContent !== null) {
    loaded.push({ path: userMd, content: userContent, memoryType: 'User' })
  }

  // 2. Project-level: CLAUDE.md in cwd
  const projectMd = join(cwd, 'CLAUDE.md')
  const projectContent = await tryReadFile(projectMd)
  if (projectContent !== null) {
    loaded.push({ path: projectMd, content: projectContent, memoryType: 'Project' })
  }

  // 3. Project-level: .claude/CLAUDE.md in cwd
  const dotClaudeMd = join(cwd, '.claude', 'CLAUDE.md')
  const dotClaudeContent = await tryReadFile(dotClaudeMd)
  if (dotClaudeContent !== null) {
    loaded.push({ path: dotClaudeMd, content: dotClaudeContent, memoryType: 'Project' })
  }

  // 4. Project-level: .claude/rules/*.md
  const rulesDir = join(cwd, '.claude', 'rules')
  const ruleFiles = await tryListMdFiles(rulesDir)
  for (const ruleFile of ruleFiles) {
    const ruleContent = await tryReadFile(ruleFile)
    if (ruleContent !== null) {
      loaded.push({ path: ruleFile, content: ruleContent, memoryType: 'Project' })
    }
  }

  // 5. Local: CLAUDE.local.md in cwd (highest project priority)
  const localMd = join(cwd, 'CLAUDE.local.md')
  const localContent = await tryReadFile(localMd)
  if (localContent !== null) {
    loaded.push({ path: localMd, content: localContent, memoryType: 'Local' })
  }

  return loaded
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function tryListMdFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath)
    return entries
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => resolve(dirPath, name))
  } catch {
    return []
  }
}

