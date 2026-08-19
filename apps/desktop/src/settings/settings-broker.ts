import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024
// PID-reuse detection tolerance: process start timestamps come from different
// clock sources with second-level precision, so treat sub-5s deltas as a match.
const PROCESS_START_TOLERANCE_MS = 5_000

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  return true
}

// Best-effort creation time of an arbitrary pid; null when it cannot be
// determined (then the caller must fail closed and keep the lock).
function processStartIso(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat field 22 (starttime) is clock ticks since boot;
      // the comm field may contain spaces, so parse after the last ')'.
      const statText = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const startTicks = Number(statText.slice(statText.lastIndexOf(')') + 2).split(' ')[19])
      const bootSeconds = Number(readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1])
      if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) return null
      return new Date((bootSeconds + startTicks / 100) * 1000).toISOString()
    }
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf8', timeout: 10_000 }).trim()
      return out || null
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
    const parsed = Date.parse(out)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  } catch {
    return null
  }
}

// True when the pid is alive but was (re)started at a different time than the
// one recorded in the lock file — i.e. the OS recycled the dead owner's pid.
function pidReused(pid: number, recordedStartIso: string | undefined): boolean {
  if (!recordedStartIso) return false
  const actualStartIso = processStartIso(pid)
  if (!actualStartIso) return false
  const delta = Math.abs(Date.parse(actualStartIso) - Date.parse(recordedStartIso))
  return Number.isFinite(delta) && delta > PROCESS_START_TOLERANCE_MS
}

export type RootSettings = Record<string, unknown>

export class SettingsBroker {
  private readonly path: string
  private readonly lockPath: string
  private readonly lockToken = randomUUID()
  private lockFd: number | null = null

  constructor(configDir: string) {
    mkdirSync(configDir, { recursive: true })
    this.path = join(configDir, 'settings.json')
    this.lockPath = join(configDir, 'settings.json.lock')
    this.acquireLock()
  }

  read(): RootSettings {
    // A crash between the two renames in replace() can leave only .bak behind.
    return this.parseFile(this.path) ?? this.parseFile(`${this.path}.bak`) ?? {}
  }

  private parseFile(path: string): RootSettings | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  replace(settings: unknown): RootSettings {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('invalid root settings snapshot')
    }
    const payload = JSON.stringify(settings, null, 2)
    if (Buffer.byteLength(payload, 'utf8') > MAX_SETTINGS_BYTES) {
      throw new Error('root settings snapshot exceeds byte limit')
    }
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    const backupPath = `${this.path}.bak`
    writeFileSync(tempPath, payload, 'utf8')
    let backedUp = false
    if (existsSync(this.path)) {
      rmSync(backupPath, { force: true })
      renameSync(this.path, backupPath)
      backedUp = true
    }
    try {
      renameSync(tempPath, this.path)
      // Without a fresh backup this .bak may be the only surviving copy of the
      // old settings (crash-recovery write); keep it until the next rotation.
      if (backedUp) rmSync(backupPath, { force: true })
    } catch (error) {
      if (backedUp && existsSync(backupPath)) renameSync(backupPath, this.path)
      rmSync(tempPath, { force: true })
      throw error
    }
    return settings as RootSettings
  }

  mutate(mutator: (current: RootSettings) => RootSettings): RootSettings {
    return this.replace(mutator(this.read()))
  }

  close(): void {
    if (this.lockFd === null) return
    closeSync(this.lockFd)
    this.lockFd = null
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string }
      if (owner.token === this.lockToken) rmSync(this.lockPath, { force: true })
    } catch {
      // Never remove a lock whose ownership cannot be verified.
    }
  }

  private acquireLock(): void {
    try {
      this.lockFd = openSync(this.lockPath, 'wx')
    } catch (error) {
      let owner: { pid?: unknown; processStartedAt?: unknown } | null = null
      try { owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) } catch { /* fail closed */ }
      const ownerPid = Number(owner?.pid ?? 0)
      const ownerStartedAt = typeof owner?.processStartedAt === 'string' ? owner.processStartedAt : undefined
      const ownerAlive = ownerPid > 0
        && processAlive(ownerPid)
        // A live pid is not proof of a live owner: the OS may have recycled
        // the dead owner's pid, which previously bricked startup until the
        // lock file was deleted by hand.
        && !pidReused(ownerPid, ownerStartedAt)
      if (ownerAlive || ownerPid <= 0) throw error
      rmSync(this.lockPath, { force: true })
      this.lockFd = openSync(this.lockPath, 'wx')
    }
    writeFileSync(this.lockFd, JSON.stringify({
      pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      token: this.lockToken,
    }), 'utf8')
  }
}
