/**
 * Session Storage & Management
 *
 * Persists conversation transcripts, derived session metadata, and
 * file checkpoints for rewind support.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { clearLspWritethroughState } from './lsp/writethrough.js'
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

function getMetaJsonPath(dir: string): string {
  return join(dir, 'meta.json')
}

/**
 * tmp+rename 原子替换：裸 writeFile 打开即截断，进程崩溃会留下半截
 * transcript，loadSession 解析失败后整个会话被静默丢弃（#293/#306）。
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, 'utf-8')
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
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
    const dir = join(root, sessionId)
    for (const candidate of [getTranscriptJsonPath(dir), getTranscriptJsonlPath(dir), getMetaJsonPath(dir)]) {
      try {
        await readFile(candidate, 'utf-8')
        return dir
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null
}

function normalizeSessionMetadata(
  sessionId: string,
  metadata: Partial<SessionMetadata>,
): SessionMetadata {
  return {
    id: sessionId,
    cwd: metadata.cwd || process.cwd(),
    model: metadata.model || 'claude-sonnet-4-6',
    createdAt: metadata.createdAt || new Date().toISOString(),
    updatedAt: metadata.updatedAt || new Date().toISOString(),
    messageCount: metadata.messageCount ?? 0,
    summary: metadata.summary,
    tag: metadata.tag,
    forkedFrom: metadata.forkedFrom,
  }
}

function normalizeSessionData(
  sessionId: string,
  data: Partial<SessionData>,
): SessionData {
  const metadata = normalizeSessionMetadata(sessionId, {
    ...data.metadata,
    messageCount: data.metadata?.messageCount ?? data.messages?.length ?? 0,
  })
  return {
    metadata,
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
      await writeFileAtomic(getTranscriptJsonPath(dir), payload)
      await writeFileAtomic(getTranscriptJsonlPath(dir), jsonlPayload)
      await writeFileAtomic(getMetaJsonPath(dir), JSON.stringify(data.metadata, null, 2))
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

function parseJsonlSessionMessages(jsonl: string): SessionMessage[] {
  const messages: SessionMessage[] = []
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as SessionMessage)
    } catch {
      // 一行撕裂不影响其余行：jsonl 逐行独立，跳过坏行继续重建。
    }
  }
  return messages
}

/**
 * transcript.json 半截损坏时，用逐行独立的 transcript.jsonl 兜底重建，
 * 避免 resume 静默弃恢复（#293/#306）。
 */
async function rebuildSessionFromJsonl(
  sessionDir: string,
  sessionId: string,
): Promise<SessionData | null> {
  try {
    const jsonl = await readFile(getTranscriptJsonlPath(sessionDir), 'utf-8')
    const sessionMessages = parseJsonlSessionMessages(jsonl)
    if (sessionMessages.length === 0) return null
    const messages = sessionMessages
      .filter(
        (message): message is SessionMessage & { role: NormalizedMessageParam['role'] } =>
          message.role === 'user' || message.role === 'assistant' || message.role === 'runtime',
      )
      .map((message) => ({ role: message.role, content: message.content as NormalizedMessageParam['content'] }))
    return {
      metadata: normalizeSessionMetadata(sessionId, {
        createdAt: sessionMessages[0]?.timestamp,
        updatedAt: sessionMessages[sessionMessages.length - 1]?.timestamp,
        messageCount: messages.length,
      }),
      messages,
      sessionMessages,
      checkpoints: {},
    }
  } catch {
    return null
  }
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  let existingPath: string | null = null
  let parsed: SessionData | null = null
  try {
    existingPath = await resolveExistingSessionPath(sessionId)
    if (!existingPath) return null
    const content = await readFile(getTranscriptJsonPath(existingPath), 'utf-8')
    parsed = normalizeSessionData(sessionId, JSON.parse(content) as SessionData)
  } catch {
    // transcript.json 缺失或半截损坏 → jsonl 兜底；两者皆不可用才放弃。
    parsed = existingPath ? await rebuildSessionFromJsonl(existingPath, sessionId) : null
    if (!parsed) return null
  }
  try {
    const jsonl = await readFile(getTranscriptJsonlPath(existingPath), 'utf-8')
    const sessionMessages = parseJsonlSessionMessages(jsonl)
    if (sessionMessages.length > 0) {
      parsed.sessionMessages = sessionMessages
    }
  } catch {
    // Older sessions may not have jsonl transcripts yet.
  }
  return parsed
}

/**
 * 轻量元数据读取（meta.json），listSessions 不必为每个会话解析全量
 * transcript；meta.json 缺失或损坏时由调用方回退 loadSession。
 */
async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  for (const root of getSessionDirCandidates()) {
    try {
      const content = await readFile(getMetaJsonPath(join(root, sessionId)), 'utf-8')
      return normalizeSessionMetadata(sessionId, JSON.parse(content) as Partial<SessionMetadata>)
    } catch {
      // Try the next candidate / fall back to the full load.
    }
  }
  return null
}

function matchesDir(session: SessionMetadata, dir?: string): boolean {
  if (!dir) return true
  // win32 盘符/路径大小写会漂移（d:\ vs D:\），先折叠再比较，否则 continue 过滤为空丢历史（#362）
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const target = fold(resolve(dir))
  const cwd = fold(resolve(session.cwd))
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
        const metadata = (await readSessionMetadata(entry)) ?? (await loadSession(entry))?.metadata
        if (!metadata) continue
        if (!matchesDir(metadata, options.dir)) continue
        seen.add(entry)
        sessions.push(metadata)
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
  clearLspWritethroughState(sessionId)
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
