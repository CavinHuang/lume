// packages/sdk/src/session-persistence.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSessions, loadSession, saveSession } from "./session.js"

const tempDirs: string[] = []
const originalSdkHome = process.env.OPEN_AGENT_SDK_HOME

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (originalSdkHome === undefined) {
    delete process.env.OPEN_AGENT_SDK_HOME
  } else {
    process.env.OPEN_AGENT_SDK_HOME = originalSdkHome
  }
})

function useTempSdkHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sdk-session-persist-"))
  tempDirs.push(home)
  process.env.OPEN_AGENT_SDK_HOME = join(home, "sdk-home")
  return join(home, "sdk-home", "sessions")
}

describe("session persistence", () => {
  test("saveSession leaves no tmp residue and all three files parse", async () => {
    const sessionsRoot = useTempSdkHome()

    await saveSession("atomic-1", [{ role: "user", content: "hi" }], { cwd: "/w" })

    const dir = join(sessionsRoot, "atomic-1")
    const entries = readdirSync(dir)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(() => JSON.parse(readFileSync(join(dir, "transcript.json"), "utf-8"))).not.toThrow()
    expect(() => JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"))).not.toThrow()
  })

  test("loadSession rebuilds from jsonl when transcript.json is a torn write (#293 #306)", async () => {
    const sessionsRoot = useTempSdkHome()
    const dir = join(sessionsRoot, "torn-1")
    mkdirSync(dir, { recursive: true })
    // 半截 transcript.json：打开即截断后被崩溃打断的典型残骸
    writeFileSync(join(dir, "transcript.json"), '{"metadata":{"id":"torn-1","cwd":"/w","mes', "utf-8")
    const lines = [
      { uuid: "u1", role: "user", timestamp: "2026-08-22T00:00:00.000Z", content: "hello" },
      { uuid: "a1", role: "assistant", timestamp: "2026-08-22T00:00:01.000Z", content: "world" },
    ]
    writeFileSync(join(dir, "transcript.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8")

    const data = await loadSession("torn-1")

    expect(data).not.toBeNull()
    expect(data?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ])
    expect(data?.sessionMessages).toHaveLength(2)
    expect(data?.metadata.messageCount).toBe(2)
    expect(data?.metadata.createdAt).toBe("2026-08-22T00:00:00.000Z")
    expect(data?.metadata.updatedAt).toBe("2026-08-22T00:00:01.000Z")
  })

  test("loadSession skips a torn trailing line without losing earlier ones", async () => {
    const sessionsRoot = useTempSdkHome()
    const dir = join(sessionsRoot, "torn-line")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({ metadata: { id: "torn-line", cwd: "/w" }, messages: [], sessionMessages: [] }),
      "utf-8",
    )
    writeFileSync(
      join(dir, "transcript.jsonl"),
      [
        JSON.stringify({ uuid: "u1", role: "user", timestamp: "2026-08-22T00:00:00.000Z", content: "keep" }),
        '{"uuid":"a1","role":"assist',
      ].join("\n"),
      "utf-8",
    )

    const data = await loadSession("torn-line")

    expect(data?.sessionMessages).toHaveLength(1)
    expect(data?.sessionMessages?.[0]?.uuid).toBe("u1")
  })

  test("listSessions serves metadata from meta.json even when transcripts are gone", async () => {
    const sessionsRoot = useTempSdkHome()
    await saveSession("meta-only", [{ role: "user", content: "hi" }], { cwd: sessionsRoot })
    const dir = join(sessionsRoot, "meta-only")
    rmSync(join(dir, "transcript.json"))
    rmSync(join(dir, "transcript.jsonl"))

    const sessions = await listSessions({ dir: sessionsRoot })

    expect(sessions.map((item) => item.id)).toContain("meta-only")
  })

  test("listSessions falls back to the full load when meta.json is missing", async () => {
    const sessionsRoot = useTempSdkHome()
    await saveSession("legacy-no-meta", [{ role: "user", content: "hi" }], { cwd: sessionsRoot })
    rmSync(join(sessionsRoot, "legacy-no-meta", "meta.json"))

    const sessions = await listSessions({ dir: sessionsRoot })

    expect(sessions.map((item) => item.id)).toContain("legacy-no-meta")
    expect(sessions[0]?.messageCount).toBe(1)
  })
})
