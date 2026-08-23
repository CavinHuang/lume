import { spawnSync } from 'node:child_process'

// Windows bash discovery outcome: string = found, null = definitively absent,
// undefined = not settled yet. A timed-out lookup must stay "not settled" so a
// later call retries instead of freezing the PowerShell fallback for the rest
// of the process (#471 follow-up).
let discoveredWindowsBashPath: string | null | undefined
let indeterminateDiscoveryRounds = 0

// Bound the retry loop: a permanently wedged where.exe must not tax every
// shell resolution forever. After this many consecutive indeterminate rounds
// we settle on "absent" like any other machine fact.
const MAX_INDETERMINATE_DISCOVERY_ROUNDS = 3

type SpawnSync = typeof spawnSync

/**
 * Classify a resolved shell executable. Shared so every caller that builds
 * shell command lines agrees on which dialect will actually run them (#328).
 */
export function shellKind(shellCommand: string): 'bash' | 'powershell' {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shellCommand) ? 'powershell' : 'bash'
}

/**
 * Shell dialect without triggering Windows bash discovery (#471): permission
 * decisions must not depend on whether a 1s spawnSync probe settles in time.
 * Unsettled discovery reads as bash so callers fail closed; execution keeps
 * using resolveShellInvocation, which performs discovery once and caches it.
 */
export function shellKindWithoutDiscovery(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): 'bash' | 'powershell' {
  if (platform !== 'win32') return 'bash'
  const configured = normalizeBashPath(env.LUME_BASH_PATH || env.CLAUDE_CODE_SHELL || env.SHELL)
  if (configured) return 'bash'
  // Explicit environment mirrors resolveShellInvocation's PowerShell fallback.
  if (env !== process.env) return 'powershell'
  if (discoveredWindowsBashPath !== undefined) return discoveredWindowsBashPath ? 'bash' : 'powershell'
  return 'bash'
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
  const configuredShell = normalizeBashPath(env.LUME_BASH_PATH || env.CLAUDE_CODE_SHELL || env.SHELL)
  if (configuredShell) return configuredShell

  // Keep callers that provide an explicit environment deterministic.
  if (env !== process.env) return undefined
  return discoverWindowsBashPath()
}

/**
 * @internal Test seam: run discovery with injectable probes. Production
 * callers go through {@link resolveShellInvocation}.
 */
export function discoverWindowsBashPath(where: SpawnSync = spawnSync, probe: SpawnSync = spawnSync): string | undefined {
  if (discoveredWindowsBashPath !== undefined) return discoveredWindowsBashPath || undefined

  const result = where('where.exe', ['bash.exe'], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // A timed-out or failed-to-launch lookup is "unknown", not "absent": leave
  // the cache unsettled so a later call retries instead of freezing the
  // PowerShell fallback for the rest of the process (#471 follow-up).
  if (result.error || result.status === null) {
    indeterminateDiscoveryRounds += 1
    if (indeterminateDiscoveryRounds >= MAX_INDETERMINATE_DISCOVERY_ROUNDS) {
      settleDiscovery(null)
    }
    return undefined
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    settleDiscovery(null)
    return undefined
  }

  let sawIndeterminateProbe = false
  for (const candidate of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const probeResult = probe(candidate, ['--version'], {
      timeout: 3_000,
      windowsHide: true,
      stdio: 'ignore',
    })
    if (probeResult.status === 0) {
      settleDiscovery(candidate)
      return candidate
    }
    if (probeResult.error || probeResult.status === null) sawIndeterminateProbe = true
  }
  // Only "listed but every probe definitively failed" counts as absent; an
  // interrupted probe round stays open for retry.
  if (!sawIndeterminateProbe) {
    settleDiscovery(null)
  }
  return undefined
}

/** @internal Test seam: reset cached discovery state between cases. */
export function resetWindowsBashDiscoveryForTests(): void {
  discoveredWindowsBashPath = undefined
  indeterminateDiscoveryRounds = 0
}

/** @internal Test seam: whether discovery has settled (path found or absent). */
export function windowsBashDiscoverySettledForTests(): boolean {
  return discoveredWindowsBashPath !== undefined
}

function settleDiscovery(outcome: string | null): void {
  discoveredWindowsBashPath = outcome
  indeterminateDiscoveryRounds = 0
}

function normalizeBashPath(value: string | undefined): string | undefined {
  const shell = value?.trim()
  if (!shell || !/(?:^|[\\/])(?:bash|zsh)(?:\.exe)?$/i.test(shell)) return undefined
  // /bin/bash is common in POSIX environments but is not a native Windows
  // executable path. Let Windows resolve bash.exe through PATH instead.
  if (shell.startsWith('/')) return shell.toLowerCase().endsWith('/zsh') ? 'zsh.exe' : 'bash.exe'
  return shell
}
