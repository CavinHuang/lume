import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import type { AgentOptions, SettingSource } from '../types.js'

export interface LoadedSettingsSource {
  source: SettingSource
  path: string
  settings: Partial<AgentOptions> & Record<string, unknown>
}

function resolveUserConfigDir(): string {
  const configured = process.env.LUME_CONFIG_DIR?.trim()
  if (!configured) return join(homedir(), '.lume')
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
}

export function getSettingsFileForSource(cwd: string, source: SettingSource): string {
  switch (source) {
    // 'user' must not mirror 'project' (same cwd file read twice) — the
    // user-level settings source would never load (#230). It honors
    // LUME_CONFIG_DIR like every other user-level path in the SDK (#291).
    case 'user':
      return join(resolveUserConfigDir(), 'settings.json')
    case 'project':
      return join(cwd, 'settings.json')
    case 'local':
      return join(cwd, 'settings.local.json')
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
    } catch (error) {
      // A missing file simply means no settings at that level and stays silent.
      // Anything else (corrupt JSON, permissions) must not fail open quietly (#354).
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(
          `[settings] Ignoring unreadable settings file ${filePath}: ${(error as Error)?.message ?? error}`,
        )
      }
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


