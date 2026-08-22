import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LumeDiagnosticCaptureSettings,
  SensitiveDiagnosticEnvelope,
} from '@lume/shared'

const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const RECORD_PATTERN = /^[0-9a-f-]{36}\.diag$/i

export interface DiagnosticCrypto {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface EncryptedDiagnosticRecord {
  id: string
  captureType: SensitiveDiagnosticEnvelope['captureType']
  createdAt: string
  expiresAt: string
  threadId: string
  traceId: string
  messageId: string
  leaseVersion: number
  ciphertext: string
}

export class DiagnosticContentStore {
  readonly directory: string
  private readonly initialized: Promise<void>

  constructor(configDir: string, private readonly crypto: DiagnosticCrypto) {
    this.directory = join(configDir, 'logs', 'diagnostic-content')
    this.initialized = this.cleanupInternal().catch(() => {})
  }

  isAvailable(): boolean {
    return this.crypto.isAvailable()
  }

  async capture(
    envelope: SensitiveDiagnosticEnvelope,
    lease: LumeDiagnosticCaptureSettings,
  ): Promise<string> {
    await this.initialized
    this.assertEnvelope(envelope, lease)
    const id = randomUUID()
    const record: EncryptedDiagnosticRecord = {
      id,
      captureType: envelope.captureType,
      createdAt: envelope.emittedAt,
      expiresAt: lease.expiresAt!,
      threadId: envelope.threadId,
      traceId: envelope.traceId,
      messageId: envelope.messageId,
      leaseVersion: envelope.leaseVersion,
      ciphertext: this.crypto.encrypt(envelope.content).toString('base64'),
    }
    await mkdir(this.directory, { recursive: true })
    await writeFile(join(this.directory, `${id}.diag`), JSON.stringify(record), { encoding: 'utf8', flag: 'wx' })
    await this.cleanup()
    return id
  }

  async decrypt(id: string): Promise<Omit<EncryptedDiagnosticRecord, 'ciphertext'> & { content: string }> {
    await this.initialized
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid diagnostic record id')
    if (!this.crypto.isAvailable()) throw new Error('secure diagnostic storage is unavailable')
    const record = JSON.parse(await readFile(join(this.directory, `${id}.diag`), 'utf8')) as EncryptedDiagnosticRecord
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await rm(join(this.directory, `${id}.diag`), { force: true })
      throw new Error('diagnostic record expired')
    }
    const { ciphertext, ...metadata } = record
    return { ...metadata, content: this.crypto.decrypt(Buffer.from(ciphertext, 'base64')) }
  }

  async clear(): Promise<number> {
    await this.initialized
    await mkdir(this.directory, { recursive: true })
    const names = (await readdir(this.directory)).filter((name) => RECORD_PATTERN.test(name))
    await Promise.all(names.map((name) => rm(join(this.directory, name), { force: true })))
    return names.length
  }

  async cleanup(): Promise<void> {
    await this.initialized
    await this.cleanupInternal()
  }

  private async cleanupInternal(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const names = (await readdir(this.directory)).filter((name) => RECORD_PATTERN.test(name))
    const entries = await Promise.all(names.map(async (name) => {
      const path = join(this.directory, name)
      const info = await stat(path)
      let expiresAt = 0
      try {
        expiresAt = Date.parse((JSON.parse(await readFile(path, 'utf8')) as EncryptedDiagnosticRecord).expiresAt)
      } catch {
        // Corrupt records are not useful and are safe to delete.
      }
      return { path, size: info.size, mtime: info.mtimeMs, expiresAt }
    }))
    entries.sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) {
      if (entry.expiresAt > Date.now() && total <= MAX_TOTAL_BYTES) continue
      await rm(entry.path, { force: true })
      total -= entry.size
    }
  }

  private assertEnvelope(envelope: SensitiveDiagnosticEnvelope, lease: LumeDiagnosticCaptureSettings): void {
    if (!this.crypto.isAvailable()) throw new Error('secure diagnostic storage is unavailable')
    if (!lease.enabled || !lease.expiresAt || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new Error('diagnostic capture lease is inactive')
    }
    if (envelope.schemaVersion !== 1 || envelope.envelopeType !== 'sensitive-diagnostic') {
      throw new Error('invalid diagnostic envelope')
    }
    if (envelope.captureType !== 'user_message' && envelope.captureType !== 'assistant_message') {
      throw new Error('diagnostic content type is not allowed')
    }
    if (envelope.leaseVersion !== lease.configVersion) throw new Error('stale diagnostic lease')
    if (lease.scope?.threadId && envelope.threadId !== lease.scope.threadId) throw new Error('thread is outside diagnostic scope')
    if (lease.scope?.traceId && envelope.traceId !== lease.scope.traceId) throw new Error('trace is outside diagnostic scope')
    for (const value of [envelope.threadId, envelope.traceId, envelope.messageId]) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('invalid diagnostic correlation id')
    }
    if (typeof envelope.content !== 'string' || Buffer.byteLength(envelope.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error('diagnostic content exceeds byte limit')
    }
  }
}
