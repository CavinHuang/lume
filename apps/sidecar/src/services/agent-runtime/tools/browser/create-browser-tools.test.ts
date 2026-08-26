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
        if (request.method === "create_tab") return { id: tab.tabId }
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot("tab-1")
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const openTool = tools.find((tool) => tool.name === "mcp__browser__open")!
    const openResult = await openTool.call({ url: "https://example.com" }, { toolUseId: "open-1" } as any)
    const opened = JSON.parse(String(openResult.content))
    const snapshot = await call(tools, "mcp__browser__snapshot", {})
    const scoped = await call(tools, "mcp__browser__snapshot", { scope_ref: "@e1" })

    expect(opened.active_tab_id).toBe("tab-1")
    expect(openResult._meta?.repeatGuard).toEqual({
      state: { ok: true, tool: "open", url: "https://example.com", title: null, generation: null }
    })
    expect(snapshot.observation.snapshot_id).toBe("snap-1")
    expect(scoped.observation.refs.e1).toMatchObject({ role: "textbox", name: "Search" })
    expect(calls.at(-1)).toMatchObject({ method: "browser_snapshot", params: { tabId: "tab-1", scope_ref: "@e1", snapshot_id: "snap-1" } })
    expect(calls.map((request) => request.method)).toEqual(["create_tab", "list_tabs", "browser_snapshot", "list_tabs", "browser_snapshot"])
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${calls.length}`)
        if (request.method === "navigate_tab_url") return { ...tab, url: "https://example.org/" }
        if (request.method === "tab_get_js_dialog") return { dialog: { id: "dialog-1", type: "confirm", message: "Continue?" } }
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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
        dispatch: async (request: { method: string }) => request.method === "list_tabs" ? { tabs: [tab] } : undefined,
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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

  test("reports in-progress downloads instead of failing, and polls them by download_id", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    let polled = false
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_wait_for_download") return { download_id: "download-1" }
        if (request.method === "playwright_locator_click") return { ok: true }
        if (request.method === "playwright_download_path") {
          if (request.params?.download_id && polled) {
            return { path: "browser-download:00000000-0000-0000-0000-000000000002", state: "completed", filename: "report.pdf", mime_type: "application/pdf", origin: "https://example.com", total_bytes: 2048, received_bytes: 2048 }
          }
          polled = true
          return { path: null, state: "pending", filename: "report.pdf", mime_type: "application/pdf", origin: "https://example.com", total_bytes: 2048, received_bytes: 1024 }
        }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const timedOut = await rawCall(tools, "mcp__browser__download", { ref: "e1" })
    const pending = JSON.parse(String(timedOut.content))
    const polledResult = await rawCall(tools, "mcp__browser__download", { download_id: "download-1" })
    const completed = JSON.parse(String(polledResult.content))

    expect(timedOut.isError).toBeFalsy()
    expect(pending.action).toMatchObject({ download_id: "download-1", state: "in_progress", filename: "report.pdf", mime_type: "application/pdf", origin: "https://example.com", total_bytes: 2048, received_bytes: 1024 })
    expect(completed).toMatchObject({ ok: true, download_id: "download-1", state: "completed", file_ref: "browser-download:00000000-0000-0000-0000-000000000002", filename: "report.pdf", mime_type: "application/pdf", total_bytes: 2048 })
  })

  test("rejects multi-file upload to a single-file chooser", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_wait_for_file_chooser") return { file_chooser_id: "chooser-1", is_multiple: false }
        if (request.method === "playwright_locator_click") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const result = await rawCall(tools, "mcp__browser__upload", { ref: "e1", files: ["files/a.pdf", "files/b.pdf"] })

    expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, code: "invalid_browser_request", active_tab_id: "locked-tab" })
  })

  test("rejects upload paths that do not match the chooser's accepted types", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_wait_for_file_chooser") return { file_chooser_id: "chooser-1", is_multiple: true, accept: ".pdf,image/*" }
        if (request.method === "playwright_file_chooser_set_files") return {}
        if (request.method === "playwright_locator_click") return { ok: true }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const rejected = await rawCall(tools, "mcp__browser__upload", { ref: "e1", files: ["files/report.exe"] })
    const accepted = await rawCall(tools, "mcp__browser__upload", { ref: "e1", files: ["files/report.pdf", "files/photo.PNG", "browser-download:00000000-0000-0000-0000-000000000003"] })

    expect(JSON.parse(String(rejected.content))).toMatchObject({
      ok: false,
      code: "invalid_browser_request",
      message: expect.stringContaining("report.exe does not match the file input's accepted types"),
    })
    expect(JSON.parse(String(accepted.content))).toMatchObject({ ok: true })
  })

  test("fills a saved password without exposing its value to the tool call", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return { tabs: [tab] }
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
        if (request.method === "list_tabs") return { tabs: [tab] }
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

  test("navigation_timeout carries the observe-first hint in its message (#641)", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "navigate_tab_url") throw new Error("navigation_timeout")
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const raw = await rawCall(tools, "mcp__browser__navigate", { url: "https://slow.example" })
    const result = JSON.parse(String(raw.content))

    expect(raw.is_error).toBeTrue()
    expect(result.code).toBe("navigation_timeout")
    expect(result.retryable).toBe(false)
    expect(result.message).toContain("snapshot")
  })

  test("stops browser mutations after a non-retryable action repeats on the same page", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let actionCalls = 0
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_locator_click") {
          actionCalls += 1
          throw Object.assign(new Error("actionability_failed"), { code: "actionability_failed" })
        }
        if (request.method === "playwright_locator_fill") throw new Error("unexpected_action")
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    const firstSnapshot = await rawCall(tools, "mcp__browser__snapshot", {})
    await rawCall(tools, "mcp__browser__click", { ref: "e1" })
    const secondSnapshot = await rawCall(tools, "mcp__browser__snapshot", {})
    await rawCall(tools, "mcp__browser__click", { ref: "e1" })
    const blocked = await rawCall(tools, "mcp__browser__fill", { ref: "e1", text: "retry" })
    const blockedResult = JSON.parse(String(blocked.content))

    expect(actionCalls).toBe(2)
    expect(blocked.is_error).toBeTrue()
    expect(blockedResult).toMatchObject({ ok: false, code: "repeated_action_failure", retryable: false })
    expect(firstSnapshot._meta?.repeatGuard.state).toEqual(secondSnapshot._meta?.repeatGuard.state)
    expect(firstSnapshot._meta?.repeatGuard.state).not.toHaveProperty("snapshot_id")
  })

  test("circuit-breaks ref-less confirm tools after repeated user declines (#661)", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    let scriptCalls = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_run_script") {
          scriptCalls += 1
          throw Object.assign(new Error("user_declined"), { code: "user_declined" })
        }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await rawCall(tools, "mcp__browser__run_script", { script: "return 1" })
    await rawCall(tools, "mcp__browser__run_script", { script: "return 1" })
    const blocked = await rawCall(tools, "mcp__browser__run_script", { script: "return 1" })
    const blockedResult = JSON.parse(String(blocked.content))

    // 连拒两次后第三次不再触达 broker（无真窗可弹）
    expect(scriptCalls).toBe(2)
    expect(blockedResult).toMatchObject({ ok: false, code: "repeated_action_failure", retryable: false })
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

  test("reports expired snapshot cursors as retryable and drops the cached snapshot", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") {
          const cursor = request.params?.cursor
          if (cursor) throw Object.assign(new Error("stale_snapshot_cursor"), { code: "stale_snapshot_cursor" })
          return semanticSnapshot(tab.tabId)
        }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const expired = await rawCall(tools, "mcp__browser__snapshot", { cursor: "expired-cursor" })
    const result = JSON.parse(String(expired.content))
    const afterExpiry = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })

    expect(result).toMatchObject({ ok: false, code: "stale_snapshot_cursor", retryable: true })
    expect(JSON.parse(String(afterExpiry.content)).code).toBe("stale_target")
  })

  test("drops the cached snapshot when the user takes over the page", async () => {
    const tab = agentTab("locked-tab", "thread-1")
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string }) => {
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId)
        if (request.method === "playwright_locator_click") throw Object.assign(new Error("user_takeover_required"), { code: "user_takeover_required" })
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const takeover = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })
    const afterTakeover = await rawCall(tools, "mcp__browser__click", { ref: "@e1" })

    expect(JSON.parse(String(takeover.content)).code).toBe("user_takeover_required")
    // 接管后旧 ref 不可用：缓存快照已清，重试必须先重新观察
    expect(JSON.parse(String(afterTakeover.content)).code).toBe("stale_target")
  })

  test("skips the post-action rescan when desktop reports no_detectable_change (#604)", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const tab = agentTab("locked-tab", "thread-1")
    let snapshotNumber = 0
    const broker = {
      listBackends: () => [{ backend: "iab" }],
      dispatch: async (request: { method: string; params?: Record<string, unknown> }) => {
        calls.push(request)
        if (request.method === "list_tabs") return { tabs: [tab] }
        if (request.method === "browser_snapshot") return semanticSnapshot(tab.tabId, `snap-${++snapshotNumber}`)
        if (request.method === "playwright_locator_hover") return { ok: true, effect: { kind: "no_detectable_change" } }
        if (request.method === "playwright_locator_click") return { ok: true, effect: { kind: "dom_changed" } }
        throw new Error("unsupported")
      },
    } as any
    const tools = createBrowserMcpTools({ broker, sessionRegistry: new BrowserToolSessionRegistry(), threadId: "thread-1" })

    await call(tools, "mcp__browser__snapshot", {})
    const unchanged = await call(tools, "mcp__browser__hover", { ref: "@e1" })
    const changed = await call(tools, "mcp__browser__click", { ref: "@e1" })

    // hover 无可检测变化：不重扫，旧 refs 保持有效；click 有变化：正常全量观察
    expect(calls.filter((request) => request.method === "browser_snapshot")).toHaveLength(2)
    expect(unchanged.observation_unchanged).toBe(true)
    expect(unchanged.observation).toBeUndefined()
    expect(changed.observation.snapshot_id).toBe("snap-2")
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
