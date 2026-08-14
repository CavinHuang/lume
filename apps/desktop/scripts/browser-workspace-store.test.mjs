import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserWorkspaceStore } from "../src/browser-workspace-store.ts"

const directories = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe("BrowserWorkspaceStore", () => {
  test("persists user tabs, order, close and restore atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "lume-browser-workspaces-"))
    directories.push(directory)
    const store = new BrowserWorkspaceStore(() => directory)
    store.rememberTab(tab("one", "thread-1"))
    store.rememberTab(tab("two", "thread-1"))
    store.activate("thread-1", "two")
    store.reorder("thread-1", ["two", "one"])
    store.close(tab("two", "thread-1"))

    expect(store.get("thread-1").orderedTabIds).toEqual(["one"])
    expect(store.restoreClosed("thread-1")?.tabId).toBe("two")
    expect(new BrowserWorkspaceStore(() => directory).get("thread-1").orderedTabIds).toEqual(["one", "two"])
    expect(readFileSync(join(directory, "browser", "workspaces.json"), "utf8")).toContain('"version":9')
  })

  test("does not restore ordinary agent tabs and ignores corrupt state", () => {
    const directory = mkdtempSync(join(tmpdir(), "lume-browser-workspaces-"))
    directories.push(directory)
    const store = new BrowserWorkspaceStore(() => directory)
    store.rememberTab({ ...tab("agent", "thread-1"), profileKind: "agent" })
    expect(store.get("thread-1").orderedTabIds).toEqual([])
    store.rememberTab(
      { ...tab("handoff", "thread-1"), profileKind: "agent", handoffStatus: "handoff" },
      { partition: "lume-agent-session-turn", handoffBrowserSessionId: "session" },
    )
    expect(new BrowserWorkspaceStore(() => directory).persistedTabs("thread-1")[0]).toMatchObject({
      tabId: "handoff",
      partition: "lume-agent-session-turn",
      handoffBrowserSessionId: "session",
      handoffStatus: "handoff",
    })
    mkdirSync(join(directory, "browser"), { recursive: true })
    writeFileSync(join(directory, "browser", "workspaces.json"), "not-json")
    expect(new BrowserWorkspaceStore(() => directory).list()).toEqual([])
  })

  test("migrates legacy Agent tabs to the shared persistent profile", () => {
    const directory = mkdtempSync(join(tmpdir(), "lume-browser-workspaces-"))
    directories.push(directory)
    const browserDirectory = join(directory, "browser")
    mkdirSync(browserDirectory, { recursive: true })
    writeFileSync(join(browserDirectory, "workspaces.json"), JSON.stringify({
      version: 8,
      workspaces: { "thread-1": { ownerThreadId: "thread-1", orderedTabIds: ["agent"], recentlyClosed: [], revision: 1 } },
      tabs: {
        agent: {
          ...tab("agent", "thread-1"),
          profileKind: "agent",
          handoffStatus: "deliverable",
          handoffBrowserSessionId: "thread-1",
          partition: "lume-agent-thread-1-turn-1",
        },
      },
    }))

    expect(new BrowserWorkspaceStore(() => directory).persistedTabs("thread-1")[0]).toMatchObject({
      tabId: "agent",
      profileKind: "agent",
      partition: "persist:lume-browser",
      storageKind: "shared",
      handoffStatus: "deliverable",
    })
  })

  test("keeps explicitly isolated Agent tabs isolated in v9", () => {
    const directory = mkdtempSync(join(tmpdir(), "lume-browser-workspaces-"))
    directories.push(directory)
    const store = new BrowserWorkspaceStore(() => directory)
    store.rememberTab(
      { ...tab("isolated", "thread-1"), profileKind: "agent", handoffStatus: "handoff" },
      { partition: "lume-agent-thread-1-turn-1", handoffBrowserSessionId: "thread-1" },
    )
    expect(new BrowserWorkspaceStore(() => directory).persistedTabs("thread-1")[0]).toMatchObject({
      tabId: "isolated",
      partition: "lume-agent-thread-1-turn-1",
      storageKind: "isolated",
    })
  })

  test("reads a v1 workspace and writes it back as v9", () => {
    const directory = mkdtempSync(join(tmpdir(), "lume-browser-workspaces-"))
    directories.push(directory)
    const browserDirectory = join(directory, "browser")
    mkdirSync(browserDirectory, { recursive: true })
    writeFileSync(join(browserDirectory, "workspaces.json"), JSON.stringify({
      version: 1,
      workspaces: { "thread-1": { ownerThreadId: "thread-1", orderedTabIds: ["one"], recentlyClosed: [], revision: 1 } },
      tabs: { one: tab("one", "thread-1") },
    }))

    const store = new BrowserWorkspaceStore(() => directory)
    expect(store.get("thread-1").orderedTabIds).toEqual(["one"])
    store.flush()
    expect(readFileSync(join(browserDirectory, "workspaces.json"), "utf8")).toContain('"version":9')
  })
})

function tab(tabId, ownerThreadId) {
  return {
    tabId,
    providerTabId: `provider-${tabId}`,
    ownerThreadId,
    profileKind: "user",
    backend: "iab",
    generation: 1,
    url: `https://example.com/${tabId}`,
    title: tabId,
    visible: false,
    surface: null,
  }
}
