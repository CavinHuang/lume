import { AGENT_IPC_CHANNELS } from "@lume/shared"
import { toast } from "sonner"
import { openInSystem, revealPathInSystem, saveFilePathDialog, copyFile, sidecarCall } from "@/lib/desktop-api"
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

function basename(p: string): string {
  return p.split("/").pop() ?? p
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface FileLinkActions {
  openInSystem: () => Promise<void>
  revealInFolder: () => Promise<void>
  copyRelativePath: () => Promise<void>
  copyAbsolutePath: () => Promise<void>
  saveAs: () => Promise<void>
}

export function resolveFileLinkActions(ctx: FileLinkContext): FileLinkActions {
  return {
    async openInSystem() {
      try {
        await openInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法打开：${errMsg(e)}`)
      }
    },
    async revealInFolder() {
      try {
        await revealPathInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法定位：${errMsg(e)}`)
      }
    },
    async copyRelativePath() {
      try {
        await navigator.clipboard.writeText(ctx.relPath)
        toast.success("已复制相对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async copyAbsolutePath() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        await navigator.clipboard.writeText(abs)
        toast.success("已复制绝对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async saveAs() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        const { path: target } = await saveFilePathDialog(basename(abs))
        if (!target) return // 用户取消，静默
        await copyFile(abs, target)
        toast.success(`已保存到 ${target}`)
      } catch (e) {
        toast.error(`保存失败：${errMsg(e)}`)
      }
    },
  }
}
