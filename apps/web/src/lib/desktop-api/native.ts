import { invoke } from '@tauri-apps/api/core'

export const healthcheck = () => invoke('healthcheck')
export const sidecarHealthcheck = () => invoke('sidecar_healthcheck')
export const openFileDialog = () =>
  invoke<{ files: Array<{ filename: string; mediaType: string; size: number; sourcePath: string }> }>('open_file_dialog')
export const openFolderDialog = () =>
  invoke<{ path: string | null }>('open_folder_dialog')
export const openExternal = (url: string) => invoke('open_external', { url })
