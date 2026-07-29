import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { resolveLspExecutable } from './registry.js'

let cached: { checkedAt: number; command?: string; running: boolean } | undefined

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
  if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached
  const command = await resolveLspExecutable('lspmux', cwd)
  if (!command) {
    cached = { checkedAt: Date.now(), running: false }
    return cached
  }
  const running = await new Promise<boolean>((resolve) => {
    const child = spawn(command, ['status'], { cwd, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 1_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
  cached = { checkedAt: Date.now(), command, running }
  return cached
}
