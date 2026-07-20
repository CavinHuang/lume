import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ATTACHMENT_STAGE_MAX_FILE_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_STAGE_MAX_CHUNK_BYTES = 256 * 1024
const DEFAULT_STAGE_TTL_MS = 24 * 60 * 60 * 1000

interface AttachmentStageRecord {
  id: string
  attachmentId: string
  ownerWebContentsId: number
  filename: string
  mediaType: string
  size: number
  path: string
  receivedBytes: number
  fd?: number
  completed: boolean
  expiresAt: number
  sourceIdentity?: { dev: number; ino: number; size: number; mtimeMs: number }
}

export interface AttachmentStageDescriptor {
  stagedAttachmentId: string
  filename: string
  mediaType: string
  size: number
  path: string
}

const ATTACHMENT_PREVIEW_HOST = 'attachment'

export function attachmentStagePreviewUrl(stage: Pick<AttachmentStageDescriptor, 'stagedAttachmentId' | 'filename'>): string {
  return `lume-file://${ATTACHMENT_PREVIEW_HOST}/${stage.stagedAttachmentId}/${encodeURIComponent(stage.filename)}`
}

export function attachmentStageIdFromPreviewUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'lume-file:' || parsed.host !== ATTACHMENT_PREVIEW_HOST) return null
    return parsed.pathname.split('/').filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

export class AttachmentStageRegistry {
  readonly #records = new Map<string, AttachmentStageRecord>()
  readonly #rootDir: string
  readonly #now: () => number
  readonly #createId: () => string
  readonly #ttlMs: number

