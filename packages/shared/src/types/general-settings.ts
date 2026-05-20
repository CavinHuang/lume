export type ThemeMode = "system" | "light" | "dark"

export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
}

export interface GeneralSettingsUpdateSettings {
  autoCheckUpdates: boolean
  notifyAfterDownload: boolean
  installOnlyWhenIdle: boolean
  lastUpdateCheckAt: string | null
}

export interface GeneralSettings {
  themeMode: ThemeMode
  windowBehavior: GeneralSettingsWindowBehavior
  updateSettings: GeneralSettingsUpdateSettings
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
  updateSettings?: Partial<GeneralSettingsUpdateSettings>
}

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  themeMode: "system",
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false
  },
  updateSettings: {
    autoCheckUpdates: true,
    notifyAfterDownload: true,
    installOnlyWhenIdle: true,
    lastUpdateCheckAt: null
  }
}

export const GENERAL_SETTINGS_IPC_CHANNELS = {
  GET: "general-settings:get",
  UPDATE: "general-settings:update",
  OPEN_LOGS_DIR: "general-settings:open-logs-dir",
  CLEAR_CACHE: "general-settings:clear-cache"
} as const
