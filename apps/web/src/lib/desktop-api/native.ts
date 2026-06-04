import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export interface DesktopUpdateInfo {
  currentVersion: string
  version: string
  date?: string
  body?: string
}

export type DesktopUpdateDownloadEvent = DownloadEvent

export const healthcheck = () => invoke('healthcheck')
export const sidecarHealthcheck = () => invoke('sidecar_healthcheck')
export const openFileDialog = () =>
  invoke<{ files: Array<{ filename: string; mediaType: string; size: number; sourcePath: string }> }>('open_file_dialog')
export const statFilePaths = (paths: string[]) =>
  invoke<{ files: Array<{ filename: string; mediaType: string; size: number; sourcePath: string }> }>('stat_file_paths', { paths })
export const openFolderDialog = () =>
  invoke<{ path: string | null }>('open_folder_dialog')
export const openExternal = (url: string) => invoke('open_external', { url })
export const readTextFile = (path: string) =>
  invoke<{ content: string; truncated: boolean }>('read_text_file', { path })
export const saveTextFileDialog = (filename: string, content: string) =>
  invoke<{ path: string }>('save_text_file_dialog', { filename, content })
export const saveFilePathDialog = (filename: string) =>
  invoke<{ path: string | null }>('save_file_path_dialog', { filename })
export const openInSystem = (path: string) =>
  invoke<void>('open_in_system', { path })
export const revealPathInSystem = (path: string) =>
  invoke<void>('reveal_path_in_system', { path })

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
  await relaunch()
}
