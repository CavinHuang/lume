import { spawnSync } from 'node:child_process'

let discoveredWindowsBashPath: string | null | undefined

/**
 * Classify a resolved shell executable. Shared so every caller that builds
 * shell command lines agrees on which dialect will actually run them (#328).
 */
export function shellKind(shellCommand: string): 'bash' | 'powershell' {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shellCommand) ? 'powershell' : 'bash'
}

export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    const bashPath = resolveWindowsBashPath(env)
    if (bashPath) {
      return { command: bashPath, args: ['-c', command] }
    }

    const powershellPath = env.LUME_POWERSHELL_PATH || env.LUME_PWSH_PATH || 'powershell.exe'
    return {
      command: powershellPath,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', withPowerShellUtf8(command)],
    }
  }
  return { command: 'bash', args: ['-c', command] }
}

function withPowerShellUtf8(command: string): string {
  return '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ' + command
}

function resolveWindowsBashPath(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.LUME_BASH_PATH || env.CLAUDE_CODE_SHELL || env.SHELL
  const configuredShell = normalizeBashPath(configured)
  if (configuredShell) return configuredShell

  // Keep callers that provide an explicit environment deterministic.
  if (env !== process.env) return undefined
  if (discoveredWindowsBashPath !== undefined) return discoveredWindowsBashPath || undefined

  const result = spawnSync('where.exe', ['bash.exe'], {
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    discoveredWindowsBashPath = null
    return undefined
  }

  for (const candidate of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const probe = spawnSync(candidate, ['--version'], {
      timeout: 1_000,
      windowsHide: true,
      stdio: 'ignore',
    })
    if (probe.status === 0) {
      discoveredWindowsBashPath = candidate
      return candidate
    }
  }
  discoveredWindowsBashPath = null
  return undefined
}

function normalizeBashPath(value: string | undefined): string | undefined {
  const shell = value?.trim()
  if (!shell || !/(?:^|[\\/])(?:bash|zsh)(?:\.exe)?$/i.test(shell)) return undefined
  // /bin/bash is common in POSIX environments but is not a native Windows
  // executable path. Let Windows resolve bash.exe through PATH instead.
  if (shell.startsWith('/')) return shell.toLowerCase().endsWith('/zsh') ? 'zsh.exe' : 'bash.exe'
  return shell
}
