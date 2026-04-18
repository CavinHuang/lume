import { invoke } from '@tauri-apps/api/core'

export const sidecarCall = <T = unknown>(method: string, params?: unknown) =>
  invoke<T>('sidecar_call', { method, params: params ?? null })

export type ThemeMode = 'system' | 'light' | 'dark'

export interface GeneralSettings {
  themeMode: ThemeMode
  windowBehavior: {
    minimizeToTray: boolean
    closeToTray: boolean
  }
}

export interface GeneralSettingsUpdate {
  themeMode?: ThemeMode
  windowBehavior?: Partial<GeneralSettings['windowBehavior']>
}

export interface ClearCacheInput {
  frontendTemp?: boolean
  previewRender?: boolean
  logs?: boolean
}

export interface ClearCacheResult {
  cleared: Array<keyof ClearCacheInput>
  skipped: Array<keyof ClearCacheInput>
}

export const getGeneralSettings = () =>
  sidecarCall<GeneralSettings>('general-settings:get', {})

export const updateGeneralSettings = (input: GeneralSettingsUpdate) =>
  sidecarCall<GeneralSettings>('general-settings:update', input)

export const openLogsDir = () =>
  sidecarCall<void>('general-settings:open-logs-dir', {})

export const clearCache = (input: ClearCacheInput) =>
  sidecarCall<ClearCacheResult>('general-settings:clear-cache', input)
