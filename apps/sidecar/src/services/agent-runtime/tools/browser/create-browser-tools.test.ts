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
        if (request.method === "browser_snapshot") return semanticSnapshot("tab-1")
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

  test("navigates only the locked tab and handles blocking dialogs explicitly", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${calls.length}`)
        if (request.method === "navigate_tab_url") return { ...tab, url: "https://example.org/" }
        if (request.method === "tab_get_js_dialog") return { id: "dialog-1", type: "confirm", message: "Continue?" }
        if (request.method === "tab_handle_js_dialog") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const navigated = await call(tools, "mcp__browser__navigate", { url: "https://example.org/" })
    const dialog = await call(tools, "mcp__browser__dialog", {})
    const handled = await call(tools, "mcp__browser__handle_dialog", { dialog_id: "dialog-1", accept: false })

    expect(calls.find((request) => request.method === "navigate_tab_url")).toMatchObject({ params: { tabId: "locked-tab", url: "https://example.org/" } })
    expect(dialog.dialog).toMatchObject({ id: "dialog-1", type: "confirm" })
    expect(calls.find((request) => request.method === "tab_handle_js_dialog")).toMatchObject({ params: { tabId: "locked-tab", dialog_id: "dialog-1", action: "dismiss" } })
    expect(navigated.observation.snapshot_id).toStartWith("snap-")
    expect(handled.observation.snapshot_id).toStartWith("snap-")
  })

  test("resolves snapshot refs into semantic actions and observes after every action", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_locator_fill") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", { interactive_only: true })
    const result = await call(tools, "mcp__browser__fill", { ref: "@e1", text: "agent" })

    expect(calls.at(-2)).toMatchObject({
      method: "playwright_locator_fill",
      params: {
        tabId: "locked-tab",
        text: "agent",
        semanticRef: "e1",
        semanticSnapshotId: "snap-1",
        semanticIntent: "textbox Search",
        locator: { version: 1, steps: [{ kind: "role", role: "textbox", name: "Search", exact: true }] },
      },
    })
    expect(calls.at(-1)).toMatchObject({ method: "browser_snapshot", params: { tabId: "locked-tab", interactive_only: true } })
    expect(result.observation.snapshot_id).toBe("snap-2")
  })

  test("returns screenshots as transient image content without putting pixels in text", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const pixels = Buffer.from("jpeg-pixels").toString("base64")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return [tab]
        if (request.method === "tab_screenshot") return { data: pixels }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const result = await rawCall(tools, "mcp__browser__screenshot", {})

    expect(result.content[0].text).not.toContain(pixels)
    expect(result.content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: pixels },
      _meta: { persist: false },
    })
  })

  test("binds annotated screenshots to refs from the latest snapshot", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    const pixels = Buffer.from("png-pixels").toString("base64")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, "snap-1")
        if (request.method === "tab_screenshot") return { data: pixels, annotated_refs: ["@e1"] }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const result = await rawCall(tools, "mcp__browser__screenshot", { annotated: true })

    expect(calls.at(-1)).toMatchObject({
      method: "tab_screenshot",
      params: { tabId: "locked-tab", annotated: true, fullPage: false, semanticSnapshotId: "snap-1" },
    })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ annotated: true, snapshot_id: "snap-1", annotated_refs: ["@e1"] })
    expect(result.content[1]).toMatchObject({ type: "image", source: { media_type: "image/png", data: pixels } })
  })

  test("requires a fresh snapshot before an annotated screenshot", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const tools = createBrowserMcpTools({
      broker: {
        listBackends: () => [{ backend: "iab" }],
        dispatch: async (request: { method: string }) => request.method === "list_tabs" ? [tab] : undefined,
      } as any,
      sessionRegistry: new BrowserToolSessionRegistry(),
      threadId: "thread-1",
    })

    const result = await rawCall(tools, "mcp__browser__screenshot", { annotated: true })

    expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, code: "snapshot_required" })
  })

  test("coordinates file chooser uploads and click-triggered downloads", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_wait_for_file_chooser") return { file_chooser_id: "chooser-1", is_multiple: false }
        if (request.method === "playwright_file_chooser_set_files") return {}
        if (request.method === "playwright_wait_for_download") return { download_id: "download-1" }
        if (request.method === "playwright_download_path") return { path: "browser-download:00000000-0000-0000-0000-000000000001" }
        if (request.method === "playwright_locator_click") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const uploaded = await call(tools, "mcp__browser__upload", { ref: "e1", files: ["files/report.pdf"] })
    const downloadResult = await rawCall(tools, "mcp__browser__download", { ref: "e1" })
    const downloaded = JSON.parse(String(downloadResult.content))

    expect(calls.find((request) => request.method === "playwright_file_chooser_set_files")).toMatchObject({
      params: { tabId: "locked-tab", file_chooser_id: "chooser-1", files: ["files/report.pdf"] },
    })
    expect(uploaded.action.count).toBe(1)
    expect(downloaded.action.file_ref).toBe("browser-download:00000000-0000-0000-0000-000000000001")
    expect(downloadResult._meta?.repeatGuard.state.file_ref).toBe("browser-download:00000000-0000-0000-0000-000000000001")
    const methods = calls.map((request) => request.method)
    expect(methods).toContain("playwright_wait_for_file_chooser")
    expect(methods).toContain("playwright_wait_for_download")
    expect(methods).toContain("playwright_download_path")
  })

  test("fills a saved password without exposing its value to the tool call", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${calls.length}`)
        if (request.method === "browser_list_secrets") return [{ id: "secret-1", origin: "https://example.com", username: "alice" }]
        if (request.method === "browser_fill_secret") return { status: "submitted" }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const secrets = await call(tools, "mcp__browser__list_secrets", {})
    await call(tools, "mcp__browser__snapshot", {})
    const filled = await call(tools, "mcp__browser__fill_secret", { ref: "e1", secret_id: "secret-1" })

    expect(secrets.secrets).toEqual([{ id: "secret-1", origin: "https://example.com", username: "alice" }])
    expect(filled.action).toEqual({ status: "submitted" })
    const fill = calls.find((request) => request.method === "browser_fill_secret")
    expect(fill).toMatchObject({ params: { secret_id: "secret-1", semanticRef: "e1" } })
    expect(JSON.stringify(fill)).not.toContain("password-value")
  })

  test("rejects refs without a current snapshot or after the locked tab disappears", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let tabs = [tab]
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return tabs
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId)
        throw new Error("unexpected_action")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const beforeSnapshot = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })
    await call(tools, "mcp__browser__snapshot", {})
    tabs = [agentTab("different-tab", "thread-1")]
    const afterClose = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })
    const stillLocked = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })

    expect(JSON.parse(String(beforeSnapshot.content)).code).toBe("stale_target")
    expect(JSON.parse(String(afterClose.content)).code).toBe("tab_not_found")
    expect(JSON.parse(String(stillLocked.content)).code).toBe("tab_not_found")
    expect(beforeSnapshot.is_error).toBeTrue()
    expect(afterClose.is_error).toBeTrue()
  })

  test("does not report a completed action as failed when its follow-up snapshot fails", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let snapshots = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return [tab]
        if (request.method === "browser_snapshot") {
          if (++snapshots === 1) return semanticSnapshot(tab.tabId)
          throw new Error("stale_target")
        }
        if (request.method === "playwright_locator_click") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const raw = await rawCall(tools, "mcp__browser__click", { ref: "e1" })
    const result = JSON.parse(String(raw.content))

    expect(raw.is_error).toBeUndefined()
    expect(result).toMatchObject({ ok: true, action: { ok: true }, observation: null, observation_error: "stale_target", requires_snapshot: true })
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
  const result = await rawCall(tools, name, args)
  return JSON.parse(String(result.content))
}

async function rawCall(tools: ReturnType<typeof createBrowserMcpTools>, name: string, args: Record<string, unknown>): Promise<any> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool.call(args, { toolUseId: `call-${name}` } as any)
}

function semanticSnapshot(tabId: string, snapshotId = "snap-1") {
  return {
    snapshot_id: snapshotId,
    tab_id: tabId,
    navigation_generation: 1,
    tree: '- textbox "Search" [ref=e1]',
    refs: { e1: { role: "textbox", name: "Search" } },
  }
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
