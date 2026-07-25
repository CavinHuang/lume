import { spawnSync } from 'node:child_process'

let discoveredWindowsBashPath: string | null | undefined

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

    const windowsCommand = withPowerShellDefaults(command)
    return {
      command: env.ComSpec || env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', withWindowsUtf8(windowsCommand)],
    }
  }
  return { command: 'bash', args: ['-c', command] }
}

function withPowerShellDefaults(command: string): string {
  const match = command.match(/^(\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?))(\s|$)/i)
  if (!match) return command
  const shell = match[1]
  if (!shell) return command
  const flags = [
    /\s-(?:noprofile|nop)\b/i.test(command) ? undefined : '-NoProfile',
    /\s-(?:noninteractive|ni)\b/i.test(command) ? undefined : '-NonInteractive',
  ].filter((flag): flag is string => Boolean(flag))
  return flags.length > 0 ? `${shell} ${flags.join(' ')}${command.slice(shell.length)}` : command
}

function withWindowsUtf8(command: string): string {
  // cmd.exe uses the active system code page for built-in commands. Switch
  // this child shell to UTF-8 so stdout/stderr can be decoded reliably.
  return `chcp 65001>nul & ${command}`
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
