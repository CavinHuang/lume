import { invoke } from '@tauri-apps/api/core'

export const sidecarCall = <T = unknown>(method: string, params?: unknown) =>
  invoke<T>('sidecar_call', { method, params: params ?? null })
