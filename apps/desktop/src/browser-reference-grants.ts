import { randomUUID } from "node:crypto"

export type BrowserReferenceGrantTarget = {
  backend: "iab" | "extension"
  threadId: string
  tabId: string
  providerTabId?: string
  generation?: number
  title: string
  url: string
  access: "control"
}

type BrowserReferenceGrant = BrowserReferenceGrantTarget & {
  id: string
  expiresAt: number
}

export type BrowserReferenceGrantConsumeResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "expired" | "stale" }

const DEFAULT_REFERENCE_GRANT_TTL_MS = 30 * 60_000

export class BrowserReferenceGrantStore {
  private readonly grants = new Map<string, BrowserReferenceGrant>()

  create(target: BrowserReferenceGrantTarget, now = Date.now()): { referenceGrantId: string; expiresAt: string } {
    for (const [id, grant] of this.grants) {
      if (grant.threadId === target.threadId && grant.backend === target.backend && grant.tabId === target.tabId) {
        this.grants.delete(id)
      }
    }
    const id = randomUUID()
    const expiresAt = now + DEFAULT_REFERENCE_GRANT_TTL_MS
    this.grants.set(id, { ...target, id, expiresAt })
    return { referenceGrantId: id, expiresAt: new Date(expiresAt).toISOString() }
  }

  revoke(referenceGrantId: string, threadId?: string): boolean {
    const grant = this.grants.get(referenceGrantId)
    if (!grant || (threadId && grant.threadId !== threadId)) return false
    return this.grants.delete(referenceGrantId)
  }

  invalidateTab(tabId: string): void {
    for (const [id, grant] of this.grants) if (grant.tabId === tabId) this.grants.delete(id)
  }

  clear(): void {
    this.grants.clear()
  }

  consume(referenceGrantId: string, target: BrowserReferenceGrantTarget, now = Date.now()): BrowserReferenceGrantConsumeResult {
    const grant = this.grants.get(referenceGrantId)
    if (!grant) return { ok: false, reason: "denied" }
    if (grant.expiresAt <= now) {
      this.grants.delete(referenceGrantId)
      return { ok: false, reason: "expired" }
    }
    if (grant.threadId !== target.threadId || grant.backend !== target.backend || grant.tabId !== target.tabId || grant.access !== target.access) {
      return { ok: false, reason: "denied" }
    }
    if (grant.title !== target.title
      || grant.url !== target.url
      || grant.providerTabId !== target.providerTabId
      || grant.generation !== target.generation) {
      this.grants.delete(referenceGrantId)
      return { ok: false, reason: "stale" }
    }
    this.grants.delete(referenceGrantId)
    return { ok: true }
  }
}
