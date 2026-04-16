import { invoke } from '@tauri-apps/api/core';
export const healthcheck = () => invoke('healthcheck');
export const sidecarHealthcheck = () => invoke('sidecar_healthcheck');
export const openFileDialog = () => invoke('open_file_dialog');
export const openFolderDialog = () => invoke('open_folder_dialog');
export const openExternal = (url) => invoke('open_external', { url });
