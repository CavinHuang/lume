import { existsSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { spawn as spawnProcess } from 'node:child_process'
import { createDesktopHostSpawnConfig } from './sidecar-process'

export type DesktopHostState =
  | { available: true; endpoint: string; token: string }
  | { available: false; reason: string }

interface DesktopHostSupervisorOptions {
  binaryPath: string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  spawn?: typeof spawnProcess
  id?: () => string
  token?: () => string
  baseEnv?: NodeJS.ProcessEnv
  log?: (message: string) => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

interface DesktopHostEndpointOptions {
  platform?: NodeJS.Platform
  id?: string
  tempDir?: string
}

export interface DesktopHostSupervisor {
  start(): Promise<DesktopHostState>
  stop(): void
  getState(): DesktopHostState | null
}

export function createDesktopHostEndpoint({
  platform = process.platform,
  id = randomUUID(),
  tempDir = tmpdir(),
}: DesktopHostEndpointOptions = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\lume-desktop-${id}`
  if (platform === 'darwin') return posix.join(tempDir.replaceAll('\\', '/'), `lume-desktop-${id}.sock`)
  throw new Error(`unsupported desktop host platform: ${platform}`)
}

export function createDesktopHostSupervisor({
  binaryPath,
  platform = process.platform,
  exists = existsSync,
  spawn = spawnProcess,
  id = randomUUID,
  token = () => randomBytes(32).toString('base64url'),
  baseEnv = process.env,
  log = (_message: string) => undefined,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}: DesktopHostSupervisorOptions): DesktopHostSupervisor {
  let child: ReturnType<typeof spawnProcess> | null = null
  let state: DesktopHostState | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let restartAttempt = 0
  let activeConfig: ReturnType<typeof createDesktopHostSpawnConfig> | null = null
  let activeConnection: Extract<DesktopHostState, { available: true }> | null = null

  const spawnHost = () => {
    if (stopped || !activeConfig) return
    const config = activeConfig
    child = spawn(config.command, config.args, config.options)
    if (activeConnection) state = activeConnection
    child.stdout?.on('data', (chunk) => log(`[desktop-host] ${String(chunk).trimEnd()}`))
    child.stderr?.on('data', (chunk) => log(`[desktop-host] ${String(chunk).trimEnd()}`))
    child.once?.('spawn', () => { restartAttempt = 0 })
    child.once?.('exit', (code) => {
      if (stopped) return
      log(`[desktop-host] exited with code ${code}`)
      child = null
      state = { available: false, reason: `desktop host exited with code ${code}; restarting` }
      const delay = Math.min(10_000, 500 * (2 ** restartAttempt++))
      restartTimer = schedule(() => {
        restartTimer = null
        spawnHost()
      }, delay)
    })
    child.once?.('error', (error) => {
      log(`[desktop-host] failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return {
    async start() {
      if (state?.available && child) return state
      if (!exists(binaryPath)) {
        state = {
          available: false,
          reason: `desktop host binary is missing: ${binaryPath}`,
        }
        return state
      }

      const endpoint = createDesktopHostEndpoint({ platform, id: id() })
      const sessionToken = token()
      stopped = false
      activeConfig = createDesktopHostSpawnConfig({
        binaryPath,
        endpoint,
        sessionToken,
        env: baseEnv,
        platform,
      })
      activeConnection = { available: true, endpoint, token: sessionToken }
      spawnHost()
      state = activeConnection
      return state
    },

    stop() {
      stopped = true
      if (restartTimer) cancelSchedule(restartTimer)
      restartTimer = null
      child?.kill?.()
      child = null
      activeConfig = null
      activeConnection = null
      state = null
    },

    getState() {
      return state
    },
  }
}
