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

    const openTool = tools.find((tool) => tool.name === "mcp__browser__open")!
    const openResult = await openTool.call({ url: "https://example.com" }, { toolUseId: "open-1" } as any)
    const opened = JSON.parse(String(openResult.content))
    const snapshot = await call(tools, "mcp__browser__snapshot", {})

    expect(opened.active_tab_id).toBe("tab-1")
    expect(openResult._meta?.repeatGuard).toEqual({
      state: { ok: true, tool: "open", url: "https://example.com", title: "tab-1", generation: 1 }
    })
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

  test("runs a bounded script only on the locked task tab", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_run_script") return { status: "completed", value: { title: "Example" } }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const result = await call(tools, "mcp__browser__run_script", { script: "return { title: document.title }", arg: { expected: true } })

    expect(result.value).toEqual({ title: "Example" })
    expect(calls.at(-1)).toMatchObject({
      method: "browser_run_script",
      params: { tabId: "locked-tab", script: "return { title: document.title }", arg: { expected: true } },
    })
  })

  test("returns script exceptions as structured tool errors", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => request.method === "list_tabs"
        ? [tab]
        : { status: "exception", exception: { message: "Error: boom" } },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const tool = tools.find((candidate) => candidate.name === "mcp__browser__run_script")!
    const raw = await tool.call({ script: "throw new Error('boom')" }, { toolUseId: "script-error" } as any)
    const result = JSON.parse(String(raw.content))

    expect(raw.is_error).toBeTrue()
    expect(result).toMatchObject({ ok: false, code: "script_exception", message: "Error: boom" })
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
