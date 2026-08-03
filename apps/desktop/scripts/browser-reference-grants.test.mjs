import assert from "node:assert/strict"
import test from "node:test"
import { BrowserReferenceGrantStore } from "../src/browser-reference-grants.ts"

const target = {
  backend: "iab",
  threadId: "thread-1",
  tabId: "tab-1",
  providerTabId: "provider-1",
  generation: 3,
  title: "Example",
  url: "https://example.com/",
  access: "control",
}

test("reference grants are exact, one-time capabilities", () => {
  const store = new BrowserReferenceGrantStore()
  const grant = store.create(target, 1_000)
  assert.deepEqual(store.consume(grant.referenceGrantId, { ...target, threadId: "thread-2" }, 2_000), { ok: false, reason: "denied" })
  assert.deepEqual(store.consume(grant.referenceGrantId, target, 2_000), { ok: true })
  assert.deepEqual(store.consume(grant.referenceGrantId, target, 2_000), { ok: false, reason: "denied" })
})

test("reference grants expire and become stale after target changes", () => {
  const store = new BrowserReferenceGrantStore()
  const expired = store.create(target, 1_000)
  assert.deepEqual(store.consume(expired.referenceGrantId, target, 1_000 + 30 * 60_000), { ok: false, reason: "expired" })

  const stale = store.create(target, 2_000)
  assert.deepEqual(store.consume(stale.referenceGrantId, { ...target, generation: 4 }, 3_000), { ok: false, reason: "stale" })

  const renamed = store.create(target, 4_000)
  assert.deepEqual(store.consume(renamed.referenceGrantId, { ...target, title: "Changed" }, 5_000), { ok: false, reason: "stale" })
})

test("creating and revoking grants replaces pending access for the same tab", () => {
  const store = new BrowserReferenceGrantStore()
  const first = store.create(target, 1_000)
  const second = store.create(target, 2_000)
  assert.deepEqual(store.consume(first.referenceGrantId, target, 3_000), { ok: false, reason: "denied" })
  assert.equal(store.revoke(second.referenceGrantId, "thread-2"), false)
  assert.equal(store.revoke(second.referenceGrantId, "thread-1"), true)
})
