import { describe, expect, mock, test } from "bun:test"

mock.module("@lume/shared", () => ({
  AGENT_IPC_CHANNELS: {
    GET_THREAD_PATH: "agent:get-thread-path",
    GET_WORKSPACE_RESOURCES_PATH: "agent:get-workspace-resources-path",
  },
}))

const calls: Array<{ fn: string; args: unknown[] }> = []
let saveDialogResult: string | null = "/target/copied.md"

mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async (method: string, params: unknown) => {
    calls.push({ fn: "sidecarCall", args: [method, params] })
    if (method === "agent:get-thread-path") return "/data/threads/t1"
    if (method === "agent:get-workspace-resources-path") return "/data/ws/resources"
    throw new Error(`unexpected ${method}`)
  },
  openInSystem: async (path: string) => { calls.push({ fn: "openInSystem", args: [path] }) },
  revealPathInSystem: async (path: string) => { calls.push({ fn: "revealPathInSystem", args: [path] }) },
  saveFilePathDialog: async (filename: string, filters?: unknown) => {
    calls.push({ fn: "saveFilePathDialog", args: [filename, filters] })
    return { path: saveDialogResult }
  },
  copyFile: async (source: string, target: string) => {
    calls.push({ fn: "copyFile", args: [source, target] })
  },
  writeClipboardText: async (text: string) => {
    calls.push({ fn: "writeClipboardText", args: [text] })
  },
}))

const toasts: Array<{ kind: string; text: string }> = []
mock.module("sonner", () => ({
  toast: {
    success: (text: string) => { toasts.push({ kind: "success", text }) },
    error: (text: string) => { toasts.push({ kind: "error", text }) },
  },
}))

const { resolveAbsolutePath, resolveFileLinkActions, buildSaveAsFilter } = await import("./file-link-actions")

const sidecarCalls = () => calls.filter((c) => c.fn === "sidecarCall")

function threadCtx() {
  return { source: "thread" as const, relPath: "plans/research.md", threadId: "t1", workspaceSlug: "ws-1" }
}

describe("resolveAbsolutePath", () => {
  test("local source returns relPath as-is", async () => {
    calls.length = 0
    const abs = await resolveAbsolutePath({ source: "local", relPath: "/abs/path/file.md" })
    expect(abs).toBe("/abs/path/file.md")
    expect(sidecarCalls()).toHaveLength(0)
  })

  test("thread source resolves via GET_THREAD_PATH and joins relPath", async () => {
    calls.length = 0
    const abs = await resolveAbsolutePath(threadCtx())
    expect(abs).toBe("/data/threads/t1/plans/research.md")
    expect(sidecarCalls().at(-1)).toEqual({
      fn: "sidecarCall",
      args: ["agent:get-thread-path", { threadId: "t1", workspaceSlug: "ws-1" }],
    })
  })

  test("workspace source resolves via GET_WORKSPACE_RESOURCES_PATH", async () => {
    calls.length = 0
    const abs = await resolveAbsolutePath({
      source: "workspace",
      relPath: "shared/notes.md",
      workspaceSlug: "ws-1",
    })
    expect(abs).toBe("/data/ws/resources/shared/notes.md")
    expect(sidecarCalls().at(-1)).toEqual({
      fn: "sidecarCall",
      args: ["agent:get-workspace-resources-path", { workspaceSlug: "ws-1" }],
    })
  })

  test("thread source returns absolute POSIX relPath as-is (file tree entry.path)", async () => {
    calls.length = 0
    const absPath = "/data/threads/t1/files/image-gen/x.png"
    const abs = await resolveAbsolutePath({ source: "thread", relPath: absPath, threadId: "t1", workspaceSlug: "ws-1" })
    expect(abs).toBe(absPath)
    expect(sidecarCalls()).toHaveLength(0)
  })

  test("thread source returns absolute Windows-drive relPath as-is", async () => {
    calls.length = 0
    const absPath = "C:\\data\\threads\\t1\\files\\image-gen\\x.png"
    const abs = await resolveAbsolutePath({ source: "thread", relPath: absPath, threadId: "t1", workspaceSlug: "ws-1" })
    expect(abs).toBe(absPath)
    expect(sidecarCalls()).toHaveLength(0)
  })

  test("workspace source returns absolute relPath as-is", async () => {
    calls.length = 0
    const absPath = "/data/ws/resources/shared/notes.md"
    const abs = await resolveAbsolutePath({ source: "workspace", relPath: absPath, workspaceSlug: "ws-1" })
    expect(abs).toBe(absPath)
    expect(sidecarCalls()).toHaveLength(0)
  })

  test("thread without threadId throws", async () => {
    await expect(
      resolveAbsolutePath({ source: "thread", relPath: "a.md", workspaceSlug: "ws-1" }),
    ).rejects.toThrow("threadId")
  })
})

