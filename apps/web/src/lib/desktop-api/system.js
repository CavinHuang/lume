import { invoke } from '@tauri-apps/api/core';
export const sidecarCall = (method, params) => invoke('sidecar_call', { method, params: params ?? null });
