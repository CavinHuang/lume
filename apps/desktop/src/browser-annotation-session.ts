import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentBrowserAnnotationAttachment,
  AgentBrowserAnchor,
  AgentBrowserDesignChangeAttachment,
  AgentBrowserDesignDeclaration,
  BrowserAnnotationSessionSnapshot,
} from '../../../packages/shared/src/types/agent'

type StoredSession = BrowserAnnotationSessionSnapshot

const MAX_SESSIONS = 100
const MAX_COMMENTS = 100
const MAX_BODY = 20_000

export class BrowserAnnotationSessionStore {
  private readonly path: string
  private sessions = new Map<string, StoredSession>()
  private readonly onDiscardedScreenshots?: (threadId: string, refs: string[]) => void

  constructor(configDir: () => string, hooks?: { onDiscardedScreenshots?: (threadId: string, refs: string[]) => void }) {
    this.onDiscardedScreenshots = hooks?.onDiscardedScreenshots
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

  setActiveDesignChange(input: {
    threadId: string
    tabId: string
    url: string
    generation: number
    id: string
    anchor: AgentBrowserAnchor
    declarations: AgentBrowserDesignDeclaration[]
    text?: { previousValue: string; value: string }
    comment?: string
    // Task 74：Alt 多选追加。缺省时保留现有 additionalAnchors（DesignEditor submit 不清空）；
    // 传入时追加（非覆盖）。cap 32 个选区（与 comments 64 / sessions 100 同防御意图）。
    appendAdditionalAnchors?: AgentBrowserAnchor[]
  }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(input.threadId, input.tabId, input.url, input.generation)
    const existingAdditional = snapshot.activeDesignChange?.additionalAnchors ?? []
    const appended = input.appendAdditionalAnchors ?? []
    const additionalAnchors = [...existingAdditional, ...appended].slice(0, 32)
    const next = {
      ...snapshot,
      mode: 'comment' as const,
      activeDesignChange: {
        id: input.id.slice(0, 256),
        anchor: input.anchor,
        declarations: input.declarations.slice(0, 64),
        ...(input.text ? { text: input.text } : {}),
        ...(input.comment ? { comment: input.comment.slice(0, MAX_BODY) } : {}),
        ...(additionalAnchors.length > 0 ? { additionalAnchors } : {}),
      },
      updatedAt: new Date().toISOString(),
    }
    this.write(next)
    return next
  }

  // Task 74：Alt 多选移除（Codex §1.3）。按 selectionIndex 从 activeDesignChange.additionalAnchors
  // 移除一条；越界或无 activeDesignChange 时 no-op（不写盘）。host 是 additionalAnchors 单一来源。
  removeAnnotationSelection(input: {
    threadId: string
    tabId: string
    url: string
    generation: number
    selectionIndex: number
  }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(input.threadId, input.tabId, input.url, input.generation)
    const current = snapshot.activeDesignChange?.additionalAnchors
    if (!current || !Number.isInteger(input.selectionIndex) || input.selectionIndex < 0 || input.selectionIndex >= current.length) return snapshot
    const additionalAnchors = current.filter((_, i) => i !== input.selectionIndex)
    const next = {
      ...snapshot,
      activeDesignChange: {
        ...snapshot.activeDesignChange!,
        ...(additionalAnchors.length > 0 ? { additionalAnchors } : {}),
      },
      updatedAt: new Date().toISOString(),
    }
    // additionalAnchors 为空时从 activeDesignChange 移除该字段（保持 undefined 语义）
    if (additionalAnchors.length === 0) {
      const dc = next.activeDesignChange as { additionalAnchors?: AgentBrowserAnchor[] }
      delete dc.additionalAnchors
    }
    this.write(next)
    return next
  }

  clearActiveDesignChange(threadId: string, tabId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const { activeDesignChange: _activeDesignChange, ...without } = snapshot
    const next = { ...without, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  // Task 71：design-editor 5c 交互状态合并 setter。仅更新入参提供的字段，未传字段保留原值
  // （合并语义，参照 setMode 的条件展开）。三字段均为可选布尔；false 是有效值（key released
  // / 关闭），不能用 ?? undefined 吃掉——故用 !== undefined 守卫。
  setDesignFlags(input: {
    threadId: string
    tabId: string
    url: string
    generation: number
    isDesignModifierPressed?: boolean
    isOriginalViewEnabled?: boolean
    isTweaksEditorOpen?: boolean
  }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(input.threadId, input.tabId, input.url, input.generation)
    const next = {
      ...snapshot,
      ...(input.isDesignModifierPressed !== undefined ? { isDesignModifierPressed: input.isDesignModifierPressed } : {}),
      ...(input.isOriginalViewEnabled !== undefined ? { isOriginalViewEnabled: input.isOriginalViewEnabled } : {}),
      ...(input.isTweaksEditorOpen !== undefined ? { isTweaksEditorOpen: input.isTweaksEditorOpen } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.write(next)
    return next
  }

  saveComment(comment: AgentBrowserAnnotationAttachment): BrowserAnnotationSessionSnapshot {
    const threadId = comment.tab.ownerThreadId ?? ''
    if (!threadId) throw new Error('annotation_owner_thread_required')
    const snapshot = this.get(threadId, comment.tab.tabId, comment.tab.url, comment.tab.generation ?? 1)
    const comments = this.capComments(threadId, [
      ...snapshot.comments.filter((item) => item.id !== comment.id),
      { ...comment, body: comment.body.slice(0, MAX_BODY), createdAt: comment.createdAt ?? new Date().toISOString() },
    ])
    const next = { ...snapshot, comments, activeDraft: undefined, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  // Task 54：落盘 design-change attachment。designChange 是 AgentBrowserAttachment union 的
  // 另一成员（origin 'browser-design-change'，body 可选，无 createdAt 字段），与 saveComment
  // 的入参 AgentBrowserAnnotationAttachment 不是同一类型——故 store 增设专用方法，避免在
  // manager 层用 `as unknown as` 跨类型 cast。落盘后清空 activeDesignChange（与 saveComment
  // 清空 activeDraft 对称）。comments 数组运行期可容纳两种 origin，类型层维持 A[] 由 cast 收敛。
  saveDesignChange(attachment: AgentBrowserDesignChangeAttachment): BrowserAnnotationSessionSnapshot {
    const threadId = attachment.tab.ownerThreadId ?? ''
    if (!threadId) throw new Error('annotation_owner_thread_required')
    const snapshot = this.get(threadId, attachment.tab.tabId, attachment.tab.url, attachment.tab.generation ?? 1)
    // designChange 的 origin 'browser-design-change' 与 annotation 的 'browser-annotation'
    // 是不兼容的字面量类型；TS 拒绝直接 cast。先 unknown 再 annotation，表达「形状足够接近、
    // 运行期共用 comments 数组槽位」的意图（A.6 spec：comments 列表混合两类 attachment）。
    const comment = {
      ...attachment,
      body: (attachment.body ?? '').slice(0, MAX_BODY),
      createdAt: new Date().toISOString(),
    } as unknown as AgentBrowserAnnotationAttachment
    const comments = this.capComments(threadId, [
      ...snapshot.comments.filter((item) => item.id !== comment.id),
      comment,
    ])
    const next = { ...snapshot, comments, activeDesignChange: undefined, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  deleteComment(threadId: string, tabId: string, annotationId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const next = { ...snapshot, comments: snapshot.comments.filter((item) => item.id !== annotationId), updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  // Task 92：翻目标评论的 isResolved + 写 resolvedAt/resolvedBy。
  // 翻 boolean 的语义：存在则置 true（resolveComment 仅做「解决」，不做 toggle——
  // unresolve 由 host 用 saveComment 直接覆盖 isResolved=false 处理，与 Codex 一致）。
  // 目标评论不存在时 no-op 返回当前 snapshot（不写盘），与 removeAnnotationSelection 越界策略一致。
  resolveComment(threadId: string, tabId: string, url: string, generation: number, annotationId: string, resolvedBy: 'user' | 'agent'): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    let touched = false
    const comments = snapshot.comments.map((comment) => {
      if (comment.id !== annotationId) return comment
      touched = true
      return { ...comment, isResolved: true, resolvedAt: new Date().toISOString(), resolvedBy }
    })
    if (!touched) return snapshot
    const next = { ...snapshot, comments, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }

  // Task 92：复用 saveComment 落盘 reply，并补线程字段：reviewThreadId 派生为
  // parent.reviewThreadId ?? parent.id（reply-of-reply 时继承根线程 id），inReplyToId = parent.id。
  // parent 形状用最小局部类型（仅取线程派生所需字段，避免耦合 Attachment 全部必填字段）。
  addReply(threadId: string, tabId: string, url: string, generation: number, parent: { reviewThreadId?: string; id: string }, reply: AgentBrowserAnnotationAttachment): BrowserAnnotationSessionSnapshot {
    return this.saveComment({
      ...reply,
      reviewThreadId: parent.reviewThreadId ?? parent.id,
      inReplyToId: parent.id,
    })
  }

  // Task 92：写 readAt = ISO 时间戳。与 resolveComment 同策略：目标评论不存在时 no-op。
  markRead(threadId: string, tabId: string, url: string, generation: number, annotationId: string): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    let touched = false
    const comments = snapshot.comments.map((comment) => {
      if (comment.id !== annotationId) return comment
      touched = true
      return { ...comment, readAt: new Date().toISOString() }
    })
    if (!touched) return snapshot
    const next = { ...snapshot, comments, updatedAt: new Date().toISOString() }
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
        this.write({ ...snapshot, comments: this.capComments(threadId, [...snapshot.comments, comment]), updatedAt: new Date().toISOString() })
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
      comments: this.capComments(snapshot.threadId, snapshot.comments),
      updatedAt: new Date().toISOString(),
    })
    // FIFO 淘汰的会话无人再引用其截图文件,须回调清理——否则 review-resources 孤儿 PNG 永久累积(#130)
    while (this.sessions.size > MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string
      const evicted = this.sessions.get(oldestKey)
      this.sessions.delete(oldestKey)
      if (evicted) this.discardSessionScreenshots(evicted)
    }
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(this.sessions), null, 2), { mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }

  // 评论截断统一入口:被 slice 丢弃的评论若带截图引用且回调方未保留,交 hooks 清理文件(#130)
  private capComments(threadId: string, comments: AgentBrowserAnnotationAttachment[]): AgentBrowserAnnotationAttachment[] {
    if (comments.length <= MAX_COMMENTS) return comments
    const kept = comments.slice(-MAX_COMMENTS)
    const keptRefs = new Set(kept.map((comment) => comment.screenshotRef).filter((ref): ref is string => Boolean(ref)))
    const discarded = [...new Set(comments.slice(0, comments.length - MAX_COMMENTS)
      .map((comment) => comment.screenshotRef)
      .filter((ref): ref is string => Boolean(ref)))]
      .filter((ref) => !keptRefs.has(ref))
    if (discarded.length) this.onDiscardedScreenshots?.(threadId, discarded)
    return kept
  }

  // 会话淘汰时收集其全部截图引用;其他存活会话仍引用的(共享防御)不清理(#130)
  private discardSessionScreenshots(evicted: StoredSession): void {
    const refs = new Set<string>()
    for (const comment of evicted.comments) if (comment.screenshotRef) refs.add(comment.screenshotRef)
    if (evicted.screenshotRef) refs.add(evicted.screenshotRef)
    for (const session of this.sessions.values()) {
      for (const comment of session.comments) if (comment.screenshotRef) refs.delete(comment.screenshotRef)
      if (session.screenshotRef) refs.delete(session.screenshotRef)
    }
    if (refs.size) this.onDiscardedScreenshots?.(evicted.threadId, [...refs])
  }

  /**
   * 全量会话当前引用的截图 ref 集合（内存态=活跃引用源），孤儿 GC 三源并集之一(#188)。
   * comments[].screenshotRef 之外也收快照顶层 screenshotRef（write 持久化的派生字段，防御性收取）。
   */
  collectAllScreenshotRefs(): Set<string> {
    const refs = new Set<string>()
    for (const session of this.sessions.values()) {
      if (typeof session.screenshotRef === 'string') refs.add(session.screenshotRef)
      for (const comment of session.comments) {
        if (typeof comment.screenshotRef === 'string') refs.add(comment.screenshotRef)
      }
    }
    return refs
  }

  private restore(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (!isStoredSession(value)) continue
        // Task 71：交互 flag 是瞬时 UI 状态，恢复时一律清空（重启后 Alt 未按 / 原始视图关闭 / tweaks 面板关）
        this.sessions.set(key, { ...value, mode: 'browse', selectionPurpose: undefined, activeDraft: undefined, activeDesignChange: undefined, isDesignModifierPressed: undefined, isOriginalViewEnabled: undefined, isTweaksEditorOpen: undefined, comments: this.capComments(value.threadId, value.comments) })
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