describe("resolveFileLinkActions", () => {
  test("openInSystem resolves abs path then calls native", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).openInSystem()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "openInSystem"])
    expect(calls[1]!.args).toEqual(["/data/threads/t1/plans/research.md"])
  })

  test("revealInFolder calls revealPathInSystem with abs path", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).revealInFolder()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "revealPathInSystem"])
  })

  test("copyRelativePath writes relPath via Rust clipboard", async () => {
    calls.length = 0
    toasts.length = 0
    await resolveFileLinkActions(threadCtx()).copyRelativePath()
    expect(
      calls.some((c) => c.fn === "writeClipboardText" && c.args[0] === "plans/research.md"),
    ).toBe(true)
    expect(toasts[0]).toMatchObject({ kind: "success" })
  })

  test("copyAbsolutePath writes abs path via Rust clipboard", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).copyAbsolutePath()
    expect(
      calls.some(
        (c) => c.fn === "writeClipboardText" && c.args[0] === "/data/threads/t1/plans/research.md",
      ),
    ).toBe(true)
  })

  test("saveAs happy path: resolve -> dialog -> copyFile -> success toast", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/copied.md"
    await resolveFileLinkActions(threadCtx()).saveAs()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "saveFilePathDialog", "copyFile"])
    expect(calls[2]!.args).toEqual(["/data/threads/t1/plans/research.md", "/target/copied.md"])
    expect(toasts[0]).toMatchObject({ kind: "success" })
  })

  test("saveAs silent when user cancels dialog", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = null
    await resolveFileLinkActions(threadCtx()).saveAs()
    expect(calls.some((c) => c.fn === "copyFile")).toBe(false)
    expect(toasts).toHaveLength(0)
  })

  test("saveAs derives md filter from source extension", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/copied.md"
    await resolveFileLinkActions(threadCtx()).saveAs()
    const dialogCall = calls.find((c) => c.fn === "saveFilePathDialog")!
    expect(dialogCall.args[0]).toBe("research.md")
    expect(dialogCall.args[1]).toEqual([{ name: "md", extensions: ["md"] }])
  })

  test("saveAs passes empty filter (no restriction) for extensionless file", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/NOTES"
    await resolveFileLinkActions({ source: "thread", relPath: "NOTES", threadId: "t1", workspaceSlug: "ws-1" }).saveAs()
    const dialogCall = calls.find((c) => c.fn === "saveFilePathDialog")!
    expect(dialogCall.args[1]).toEqual([])
  })

  test("openInSystem toasts error when resolve fails (missing threadId)", async () => {
    calls.length = 0
    toasts.length = 0
    await resolveFileLinkActions({ source: "thread", relPath: "a.md" }).openInSystem()
    expect(toasts[0]).toMatchObject({ kind: "error" })
    expect(calls.some((c) => c.fn === "openInSystem")).toBe(false)
  })
})

describe("buildSaveAsFilter", () => {
  test("normal extension derives filter (basenames absolute path)", () => {
    expect(buildSaveAsFilter("/data/threads/t1/plans/research.md")).toEqual([
      { name: "md", extensions: ["md"] },
    ])
  })

  test("no extension returns empty filter", () => {
    expect(buildSaveAsFilter("/data/threads/t1/NOTES")).toEqual([])
  })

  test("leading-dot dotfile returns empty filter", () => {
    expect(buildSaveAsFilter("/data/threads/t1/.gitignore")).toEqual([])
  })

  test("trailing dot returns empty filter", () => {
    expect(buildSaveAsFilter("/data/threads/t1/file.")).toEqual([])
  })

  test("extension is lowercased", () => {
    expect(buildSaveAsFilter("/data/threads/t1/REPORT.PDF")).toEqual([
      { name: "pdf", extensions: ["pdf"] },
    ])
  })
})
