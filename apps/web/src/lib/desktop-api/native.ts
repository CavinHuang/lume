import { convertFileSrc, invoke, isDesktopRuntime } from '@/lib/desktop-runtime/core'
import { getDesktopBridge } from '@/lib/desktop-runtime/bridge'
import { check, type DownloadEvent, type Update } from '@/lib/desktop-runtime/updater'
import type { FileRef, GuardedFileRef } from '@lume/shared'

export interface DesktopUpdateInfo {
  currentVersion: string
  version: string
  date?: string
  body?: string
}

export type DesktopUpdateDownloadEvent = DownloadEvent
export interface SaveFilePathFilter {
  name: string
  extensions: string[]
}

export interface DesktopSelectedFile {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath: string
  stagedAttachmentId?: string
  previewUrl?: string
}

export const healthcheck = () => invoke('healthcheck')
export const sidecarHealthcheck = () => invoke('sidecar_healthcheck')
export const openFileDialog = () =>
  invoke<{ files: DesktopSelectedFile[] }>('open_file_dialog')
export const statFilePaths = (paths: string[]) =>
  invoke<{ files: DesktopSelectedFile[] }>('stat_file_paths', { paths })

const ATTACHMENT_STAGE_CHUNK_BYTES = 256 * 1024

export async function stageAttachmentFile(input: {
  id: string
  file: File
  filename: string
  mediaType: string
}): Promise<{ stagedAttachmentId: string; previewUrl?: string }> {
  const begun = await invoke<{ stagedAttachmentId: string }>('attachment_stage_begin', {
    attachmentId: input.id,
    filename: input.filename,
    mediaType: input.mediaType,
    size: input.file.size,
  })
  try {
    for (let offset = 0; offset < input.file.size; offset += ATTACHMENT_STAGE_CHUNK_BYTES) {
      const chunk = new Uint8Array(await input.file.slice(offset, offset + ATTACHMENT_STAGE_CHUNK_BYTES).arrayBuffer())
      await invoke('attachment_stage_append', {
        stagedAttachmentId: begun.stagedAttachmentId,
        offset,
        chunk,
      })
    }
    return await invoke('attachment_stage_finish', { stagedAttachmentId: begun.stagedAttachmentId })
  } catch (error) {
    await invoke('attachment_stage_abort', { stagedAttachmentId: begun.stagedAttachmentId }).catch(() => undefined)
    throw error
  }
}

export const abortStagedAttachment = (stagedAttachmentId: string) =>
  invoke<void>('attachment_stage_abort', { stagedAttachmentId })
export const openFolderDialog = () =>
  invoke<{ path: string | null }>('open_folder_dialog')
export const getQuickInputContext = () =>
  invoke<unknown>('quick_input_get_context')
export const openExternal = (url: string) => invoke('open_external', { url })
export const readTextFile = (path: string) =>
  invoke<{ content: string; truncated: boolean }>('read_text_file', { path })
export const saveTextFileDialog = (filename: string, content: string) =>
  invoke<{ path: string }>('save_text_file_dialog', { filename, content })
export const saveFilePathDialog = (filename: string, filters?: SaveFilePathFilter[]) =>
  invoke<{ path: string | null }>('save_file_path_dialog', { filename, filters })
export const writeBinaryFile = (path: string, base64Content: string) =>
  invoke<{ path: string }>('write_binary_file', { path, base64Content })
export const copyFile = (source: string, target: string) =>
  invoke<void>('copy_file', { source, target })
export const openInSystem = (path: string) =>
  invoke<void>('open_in_system', { path })
export const revealPathInSystem = (path: string) =>
  invoke<void>('reveal_path_in_system', { path })
export const openFileRefInSystem = (ref: FileRef) =>
  invoke<void>('open_file_ref', { ref })
export const revealFileRefInSystem = (ref: FileRef) =>
  invoke<void>('reveal_file_ref', { ref })
export const openGuardedFileRefInSystem = (guardedRef: GuardedFileRef) =>
  invoke<void>('open_guarded_file_ref', { guardedRef })
export const revealGuardedFileRefInSystem = (guardedRef: GuardedFileRef) =>
  invoke<void>('reveal_guarded_file_ref', { guardedRef })
export const createFilePreviewScope = (input: { ref: FileRef; kind: 'html-directory' | 'media-file'; generation?: number }) =>
  invoke<{ token: string; url: string; expiresAt: number }>('create_file_preview_scope', input)
export const createGuardedFilePreviewScope = (input: { guardedRef: GuardedFileRef; kind: 'html-directory' | 'media-file'; generation?: number }) =>
  invoke<{ token: string; url: string; expiresAt: number }>('create_guarded_file_preview_scope', input)
export const saveGuardedFileRefAs = (guardedRef: GuardedFileRef, filename: string, filters?: SaveFilePathFilter[]) =>
  invoke<{ path: string | null }>('save_guarded_file_ref_as', { guardedRef, filename, filters })
export const revokeFilePreviewScope = (token: string) =>
  invoke<void>('revoke_file_preview_scope', { token })
export { isDesktopRuntime }
export const writeClipboardText = (text: string) =>
  invoke<void>('write_clipboard_text', { text })
export const readClipboardText = () =>
  invoke<string>('read_clipboard_text')
export type ClipboardImageSource = { path: string } | { ref: FileRef } | { guardedRef: GuardedFileRef } | { dataUrl: string }
export const writeClipboardImage = (source: ClipboardImageSource) =>
  invoke<void>('write_clipboard_image', source)
export const localFilePreviewUrl = (path: string) => convertFileSrc(path)

let pendingDesktopUpdate: Update | null = null

function toDesktopUpdateInfo(update: Update): DesktopUpdateInfo {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    ...(update.date ? { date: update.date } : {}),
    ...(update.body ? { body: update.body } : {}),
  }
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo | null> {
  pendingDesktopUpdate = await check()
  return pendingDesktopUpdate ? toDesktopUpdateInfo(pendingDesktopUpdate) : null
}

export async function downloadDesktopUpdate(
  onEvent?: (event: DesktopUpdateDownloadEvent) => void
): Promise<void> {
  if (!pendingDesktopUpdate) {
    pendingDesktopUpdate = await check()
  }
  if (!pendingDesktopUpdate) {
    throw new Error('当前没有可下载的更新')
  }
  await pendingDesktopUpdate.download(onEvent)
}

export async function downloadDesktopUpdateAsset(
  url: string,
  onEvent?: (event: DesktopUpdateDownloadEvent) => void,
): Promise<void> {
  const bridge = getDesktopBridge()
  if (!bridge?.downloadUpdateAsset) {
    throw new Error('当前桌面环境不支持应用内下载更新')
  }
  await bridge.downloadUpdateAsset(url, onEvent)
}

export async function installDesktopUpdateAndRelaunch(): Promise<void> {
  if (!pendingDesktopUpdate) {
    throw new Error('更新尚未下载')
  }
  await pendingDesktopUpdate.install()
}

export async function installDesktopUpdateAssetAndRelaunch(): Promise<void> {
  const bridge = getDesktopBridge()
  if (!bridge?.installUpdate) {
    throw new Error('当前桌面环境不支持安装更新')
  }
  await bridge.installUpdate()
}
