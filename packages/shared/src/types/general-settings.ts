export type ThemeMode = "system" | "light" | "dark"

export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
}

export interface GeneralSettings {
  themeMode: ThemeMode
  windowBehavior: GeneralSettingsWindowBehavior
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
}

export type GeneralSettingsCacheKey = "frontendTemp" | "previewRender" | "logs"

export interface ClearCacheInput {
  frontendTemp?: boolean
  previewRender?: boolean
  logs?: boolean
}

export interface ClearCacheResult {
  cleared: GeneralSettingsCacheKey[]
  skipped: GeneralSettingsCacheKey[]
}

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  themeMode: "system",
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false
  }
}

export const GENERAL_SETTINGS_IPC_CHANNELS = {
  GET: "general-settings:get",
  UPDATE: "general-settings:update",
  OPEN_LOGS_DIR: "general-settings:open-logs-dir",
  CLEAR_CACHE: "general-settings:clear-cache"
} as const
