import { AGENT_IPC_CHANNELS } from "@lume/shared"
import { toast } from "sonner"
import { openInSystem, revealPathInSystem, saveFilePathDialog, copyFile, writeClipboardText, sidecarCall, openGuardedFileRefInSystem, revealGuardedFileRefInSystem, saveGuardedFileRefAs, type SaveFilePathFilter } from "@/lib/desktop-api"
import type { FileLinkContext } from "./file-link-types"

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, "")}/${rel}`
}

/** 识别绝对路径：Windows 盘符（C:\）或 POSIX 根（/、\）。 */
function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p)
}

export async function resolveAbsolutePath(ctx: FileLinkContext): Promise<string> {
  if (ctx.guardedRef) {
    const result = await sidecarCall<{ path: string }>(AGENT_IPC_CHANNELS.RESOLVE_GUARDED_FILE_REF, { guardedRef: ctx.guardedRef })
    return result.path
  }
  if (ctx.source === "local") return ctx.relPath
  // 文件树传入的 relPath 可能已是绝对路径（FileEntry.path 为完整路径），直接返回避免重复拼接根目录
  if (isAbsolutePath(ctx.relPath)) return ctx.relPath

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

/** 按源文件扩展名构造保存对话框 filter；无扩展名返回空数组（Rust 端 Some([]) 不触发 SVG 默认过滤）。 */
export function buildSaveAsFilter(absPath: string): SaveFilePathFilter[] {
  const base = basename(absPath)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return [] // 无点（"NOTES"）或以点开头（".gitignore"）→ 不限制
  const ext = base.slice(dot + 1).toLowerCase()
  if (!ext) return []
  return [{ name: ext, extensions: [ext] }]
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
  copyProtocolReference: () => Promise<void>
}

export function resolveFileLinkActions(ctx: FileLinkContext): FileLinkActions {
  return {
    async openInSystem() {
      try {
        if (ctx.guardedRef) return await openGuardedFileRefInSystem(ctx.guardedRef)
        await openInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法打开：${errMsg(e)}`)
      }
    },
    async revealInFolder() {
      try {
        if (ctx.guardedRef) return await revealGuardedFileRefInSystem(ctx.guardedRef)
        await revealPathInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法定位：${errMsg(e)}`)
      }
    },
    async copyRelativePath() {
      try {
        await writeClipboardText(ctx.relPath)
        toast.success("已复制相对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async copyAbsolutePath() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        await writeClipboardText(abs)
        toast.success("已复制绝对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async saveAs() {
      try {
        if (ctx.guardedRef) {
          const filters = buildSaveAsFilter(ctx.relPath)
          const result = await saveGuardedFileRefAs(ctx.guardedRef, basename(ctx.relPath), filters)
          if (result.path) toast.success(`已保存到 ${result.path}`)
          return
        }
        const abs = await resolveAbsolutePath(ctx)
        const { path: target } = await saveFilePathDialog(basename(abs), buildSaveAsFilter(abs))
        if (!target) return // 用户取消，静默
        await copyFile(abs, target)
        toast.success(`已保存到 ${target}`)
      } catch (e) {
        toast.error(`保存失败：${errMsg(e)}`)
      }
    },
    async copyProtocolReference() {
      try {
        await writeClipboardText(ctx.protocolReference ?? ctx.relPath)
        toast.success("已复制协议引用")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
  }
}
