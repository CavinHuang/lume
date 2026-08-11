import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeAgentIslandEvent, NativeAgentIslandSnapshot } from '../../../packages/shared/src/types/agent-island'

const PROTOCOL = 1
const READY_TIMEOUT_MS = 4_000

export interface MacAgentIslandNativeHostOptions {
  onReady: () => void
  onEvent: (event: NativeAgentIslandEvent) => void
  /** helper 缺失/协议不符/运行中退出时调用方应启用 Electron fallback。 */
  onUnavailable: (reason: string) => void
}

let child: ChildProcessWithoutNullStreams | null = null
let ready = false
let closing = false
let readyTimer: ReturnType<typeof setTimeout> | null = null
let stdoutBuffer = ''

function helperPath(): string {
  // main 进程产物为 ESM（dist/main/main.mjs），ESM 作用域没有 __dirname，需用 import.meta.url 推导目录。
  // dist/main/ 上溯两级得到 apps/desktop/，再拼 resources/agent-island/。
  return app.isPackaged
    ? join(process.resourcesPath, 'agent-island', 'macos-agent-island-helper')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'agent-island', 'macos-agent-island-helper')
}

function clearReadyTimer(): void {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
}

function parseEvent(line: string): NativeAgentIslandEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return null
    const e = value as Record<string, unknown>
    if (e.type === 'ready' && typeof e.protocol === 'number') return { type: 'ready', protocol: e.protocol as 1 }
    if (e.type === 'fatal' && typeof e.message === 'string') return { type: 'fatal', message: e.message }
    if (e.type !== 'intent' || typeof e.name !== 'string') return null
    // Lume 协议：set-expanded/set-hovered 用 value(boolean)；open-session 用 threadId
    if (e.name === 'set-expanded' && typeof e.value === 'boolean') return { type: 'intent', name: 'set-expanded', value: e.value }
    if (e.name === 'set-hovered' && typeof e.value === 'boolean') return { type: 'intent', name: 'set-hovered', value: e.value }
    if (e.name === 'open-session' && typeof e.threadId === 'string' && e.threadId.length > 0)
      return { type: 'intent', name: 'open-session', threadId: e.threadId }
    if (e.name === 'open-main' || e.name === 'open-planning' || e.name === 'dismiss')
      return { type: 'intent', name: e.name }
    return null
  } catch {
    return null
  }
}

function write(message: unknown): boolean {
  if (!child || child.killed || child.stdin.destroyed) return false
  try { child.stdin.write(`${JSON.stringify(message)}\n`); return true } catch { return false }
}

export function startMacAgentIslandNativeHost(options: MacAgentIslandNativeHostOptions): boolean {
  if (process.platform !== 'darwin') return false
  if (child && !child.killed) return true
  const path = helperPath()
  if (!existsSync(path)) { options.onUnavailable(`native helper missing: ${path}`); return false }

  closing = false; ready = false; stdoutBuffer = ''
  try {
    child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
  } catch (error) {
    child = null
    options.onUnavailable(`failed to spawn: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  const current = child
  readyTimer = setTimeout(() => {
    if (current !== child || ready) return
    options.onUnavailable('native helper did not report ready before timeout')
    disposeMacAgentIslandNativeHost()
  }, READY_TIMEOUT_MS)

  current.stdout.setEncoding('utf8')
  current.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line) {
        const event = parseEvent(line)
        if (event?.type === 'ready') {
          if (event.protocol !== PROTOCOL) {
            options.onUnavailable(`unsupported protocol: ${event.protocol}`)
            disposeMacAgentIslandNativeHost()
          } else if (!ready) {
            ready = true; clearReadyTimer(); options.onReady()
          }
        } else if (event?.type === 'fatal') {
          disposeMacAgentIslandNativeHost()
          options.onUnavailable(`native helper fatal: ${event.message}`)
        } else if (event) {
          options.onEvent(event)
        }
      }
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  current.stderr.setEncoding('utf8')
  current.stderr.on('data', (chunk: string) => console.warn(`[agent-island:native] ${chunk.trim()}`))
  current.once('error', (error) => {
    if (current !== child || closing) return
    options.onUnavailable(`process error: ${error.message}`)
  })
  current.once('exit', (code, signal) => {
    if (current !== child) return
    const wasReady = ready
    child = null; ready = false; clearReadyTimer()
    if (!closing) options.onUnavailable(`exited (${wasReady ? 'after ready, ' : ''}code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
  })
  return true
}

export function isMacAgentIslandNativeHostReady(): boolean {
  return ready && child !== null && !child.killed
}

export function publishMacAgentIslandSnapshot(snapshot: NativeAgentIslandSnapshot): boolean {
  if (!isMacAgentIslandNativeHostReady()) return false
  return write(snapshot)
}

export function disposeMacAgentIslandNativeHost(): void {
  closing = true; clearReadyTimer()
  const current = child
  if (!current || current.killed) { child = null; ready = false; stdoutBuffer = ''; return }
  const stdin = current.stdin
  if (stdin && !stdin.destroyed) {
    stdin.on('error', () => { /* helper 已退出，忽略 EPIPE */ })
    try { if (stdin.writable) stdin.write('{"type":"shutdown"}\n') } catch { /* closing */ }
    stdin.end()
  }
  child = null; ready = false; stdoutBuffer = ''
  const forceTimer = setTimeout(() => { if (!current.killed) current.kill('SIGTERM') }, 800)
  current.once('exit', () => clearTimeout(forceTimer))
}
