export type ThemeMode = "system" | "light" | "dark"

export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
}

export interface GeneralSettingsUserProfile {
  displayName: string
}

export interface GeneralSettings {
  themeMode: ThemeMode
  userProfile: GeneralSettingsUserProfile
  windowBehavior: GeneralSettingsWindowBehavior
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  userProfile?: Partial<GeneralSettingsUserProfile>
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
}

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  themeMode: "system",
  userProfile: {
    displayName: ""
  },
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
