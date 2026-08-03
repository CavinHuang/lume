import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { SandboxSettings } from '../types.js'

export interface RipgrepInvocation {
  command: string
  args: string[]
  source: 'configured' | 'bundled' | 'system'
  executableDirectory?: string
}

/** Resolve the rg executable without making installed desktop paths part of the SDK API. */
export function resolveRipgrepInvocation(sandbox?: SandboxSettings, env: NodeJS.ProcessEnv = process.env): RipgrepInvocation {
  const configured = sandbox?.ripgrep
  if (configured?.command?.trim()) {
    return {
      command: configured.command.trim(),
      args: configured.args ?? [],
      source: 'configured',
    }
  }

  const bundled = env.LUME_RIPGREP_PATH?.trim()
  if (bundled && existsSync(bundled)) {
    return {
      command: bundled,
      args: [],
      source: 'bundled',
      executableDirectory: dirname(bundled),
    }
  }

  return { command: 'rg', args: [], source: 'system' }
}

export function bundledRipgrepDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bundled = env.LUME_RIPGREP_PATH?.trim()
  return bundled && existsSync(bundled) && /^rg(?:\.exe)?$/i.test(basename(bundled))
    ? dirname(bundled)
    : undefined
}
