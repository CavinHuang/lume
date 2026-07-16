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

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024

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
    if (!existsSync(this.path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
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
    if (existsSync(this.path)) {
      rmSync(backupPath, { force: true })
      renameSync(this.path, backupPath)
    }
    try {
      renameSync(tempPath, this.path)
      rmSync(backupPath, { force: true })
    } catch (error) {
      if (existsSync(backupPath)) renameSync(backupPath, this.path)
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
      let ownerPid = 0
      try { ownerPid = Number(JSON.parse(readFileSync(this.lockPath, 'utf8'))?.pid ?? 0) } catch { /* fail closed */ }
      let ownerAlive = ownerPid > 0
      if (ownerAlive) {
        try { process.kill(ownerPid, 0) } catch { ownerAlive = false }
      }
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