  constructor(input: {
    rootDir: string
    now?: () => number
    createId?: () => string
    ttlMs?: number
  }) {
    this.#rootDir = input.rootDir
    this.#now = input.now ?? Date.now
    this.#createId = input.createId ?? randomUUID
    this.#ttlMs = input.ttlMs ?? DEFAULT_STAGE_TTL_MS
    mkdirSync(this.#rootDir, { recursive: true })
    for (const name of readdirSync(this.#rootDir)) {
      const path = join(this.#rootDir, name)
      try {
        if (lstatSync(path).isFile()) rmSync(path, { force: true })
      } catch {
        // Best-effort cleanup of staging files left by a previous process.
      }
    }
  }

  begin(input: {
    ownerWebContentsId: number
    attachmentId: string
    filename: string
    mediaType: string
    size: number
  }): AttachmentStageDescriptor {
    this.cleanupExpired()
    assertStageMetadata(input)
    const id = this.#createId()
    const path = join(this.#rootDir, `${id}.part`)
    const fd = openSync(path, 'wx')
    const record: AttachmentStageRecord = {
      id,
      attachmentId: input.attachmentId,
      ownerWebContentsId: input.ownerWebContentsId,
      filename: basename(input.filename),
      mediaType: input.mediaType,
      size: input.size,
      path,
      receivedBytes: 0,
      fd,
      completed: false,
      expiresAt: this.#now() + this.#ttlMs,
    }
    this.#records.set(id, record)
    return descriptor(record)
  }

  grantPath(input: {
    ownerWebContentsId: number
    attachmentId: string
    sourcePath: string
    filename: string
    mediaType: string
  }): AttachmentStageDescriptor {
    this.cleanupExpired()
    const path = realpathSync(input.sourcePath)
    const stats = lstatSync(path)
    assertStageMetadata({ ...input, size: stats.size })
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`只允许附加普通文件: ${input.filename}`)
    const id = this.#createId()
    const record: AttachmentStageRecord = {
      id,
      attachmentId: input.attachmentId,
      ownerWebContentsId: input.ownerWebContentsId,
      filename: basename(input.filename),
      mediaType: input.mediaType,
      size: stats.size,
      path,
      receivedBytes: stats.size,
      completed: true,
      expiresAt: this.#now() + this.#ttlMs,
      sourceIdentity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
    }
    this.#records.set(id, record)
    return descriptor(record)
  }

  append(input: {
    ownerWebContentsId: number
    stagedAttachmentId: string
    offset: number
    chunk: Uint8Array | ArrayBuffer
  }): { receivedBytes: number } {
    const record = this.#owned(input.stagedAttachmentId, input.ownerWebContentsId)
    if (record.completed || record.fd === undefined) throw new Error('附件暂存已经结束')
    if (input.offset !== record.receivedBytes) throw new Error('附件分块顺序无效')
    const bytes = input.chunk instanceof Uint8Array
      ? Buffer.from(input.chunk.buffer, input.chunk.byteOffset, input.chunk.byteLength)
      : Buffer.from(input.chunk)
    if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_STAGE_MAX_CHUNK_BYTES) {
      throw new Error('附件分块大小无效')
    }
    if (record.receivedBytes + bytes.byteLength > record.size
      || record.receivedBytes + bytes.byteLength > ATTACHMENT_STAGE_MAX_FILE_BYTES) {
      throw new Error('附件分块超过声明大小')
    }
    writeSync(record.fd, bytes, 0, bytes.byteLength, record.receivedBytes)
    record.receivedBytes += bytes.byteLength
    record.expiresAt = this.#now() + this.#ttlMs
    return { receivedBytes: record.receivedBytes }
  }

  finish(input: { ownerWebContentsId: number; stagedAttachmentId: string }): AttachmentStageDescriptor {
    const record = this.#owned(input.stagedAttachmentId, input.ownerWebContentsId)
    if (record.completed) return descriptor(record)
    if (record.receivedBytes !== record.size || record.fd === undefined) {
      throw new Error('附件暂存内容不完整')
    }
    fsyncSync(record.fd)
    closeSync(record.fd)
    delete record.fd
    record.completed = true
    record.expiresAt = this.#now() + this.#ttlMs
    return descriptor(record)
  }

  resolve(input: {
    ownerWebContentsId: number
    stagedAttachmentId: string
    attachmentId: string
  }): string {
    const record = this.#owned(input.stagedAttachmentId, input.ownerWebContentsId)
    if (!record.completed || record.attachmentId !== input.attachmentId) throw new Error('附件暂存标识无效')
    if (record.sourceIdentity) {
      const stats = statSync(record.path)
      const identity = record.sourceIdentity
      if (stats.dev !== identity.dev || stats.ino !== identity.ino
        || stats.size !== identity.size || stats.mtimeMs !== identity.mtimeMs) {
        throw new Error(`源文件在添加后发生变化: ${record.filename}`)
      }
    } else if (!existsSync(record.path)) {
      throw new Error(`附件暂存文件不存在: ${record.filename}`)
    }
    record.expiresAt = this.#now() + this.#ttlMs
    return record.path
  }

  owns(stagedAttachmentId: string, ownerWebContentsId: number): boolean {
    this.cleanupExpired()
    const record = this.#records.get(stagedAttachmentId)
    return Boolean(record?.completed && record.ownerWebContentsId === ownerWebContentsId)
  }

  preview(stagedAttachmentId: string): AttachmentStageDescriptor | null {
    this.cleanupExpired()
    const record = this.#records.get(stagedAttachmentId)
    if (!record?.completed || !existsSync(record.path)) return null
    record.expiresAt = this.#now() + this.#ttlMs
    return descriptor(record)
  }

  abort(input: { ownerWebContentsId: number; stagedAttachmentId: string }): void {
    const record = this.#owned(input.stagedAttachmentId, input.ownerWebContentsId)
    this.#remove(record)
  }

  cleanupOwner(ownerWebContentsId: number): void {
    for (const record of this.#records.values()) {
      if (record.ownerWebContentsId === ownerWebContentsId) this.#remove(record)
    }
  }

  cleanupExpired(): void {
    const now = this.#now()
    for (const record of this.#records.values()) {
      if (record.expiresAt <= now) this.#remove(record)
    }
  }

  #owned(id: string, ownerWebContentsId: number): AttachmentStageRecord {
    this.cleanupExpired()
    const record = this.#records.get(id)
    if (!record || record.ownerWebContentsId !== ownerWebContentsId) throw new Error('附件暂存标识不存在或已过期')
    return record
  }

  #remove(record: AttachmentStageRecord): void {
    if (record.fd !== undefined) closeSync(record.fd)
    if (!record.sourceIdentity && existsSync(record.path)) rmSync(record.path, { force: true })
    this.#records.delete(record.id)
  }
}

function assertStageMetadata(input: { attachmentId: string; filename: string; mediaType: string; size: number }): void {
  if (!input.attachmentId || !input.filename || !input.mediaType) throw new Error('附件元数据不完整')
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > ATTACHMENT_STAGE_MAX_FILE_BYTES) {
    throw new Error('附件大小超过限制')
  }
}

function descriptor(record: AttachmentStageRecord): AttachmentStageDescriptor {
  return {
    stagedAttachmentId: record.id,
    filename: record.filename,
    mediaType: record.mediaType,
    size: record.size,
    path: record.path,
  }
}
