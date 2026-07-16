/**
 * Session Storage & Management
 *
 * Persists conversation transcripts, derived session metadata, and
 * file checkpoints for rewind support.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import type { NormalizedMessageParam } from './providers/types.js'
import type {
  FileCheckpointState,
} from './utils/file-checkpoints.js'
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  SessionMessage,
  SessionMutationOptions,
} from './types.js'

export interface SessionMetadata {
  id: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  summary?: string
  tag?: string | null
  forkedFrom?: string
}

export interface SessionData {
  metadata: SessionMetadata
  messages: NormalizedMessageParam[]
  sessionMessages?: SessionMessage[]
  checkpoints?: FileCheckpointState
}

type SaveSessionMetadata = Partial<SessionMetadata> & {
  sessionMessages?: SessionMessage[]
  checkpoints?: FileCheckpointState
}

function getTranscriptJsonPath(dir: string): string {
  return join(dir, 'transcript.json')
}

function getTranscriptJsonlPath(dir: string): string {
  return join(dir, 'transcript.jsonl')
}

function getSessionDirCandidates(): string[] {
  const candidates: string[] = []
  const override = process.env.OPEN_AGENT_SDK_HOME || process.env.CODEANY_HOME
  if (override) {
    candidates.push(join(override, 'sessions'))
  }

  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    candidates.push(join(home, '.open-agent-sdk', 'sessions'))
  }

  candidates.push(join(process.cwd(), '.open-agent-sdk', 'sessions'))
  return [...new Set(candidates)]
}

async function resolveExistingSessionPath(sessionId: string): Promise<string | null> {
  for (const root of getSessionDirCandidates()) {
    const candidate = getTranscriptJsonPath(join(root, sessionId))
    try {
      await readFile(candidate, 'utf-8')
      return join(root, sessionId)
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function normalizeSessionData(
  sessionId: string,
  data: Partial<SessionData>,
): SessionData {
  return {
    metadata: {
      id: sessionId,
      cwd: data.metadata?.cwd || process.cwd(),
      model: data.metadata?.model || 'claude-sonnet-4-6',
      createdAt: data.metadata?.createdAt || new Date().toISOString(),
      updatedAt: data.metadata?.updatedAt || new Date().toISOString(),
      messageCount: data.metadata?.messageCount ?? data.messages?.length ?? 0,
      summary: data.metadata?.summary,
      tag: data.metadata?.tag,
      forkedFrom: data.metadata?.forkedFrom,
    },
    messages: data.messages || [],
    sessionMessages: data.sessionMessages || [],
    checkpoints: data.checkpoints || {},
  }
}

export async function saveSession(
  sessionId: string,
  messages: NormalizedMessageParam[],
  metadata: SaveSessionMetadata,
): Promise<void> {
  const persistedMessages = sanitizePersistedValue(messages) as NormalizedMessageParam[]
  const persistedSessionMessages = sanitizePersistedValue(metadata.sessionMessages) as SessionMessage[] | undefined
  const data = normalizeSessionData(sessionId, {
    metadata: {
      id: sessionId,
      cwd: metadata.cwd || process.cwd(),
      model: metadata.model || 'claude-sonnet-4-6',
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: persistedMessages.length,
      summary: metadata.summary,
      tag: metadata.tag,
      forkedFrom: metadata.forkedFrom,
    },
    messages: persistedMessages,
    sessionMessages: persistedSessionMessages,
    checkpoints: metadata.checkpoints,
  })

  const payload = JSON.stringify(data, null, 2)
  const jsonlPayload = (data.sessionMessages || [])
    .map((message) => JSON.stringify(message))
    .join('\n')
  let lastError: unknown = null

  for (const root of getSessionDirCandidates()) {
    const dir = join(root, sessionId)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(getTranscriptJsonPath(dir), payload, 'utf-8')
      await writeFile(getTranscriptJsonlPath(dir), jsonlPayload, 'utf-8')
      return
    } catch (err) {
      lastError = err
    }
  }

  throw lastError
}

function sanitizePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistedValue(item))
  }
  if (!isRecord(value)) return value
  if (value.type === 'image' && isRecord(value._meta) && value._meta.persist === false) {
    return omitNonPersistentImagePayload(value)
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizePersistedValue(item)]),
  )
}

function omitNonPersistentImagePayload(value: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(value.source) ? value.source : {}
  if (source.type === 'file' && typeof source.path === 'string') {
    return {
      type: 'text',
      text: `[Screenshot reference: ${source.path}]`,
    }
  }
  const mediaType = typeof source.media_type === 'string'
    ? source.media_type
    : typeof value.mimeType === 'string'
      ? value.mimeType
      : undefined
  return {
    ...value,
    source: {
      type: 'omitted',
      ...(mediaType ? { media_type: mediaType } : {}),
      reason: 'image omitted from persisted transcript',
    },
    ...(typeof value.data === 'string' ? { data: '[omitted]' } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  try {
    const existingPath = await resolveExistingSessionPath(sessionId)
    if (!existingPath) return null
    const content = await readFile(getTranscriptJsonPath(existingPath), 'utf-8')
    const parsed = normalizeSessionData(sessionId, JSON.parse(content) as SessionData)
    try {
      const jsonl = await readFile(getTranscriptJsonlPath(existingPath), 'utf-8')
      const sessionMessages = jsonl
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionMessage)
      if (sessionMessages.length > 0) {
        parsed.sessionMessages = sessionMessages
      }
    } catch {
      // Older sessions may not have jsonl transcripts yet.
    }
    return parsed
  } catch {
    return null
  }
}

function matchesDir(session: SessionMetadata, dir?: string): boolean {
  if (!dir) return true
  const target = resolve(dir)
  const cwd = resolve(session.cwd)
  return cwd === target || cwd.startsWith(`${target}\\`) || cwd.startsWith(`${target}/`)
}

export async function listSessions(
  options: ListSessionsOptions = {},
): Promise<SessionMetadata[]> {
  try {
    const seen = new Set<string>()
    const sessions: SessionMetadata[] = []

    for (const dir of getSessionDirCandidates()) {
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (seen.has(entry)) continue
        const data = await loadSession(entry)
        if (!data?.metadata) continue
        if (!matchesDir(data.metadata, options.dir)) continue
        seen.add(entry)
        sessions.push(data.metadata)
      }
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const offset = options.offset || 0
    const limit = options.limit ?? sessions.length
    return sessions.slice(offset, offset + limit)
  } catch {
    return []
  }
}

export async function forkSession(
  sourceSessionId: string,
  optionsOrNewSessionId?: ForkSessionOptions | string,
): Promise<string | ForkSessionResult | null> {
  const data = await loadSession(sourceSessionId)
  if (!data) return null

  const options = typeof optionsOrNewSessionId === 'string'
    ? { newSessionId: optionsOrNewSessionId }
    : (optionsOrNewSessionId || {})

  const forkId = options.newSessionId || crypto.randomUUID()
  const sessionMessages = options.upToMessageId
    ? sliceSessionMessages(data.sessionMessages || [], options.upToMessageId)
    : data.sessionMessages

  await saveSession(forkId, data.messages, {
    ...data.metadata,
    id: forkId,
    createdAt: new Date().toISOString(),
    summary: options.title || data.metadata.summary || `Forked from session ${sourceSessionId}`,
    forkedFrom: sourceSessionId,
    sessionMessages,
    checkpoints: data.checkpoints,
  })

  if (typeof optionsOrNewSessionId === 'string' || optionsOrNewSessionId === undefined) {
    return forkId
  }
  return { sessionId: forkId }
}

function sliceSessionMessages(
  messages: SessionMessage[],
  upToMessageId: string,
): SessionMessage[] {
  const index = messages.findIndex((message) => message.uuid === upToMessageId)
  if (index === -1) return messages
  return messages.slice(0, index + 1)
}

function mapNormalizedToSessionMessages(
  messages: NormalizedMessageParam[],
): SessionMessage[] {
  return messages.map((message, index) => ({
    uuid: `legacy-${index + 1}`,
    role: message.role,
    timestamp: new Date(0).toISOString(),
    content: message.content,
  }))
}

export async function getSessionMessages(
  sessionId: string,
  options: GetSessionMessagesOptions = {},
): Promise<SessionMessage[]> {
  const data = await loadSession(sessionId)
  if (!data) return []
  if (!matchesDir(data.metadata, options.dir)) return []

  const messages = data.sessionMessages?.length
    ? data.sessionMessages
    : mapNormalizedToSessionMessages(data.messages)
  const filtered = options.includeSystemMessages
    ? messages
    : messages.filter((message) => message.role !== 'system' && message.role !== 'runtime')
  const offset = options.offset || 0
  const limit = options.limit ?? filtered.length
  return filtered.slice(offset, offset + limit)
}

export async function appendToSession(
  sessionId: string,
  message: NormalizedMessageParam,
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return

  data.messages.push(message)
  data.metadata.updatedAt = new Date().toISOString()
  data.metadata.messageCount = data.messages.length

  await saveSession(sessionId, data.messages, {
    ...data.metadata,
    sessionMessages: data.sessionMessages,
    checkpoints: data.checkpoints,
  })
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  let deleted = false
  try {
    for (const root of getSessionDirCandidates()) {
      await rm(join(root, sessionId), { recursive: true, force: true })
      deleted = true
    }
  } catch {
    // Ignore removal failures for individual roots.
  }
  return deleted
}

export async function getSessionInfo(
  sessionId: string,
  options: GetSessionInfoOptions = {},
): Promise<SessionMetadata | null> {
  const data = await loadSession(sessionId)
  if (!data?.metadata) return null
  return matchesDir(data.metadata, options.dir) ? data.metadata : null
}

export async function renameSession(
  sessionId: string,
  title: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return
  if (!matchesDir(data.metadata, options.dir)) return

  data.metadata.summary = title
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, {
    ...data.metadata,
    sessionMessages: data.sessionMessages,
    checkpoints: data.checkpoints,
  })
}

export async function tagSession(
  sessionId: string,
  tag: string | null,
  options: SessionMutationOptions = {},
): Promise<void> {
  const data = await loadSession(sessionId)
  if (!data) return
  if (!matchesDir(data.metadata, options.dir)) return

  data.metadata.tag = tag
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, {
    ...data.metadata,
    sessionMessages: data.sessionMessages,
    checkpoints: data.checkpoints,
  })
}
