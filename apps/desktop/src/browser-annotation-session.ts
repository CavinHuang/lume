import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentBrowserAnnotationAttachment,
  AgentBrowserAnchor,
  BrowserAnnotationSessionSnapshot,
} from '../../../packages/shared/src/types/agent'

type StoredSession = BrowserAnnotationSessionSnapshot

const MAX_SESSIONS = 100
const MAX_COMMENTS = 100
const MAX_BODY = 20_000

export class BrowserAnnotationSessionStore {
  private readonly path: string
  private sessions = new Map<string, StoredSession>()

  constructor(configDir: () => string) {
    const directory = join(configDir(), 'browser')
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, 'annotation-sessions-v2.json')
    this.restore()
  }

  get(threadId: string, tabId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const key = sessionKey(threadId, tabId)
    const current = this.sessions.get(key)
    if (current) {
      const currentScreenshotRef = current.comments.find((comment) => comment.tab.url === url && comment.screenshotRef)?.screenshotRef
      return {
        ...current,
        threadId,
        tabId,
        url,
        generation,
        ...(currentScreenshotRef ? { screenshotRef: currentScreenshotRef } : { screenshotRef: undefined }),
        comments: current.comments.map((comment) => ({ ...comment, tab: { ...comment.tab }, anchor: { ...comment.anchor } })),
      }
    }
    return {
      version: 2,
      threadId,
      tabId,
      url,
      generation,
      mode: 'browse',
      comments: [],
      updatedAt: new Date().toISOString(),
    }
  }

  setMode(threadId: string, tabId: string, url: string, generation: number, mode: BrowserAnnotationSessionSnapshot['mode'], selectionPurpose?: BrowserAnnotationSessionSnapshot['selectionPurpose'], theme?: string): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const next = { ...snapshot, mode, ...(mode === 'comment' && selectionPurpose ? { selectionPurpose } : {}), ...(mode === 'browse' ? { selectionPurpose: undefined } : {}), ...(theme ? { theme } : {}), updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  setDraft(input: {
    threadId: string
    tabId: string
    url: string
    generation: number
    id?: string
    anchor: AgentBrowserAnchor
    body: string
    purpose?: 'annotation' | 'tweaks'
  }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(input.threadId, input.tabId, input.url, input.generation)
    const next = {
      ...snapshot,
      mode: 'comment' as const,
      activeDraft: {
        ...(input.id ? { id: input.id } : {}),
        anchor: input.anchor,
        body: input.body.slice(0, MAX_BODY),
        ...(input.purpose ? { purpose: input.purpose } : {}),
      },
      updatedAt: new Date().toISOString(),
    }
    this.write(next)
    return next
  }

  clearDraft(threadId: string, tabId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const { activeDraft: _activeDraft, ...withoutDraft } = snapshot
    const next = { ...withoutDraft, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  saveComment(comment: AgentBrowserAnnotationAttachment): BrowserAnnotationSessionSnapshot {
    const threadId = comment.tab.ownerThreadId ?? ''
    if (!threadId) throw new Error('annotation_owner_thread_required')
    const snapshot = this.get(threadId, comment.tab.tabId, comment.tab.url, comment.tab.generation ?? 1)
    const comments = [
      ...snapshot.comments.filter((item) => item.id !== comment.id),
      { ...comment, body: comment.body.slice(0, MAX_BODY), createdAt: comment.createdAt ?? new Date().toISOString() },
    ].slice(-MAX_COMMENTS)
    const next = { ...snapshot, comments, activeDraft: undefined, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  deleteComment(threadId: string, tabId: string, annotationId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const next = { ...snapshot, comments: snapshot.comments.filter((item) => item.id !== annotationId), updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  clearComments(threadId: string, tabId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const comments = snapshot.comments.filter((comment) => comment.tab.url !== url)
    const next = { ...snapshot, comments, activeDraft: snapshot.activeDraft?.anchor.url === url ? undefined : snapshot.activeDraft, screenshotRef: undefined, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  setScreenshot(threadId: string, tabId: string, url: string, generation: number, screenshot: { ref: string; filename?: string; mode: 'necessary' | 'always'; width?: number; height?: number; deviceScaleFactor?: number }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const comments = snapshot.comments.map((comment) => comment.tab.url === url
      ? { ...comment, screenshotRef: screenshot.ref, screenshot: { ...screenshot } }
      : comment)
    const next = { ...snapshot, comments, screenshotRef: screenshot.ref, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  importLegacy(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
    let imported = 0
    for (const rawSession of Object.values(value as Record<string, unknown>)) {
      if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) continue
      const session = rawSession as { ownerThreadId?: unknown; tabId?: unknown; url?: unknown; generation?: unknown; items?: unknown }
      const threadId = typeof session.ownerThreadId === 'string' ? session.ownerThreadId.slice(0, 200) : ''
      const tabId = typeof session.tabId === 'string' ? session.tabId.slice(0, 256) : ''
      if (!threadId || !tabId || !Array.isArray(session.items)) continue
      for (const rawItem of session.items) {
        if (!rawItem || typeof rawItem !== 'object') continue
        const item = rawItem as { attachment?: unknown }
        const attachment = item.attachment as Partial<AgentBrowserAnnotationAttachment> | undefined
        if (attachment?.origin !== 'browser-annotation' || !attachment.id || !attachment.tab || !attachment.anchor || typeof attachment.body !== 'string') continue
        const comment: AgentBrowserAnnotationAttachment = {
          ...attachment,
          id: String(attachment.id).slice(0, 256),
          body: attachment.body.slice(0, MAX_BODY),
          tab: { ...attachment.tab, ownerThreadId: threadId },
          createdAt: attachment.createdAt ?? new Date().toISOString(),
        } as AgentBrowserAnnotationAttachment
        const snapshot = this.get(threadId, tabId, typeof session.url === 'string' ? session.url : comment.tab.url, Number.isInteger(session.generation) ? Number(session.generation) : comment.tab.generation ?? 1)
        if (snapshot.comments.some((existing) => existing.id === comment.id)) continue
        this.write({ ...snapshot, comments: [...snapshot.comments, comment].slice(-MAX_COMMENTS), updatedAt: new Date().toISOString() })
        imported += 1
      }
    }
    return imported
  }

  private write(snapshot: BrowserAnnotationSessionSnapshot): void {
    const key = sessionKey(snapshot.threadId, snapshot.tabId)
    this.sessions.set(key, {
      ...snapshot,
      version: 2,
      comments: snapshot.comments.slice(-MAX_COMMENTS),
      updatedAt: new Date().toISOString(),
    })
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string)
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(this.sessions), null, 2), { mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }

  private restore(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (!isStoredSession(value)) continue
        this.sessions.set(key, { ...value, mode: 'browse', selectionPurpose: undefined, activeDraft: undefined, comments: value.comments.slice(-MAX_COMMENTS) })
      }
    } catch {
      this.sessions.clear()
    }
  }
}

export function sessionKey(threadId: string, tabId: string): string {
  return `${threadId}\u0000${tabId}`
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Partial<StoredSession>
  return session.version === 2
    && typeof session.threadId === 'string'
    && typeof session.tabId === 'string'
    && typeof session.url === 'string'
    && Number.isInteger(session.generation)
    && (session.mode === 'browse' || session.mode === 'comment')
    && Array.isArray(session.comments)
}
