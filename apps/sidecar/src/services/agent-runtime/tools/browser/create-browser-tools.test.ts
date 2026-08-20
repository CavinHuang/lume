import { describe, expect, test } from "bun:test"
import type { BrowserTabDescriptor } from "@lume/shared"
import { BrowserToolSessionRegistry } from "./browser-tool-session"
import { createBrowserMcpTools } from "./create-browser-tools"

describe("createBrowserMcpTools", () => {
  test("opens an Agent tab and snapshots it without a Node REPL", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown>; browserSessionId: string; browserTurnId: string }> = []
    const tab = agentTab("tab-1", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: typeof calls[number]) => {
        calls.push(request)
        if (request.method === "create_tab") return tab
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return { snapshot_id: "snap-1", tree: '- textbox "Search" [ref=e1]' }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const opened = await call(tools, "mcp__browser__open", { url: "https://example.com" })
    const snapshot = await call(tools, "mcp__browser__snapshot", {})

    expect(opened.active_tab_id).toBe("tab-1")
    expect(snapshot.observation.snapshot_id).toBe("snap-1")
    expect(calls.map((request) => request.method)).toEqual(["create_tab", "list_tabs", "browser_snapshot"])
    expect(new Set(calls.map((request) => request.browserSessionId))).toEqual(new Set(["browser-tools:thread-1"]))
    expect(new Set(calls.map((request) => request.browserTurnId))).toEqual(new Set(["browser-tools:thread-1"]))
  })

  test("lists only Agent-owned tabs from the current task and switches explicitly", async () => {
    const tabs = [agentTab("mine", "thread-1"), agentTab("other", "thread-2"), { ...agentTab("user", "thread-1"), profileKind: "user" as const }]
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async () => tabs,
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const listed = await call(tools, "mcp__browser__list_tabs", {})
    const switched = await call(tools, "mcp__browser__switch_tab", { tab_id: "mine" })

    expect(listed.tabs.map((tab: BrowserTabDescriptor) => tab.tabId)).toEqual(["mine"])
    expect(switched.active_tab_id).toBe("mine")
  })
})

async function call(tools: ReturnType<typeof createBrowserMcpTools>, name: string, args: Record<string, unknown>): Promise<any> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  const result = await tool.call(args, { toolUseId: `call-${name}` } as any)
  return JSON.parse(String(result.content))
}

function agentTab(tabId: string, ownerThreadId: string): BrowserTabDescriptor {
  return {
    tabId,
    ownerThreadId,
    profileKind: "agent",
    backend: "iab",
    generation: 1,
    url: "https://example.com",
    title: tabId,
    visible: false,
    surface: null,
  }
}
