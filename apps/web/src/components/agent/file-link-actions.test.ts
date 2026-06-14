import { describe, expect, mock, test } from "bun:test"

mock.module("@lume/shared", () => ({
  AGENT_IPC_CHANNELS: {
    GET_THREAD_PATH: "agent:get-thread-path",
    GET_WORKSPACE_RESOURCES_PATH: "agent:get-workspace-resources-path",
  },
}))

const sidecarCalls: Array<{ method: string; params: unknown }> = []
mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async (method: string, params: unknown) => {
    sidecarCalls.push({ method, params })
    if (method === "agent:get-thread-path") return "/data/threads/t1"
    if (method === "agent:get-workspace-resources-path") return "/data/ws/resources"
    throw new Error(`unexpected method ${method}`)
  },
}))

mock.module("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }))

const { resolveAbsolutePath } = await import("./file-link-actions")

describe("resolveAbsolutePath", () => {
  test("local source returns relPath as-is", async () => {
    const abs = await resolveAbsolutePath({ source: "local", relPath: "/abs/path/file.md" })
    expect(abs).toBe("/abs/path/file.md")
    expect(sidecarCalls).toHaveLength(0)
  })

  test("thread source resolves via GET_THREAD_PATH and joins relPath", async () => {
    const abs = await resolveAbsolutePath({
      source: "thread",
      relPath: "plans/research.md",
      threadId: "t1",
      workspaceSlug: "ws-1",
    })
    expect(abs).toBe("/data/threads/t1/plans/research.md")
    expect(sidecarCalls.at(-1)).toEqual({
      method: "agent:get-thread-path",
      params: { threadId: "t1", workspaceSlug: "ws-1" },
    })
  })

  test("workspace source resolves via GET_WORKSPACE_RESOURCES_PATH", async () => {
    const abs = await resolveAbsolutePath({
      source: "workspace",
      relPath: "shared/notes.md",
      workspaceSlug: "ws-1",
    })
    expect(abs).toBe("/data/ws/resources/shared/notes.md")
    expect(sidecarCalls.at(-1)).toEqual({
      method: "agent:get-workspace-resources-path",
      params: { workspaceSlug: "ws-1" },
    })
  })

  test("thread without threadId throws", async () => {
    await expect(
      resolveAbsolutePath({ source: "thread", relPath: "a.md", workspaceSlug: "ws-1" }),
    ).rejects.toThrow("threadId")
  })
})
