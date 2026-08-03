import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserAuditLog } from "../src/browser-audit.ts"

test("browser audit persists bounded redacted metadata and can be cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "lume-browser-audit-"))
  const log = new BrowserAuditLog(() => root)
  log.record({ correlationId: "request-1", actor: "agent", browserSessionId: "session", tabId: "tab", backend: "iab", generation: 2, origin: "https://example.test/path?secret=value", action: "fill", decision: "allow", status: "committed", durationMs: 12 })
  const directory = join(root, "browser", "audit")
  const content = readFileSync(join(directory, readdirSync(directory)[0]), "utf8")
  assert.match(content, /"origin":"https:\/\/example\.test"/)
  assert.doesNotMatch(content, /secret|value/)
  log.clear()
  assert.deepEqual(readdirSync(directory), [])
  rmSync(root, { recursive: true, force: true })
})
