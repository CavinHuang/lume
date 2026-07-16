import { convertFileSrc, invoke, isDesktopRuntime } from '@/lib/desktop-runtime/core'
import { check, type DownloadEvent, type Update } from '@/lib/desktop-runtime/updater'
import type { FileRef } from '@lume/shared'

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
  filename: string
  mediaType: string
  size: number
  sourcePath: string
  data?: string
}

export const healthcheck = () => invoke('healthcheck')
export const sidecarHealthcheck = () => invoke('sidecar_healthcheck')
export const openFileDialog = () =>
  invoke<{ files: DesktopSelectedFile[] }>('open_file_dialog')
export const statFilePaths = (paths: string[]) =>
  invoke<{ files: DesktopSelectedFile[] }>('stat_file_paths', { paths })
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
export const createFilePreviewScope = (input: { ref: FileRef; kind: 'html-directory' | 'media-file'; generation?: number }) =>
  invoke<{ token: string; url: string; expiresAt: number }>('create_file_preview_scope', input)
export const revokeFilePreviewScope = (token: string) =>
  invoke<void>('revoke_file_preview_scope', { token })
export { isDesktopRuntime }
export const writeClipboardText = (text: string) =>
  invoke<void>('write_clipboard_text', { text })
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

export async function installDesktopUpdateAndRelaunch(): Promise<void> {
  if (!pendingDesktopUpdate) {
    throw new Error('更新尚未下载')
  }
  await pendingDesktopUpdate.install()
}
