import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { spawn as spawnProcess } from 'node:child_process'
import { createDesktopHostSpawnConfig, createDesktopHostTokenFilePath } from './sidecar-process'
import { parseLumeLogLine } from '@lume/shared'

export type DesktopHostState =
  | { available: true; endpoint: string; token: string }
  | { available: false; reason: string }

// 稳定运行该时长后清零崩溃窗口,视为一次健康启动(#124)
const STABLE_RUN_MS = 10_000

export function nextCrashState(previous: number[], now: number): { crashTimes: number[]; shouldRestart: boolean; delayMs: number } {
  const crashTimes = [...previous.filter((time) => now - time < 5 * 60_000), now]
  return { crashTimes, shouldRestart: crashTimes.length < 3, delayMs: 2 ** Math.max(0, crashTimes.length - 1) * 1000 }
}

export interface DesktopHostStructuredLog {
  level?: string
  context?: string
  event?: string
  message?: string
  data?: Record<string, unknown>
}

interface DesktopHostSupervisorOptions {
  binaryPath: string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  spawn?: typeof spawnProcess
  id?: () => string
  token?: () => string
  tempDir?: string
  baseEnv?: NodeJS.ProcessEnv
  log?: (message: string) => void
  logEvent?: (event: DesktopHostStructuredLog) => void
  writeTokenFile?: (path: string, token: string) => void
  removeTokenFile?: (path: string) => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
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
  tempDir = tmpdir(),
  baseEnv = process.env,
  log = (_message: string) => undefined,
  logEvent,
  writeTokenFile = (path, token) => writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 }),
  removeTokenFile = (path) => rmSync(path, { force: true }),
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  now = Date.now,
}: DesktopHostSupervisorOptions): DesktopHostSupervisor {
  let child: ReturnType<typeof spawnProcess> | null = null
  let state: DesktopHostState | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let crashTimes: number[] = []
  let activeConfig: ReturnType<typeof createDesktopHostSpawnConfig> | null = null
  let activeConnection: Extract<DesktopHostState, { available: true }> | null = null
  let activeTokenFilePath: string | null = null

  // exit 与 error 共用的降级路径:置 unavailable、按崩溃窗口退避重调度。
  // spawn 失败(杀软拦截/缺 DLL)只发 error 不发 exit,原实现仅打日志导致 state 永远 available(#124)。
  const scheduleRestart = (reason: string, spawnedAt: number) => {
    child = null
    // 稳定运行过一段时间才算「健康」,清零崩溃窗口——避免 spawn 即崩的循环把退避清零(#124)
    if (spawnedAt && now() - spawnedAt >= STABLE_RUN_MS) crashTimes = []
    const crash = nextCrashState(crashTimes, now())
    crashTimes = crash.crashTimes
    state = {
      available: false,
      reason: crash.shouldRestart ? reason : `${reason}; giving up after repeated crashes`,
    }
    if (!crash.shouldRestart) return
    if (restartTimer) cancelSchedule(restartTimer)
    restartTimer = schedule(() => {
      restartTimer = null
      spawnHost()
    }, crash.delayMs)
  }

  const spawnHost = () => {
    if (stopped || !activeConfig) return
    const config = activeConfig
    if (activeTokenFilePath && activeConnection) {
      writeTokenFile(activeTokenFilePath, activeConnection.token)
    }
    const running = spawn(config.command, config.args, config.options)
    child = running
    if (activeConnection) state = activeConnection
    // 无换行洪水的兜底：缓冲超限保留末尾 64KB，防止 O(n²) 重扫与内存无界。
    const MAX_LINE_BUFFER_CHARS = 1024 * 1024
    const lineBuffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
    const ingestChunk = (stream: 'stdout' | 'stderr', chunk: string) => {
      lineBuffers[stream] += chunk
      if (lineBuffers[stream].length > MAX_LINE_BUFFER_CHARS) {
        lineBuffers[stream] = lineBuffers[stream].slice(-64 * 1024)
      }
      const lines = lineBuffers[stream].split('\n')
      lineBuffers[stream] = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trimEnd()
        if (!line) continue
        // parseLumeLogLine：非前缀/坏 JSON/非对象载荷返回 null → 回退文本路径，
        // 避免 null 解构在 data handler 里抛未捕获异常击穿主进程。
        const parsed = parseLumeLogLine(line)
        if (!parsed) {
          log(`[desktop-host] ${line}`)
          continue
        }
        try {
          logEvent?.(parsed as DesktopHostStructuredLog)
        } catch {
          // logEvent 自身故障不得在 data handler 里抛未捕获异常。
          log(`[desktop-host] ${line}`)
        }
      }
    }
    running.stdout?.on('data', (chunk) => ingestChunk('stdout', String(chunk)))
    running.stderr?.on('data', (chunk) => ingestChunk('stderr', String(chunk)))
    let spawnedAt = 0
    running.once?.('spawn', () => { spawnedAt = now() })
    running.once?.('exit', (code) => {
      if (stopped || child !== running) return
      // 冲刷残尾：宿主死在半行输出时，退出前把缓冲里最后一行处理掉。
      ingestChunk('stdout', '\n')
      ingestChunk('stderr', '\n')
      log(`[desktop-host] exited with code ${code}`)
      scheduleRestart(`desktop host exited with code ${code}; restarting`, spawnedAt)
    })
    running.once?.('error', (error) => {
      if (stopped || child !== running) return
      log(`[desktop-host] failed: ${error instanceof Error ? error.message : String(error)}`)
      scheduleRestart(`desktop host failed: ${error instanceof Error ? error.message : String(error)}; restarting`, spawnedAt)
    })
  }

  return {
    async start() {
      if (state?.available && child) return state
      // 手动 start 视为显式拉起:取消挂起的重启定时器(否则与 timer 双 spawn 产生孤儿)
      // 并清零崩溃窗口(与退避重启语义一致)
      if (restartTimer) { cancelSchedule(restartTimer); restartTimer = null }
      crashTimes = []
      if (!exists(binaryPath)) {
        state = {
          available: false,
          reason: `desktop host binary is missing: ${binaryPath}`,
        }
        return state
      }

      const endpoint = createDesktopHostEndpoint({ platform, id: id(), tempDir })
      const sessionToken = token()
      const tokenFilePath = platform === 'darwin' ? createDesktopHostTokenFilePath(endpoint) : undefined
      stopped = false
      activeConfig = createDesktopHostSpawnConfig({
        binaryPath,
        endpoint,
        sessionToken,
        tokenFilePath,
        env: baseEnv,
        platform,
      })
      activeConnection = { available: true, endpoint, token: sessionToken }
      activeTokenFilePath = tokenFilePath ?? null
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
      if (activeTokenFilePath) removeTokenFile(activeTokenFilePath)
      activeConfig = null
      activeConnection = null
      activeTokenFilePath = null
      state = null
    },

    getState() {
      return state
    },
  }
}
