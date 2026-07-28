import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { sidecarCall } from '@/lib/desktop-api'

export interface CodingDiffPayload {
  rootId?: string
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  oldContent: string
  newContent: string
  lines: CodingDiffLine[]
  addedLines: number
  removedLines: number
}

export interface CodingDiffLine {
  type: 'context' | 'added' | 'removed'
  oldLine?: number
  newLine?: number
  text: string
}

const MAX_SHARED_DIFF_CACHE_BYTES = 32 * 1024 * 1024
const sharedDiffCache = new Map<string, { payload: CodingDiffPayload; size: number }>()
const sharedDiffRequests = new Map<string, Promise<CodingDiffPayload>>()
let sharedDiffCacheBytes = 0

function sessionDiffKey(threadId: string, runId: string, path: string, rootId?: string): string {
  return `${threadId}:${runId}:${rootId ?? ''}:${path.replace(/\\/g, '/')}`
}

export function readSessionCodingDiff(threadId: string, runId: string, path: string, rootId?: string): CodingDiffPayload | undefined {
  const key = sessionDiffKey(threadId, runId, path, rootId)
  const entry = sharedDiffCache.get(key)
  if (!entry) return undefined
  sharedDiffCache.delete(key)
  sharedDiffCache.set(key, entry)
  return entry.payload
}

export function requestSessionCodingDiff(threadId: string, runId: string, path: string, rootId?: string): Promise<CodingDiffPayload> {
  const key = sessionDiffKey(threadId, runId, path, rootId)
  const cached = readSessionCodingDiff(threadId, runId, path, rootId)
  if (cached) return Promise.resolve(cached)
  const pending = sharedDiffRequests.get(key)
  if (pending) return pending
  const request = sidecarCall<CodingDiffPayload>(AGENT_IPC_CHANNELS.GET_CODING_DIFF, { threadId, path, rootId, runId })
    .then((payload) => {
      writeSessionCodingDiff(key, payload)
      return payload
    })
    .finally(() => sharedDiffRequests.delete(key))
  sharedDiffRequests.set(key, request)
  return request
}

export async function prefetchSessionCodingDiffs(
  threadId: string,
  runId: string,
  files: Iterable<string | { path: string; rootId?: string }>,
  concurrency = 2,
): Promise<void> {
  const unique = new Map<string, { path: string; rootId?: string }>()
  for (const file of files) {
    const value = typeof file === 'string' ? { path: file } : file
    unique.set(`${value.rootId ?? ''}:${value.path.replace(/\\/g, '/')}`, value)
  }
  const queue = [...unique.values()].filter(({ path, rootId }) => !readSessionCodingDiff(threadId, runId, path, rootId))
  const worker = async () => {
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file) return
      await requestSessionCodingDiff(threadId, runId, file.path, file.rootId).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker))
}

export function removeSessionCodingDiff(threadId: string, runId: string, path: string, rootId?: string): void {
  const key = sessionDiffKey(threadId, runId, path, rootId)
  const cached = sharedDiffCache.get(key)
  if (cached) sharedDiffCacheBytes -= cached.size
  sharedDiffCache.delete(key)
}

function writeSessionCodingDiff(key: string, payload: CodingDiffPayload): void {
  const size = (payload.oldContent.length + payload.newContent.length
    + payload.lines.reduce((sum, line) => sum + line.text.length, 0)) * 2
  if (size > MAX_SHARED_DIFF_CACHE_BYTES) return
  const previous = sharedDiffCache.get(key)
  if (previous) sharedDiffCacheBytes -= previous.size
  sharedDiffCache.delete(key)
  sharedDiffCache.set(key, { payload, size })
  sharedDiffCacheBytes += size
  while (sharedDiffCacheBytes > MAX_SHARED_DIFF_CACHE_BYTES) {
    const oldestKey = sharedDiffCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    const oldest = sharedDiffCache.get(oldestKey)
    sharedDiffCache.delete(oldestKey)
    sharedDiffCacheBytes -= oldest?.size ?? 0
  }
}
