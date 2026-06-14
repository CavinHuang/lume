import { AGENT_IPC_CHANNELS } from "@lume/shared"
import { sidecarCall } from "@/lib/desktop-api"
import type { FileLinkContext } from "./file-link-types"

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, "")}/${rel}`
}

export async function resolveAbsolutePath(ctx: FileLinkContext): Promise<string> {
  if (ctx.source === "local") return ctx.relPath

  if (ctx.source === "thread") {
    if (!ctx.threadId) throw new Error("thread 文件缺少 threadId")
    const dir = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_THREAD_PATH, {
      threadId: ctx.threadId,
      workspaceSlug: ctx.workspaceSlug,
    })
    return joinPath(dir, ctx.relPath)
  }

  // workspace
  if (!ctx.workspaceSlug) throw new Error("workspace 文件缺少 workspaceSlug")
  const dir = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH, {
    workspaceSlug: ctx.workspaceSlug,
  })
  return joinPath(dir, ctx.relPath)
}
