import { type ChildProcess, spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { resolveLspExecutable } from './registry.js'

interface LspmuxProbe {
  checkedAt: number
  command?: string
  running: boolean
}

// Test seam so suites can inject a fake probe process instead of mocking the
// whole node:child_process module (which pollutes every other test in the
// shared bun test process).
type ProbeSpawn = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Pick<ChildProcess, 'once' | 'kill'>
const defaultProbeSpawn: ProbeSpawn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: 'ignore' })
let probeSpawn: ProbeSpawn = defaultProbeSpawn

export function setLspmuxProbeSpawn(impl: ProbeSpawn | undefined): void {
  probeSpawn = impl ?? defaultProbeSpawn
}

// Positive results expire quickly so a stopped daemon is picked up within
// seconds; negative results stick longer because every probe spawns a
// process. The cache is keyed by cwd — probes are per-workspace, so one
// module-wide entry made daemons in other workspaces appear (or vanish)
// wrongly (#374).
let positiveTtlMs = 30_000
let negativeTtlMs = 5 * 60_000
const probes = new Map<string, LspmuxProbe>()

export function setLspmuxCacheTtls(ttls: { positiveMs?: number; negativeMs?: number }): void {
  if (ttls.positiveMs !== undefined) positiveTtlMs = ttls.positiveMs
  if (ttls.negativeMs !== undefined) negativeTtlMs = ttls.negativeMs
}

export function invalidateLspmuxCache(cwd?: string): void {
  if (cwd === undefined) {
    probes.clear()
  } else {
    probes.delete(resolve(cwd))
  }
}

export async function wrapRustAnalyzerWithLspmux(input: {
  command: string
  args: string[]
  cwd: string
  enabled: boolean
}): Promise<{ command: string; args: string[]; env?: Record<string, string>; lspmux: boolean }> {
  if (!input.enabled || basename(input.command).replace(/\.(exe|cmd|bat)$/i, '') !== 'rust-analyzer') {
    return { command: input.command, args: input.args, lspmux: false }
  }
  const state = await detectLspmux(input.cwd)
  if (!state.command || !state.running) return { command: input.command, args: input.args, lspmux: false }
  return {
    command: state.command,
    args: input.args.length > 0 ? ['client', '--', ...input.args] : ['client'],
    env: { LSPMUX_SERVER: input.command },
    lspmux: true,
  }
}

async function detectLspmux(cwd: string): Promise<{ command?: string; running: boolean }> {
  const key = resolve(cwd)
  const cached = probes.get(key)
  if (cached && Date.now() - cached.checkedAt < (cached.running ? positiveTtlMs : negativeTtlMs)) return cached
  const command = await resolveLspExecutable('lspmux', cwd)
  if (!command) {
    const next: LspmuxProbe = { checkedAt: Date.now(), running: false }
    probes.set(key, next)
    return next
  }
  const running = await new Promise<boolean>((resolvePromise) => {
    const child = probeSpawn(command, ['status'], { cwd })
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise(false)
    }, 1_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolvePromise(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code === 0)
    })
  })
  const next: LspmuxProbe = { checkedAt: Date.now(), command, running }
  probes.set(key, next)
  return next
}
