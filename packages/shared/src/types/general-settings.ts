export type ThemeMode = "system" | "light" | "dark"

export type ThemePalette = "mint" | "iris" | "clay" | "ocean"

export type AgentMessageDisplayMode = "minimal" | "verbose"

export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
  showTray: boolean
}

export interface GeneralSettingsUpdateSettings {
  autoCheckUpdates: boolean
  notifyAfterDownload: boolean
  installOnlyWhenIdle: boolean
  lastUpdateCheckAt: string | null
}

export interface GeneralSettings {
  themeMode: ThemeMode
  themePalette: ThemePalette
  windowBehavior: GeneralSettingsWindowBehavior
  updateSettings: GeneralSettingsUpdateSettings
  agentMessageDisplayMode: AgentMessageDisplayMode
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  themePalette?: ThemePalette
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
  updateSettings?: Partial<GeneralSettingsUpdateSettings>
  agentMessageDisplayMode?: AgentMessageDisplayMode
}

export type LogViewerLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type ElectronLogSource = "main" | "sidecar" | "renderer"

export interface ElectronLogEvent {
  ts: string
  timestamp: string
  level: LogViewerLevel
  source: ElectronLogSource
  context: string
  message: string
  data?: unknown
  sessionId?: string
}

export interface LogFileSummary {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export interface LogFileListResult {
  /** Renderer-facing responses intentionally hide the real local logs path. */
  directory: string
  files: LogFileSummary[]
  totalFiles: number
  totalBytes: number
}

export interface LogLineEntry {
  lineNumber: number
  level: LogViewerLevel
  text: string
}

export interface ReadLogFileInput {
  fileName: string
  levels?: LogViewerLevel[]
  query?: string
  maxLines?: number
}

export interface ReadLogFileResult {
  fileName: string
  totalLines: number
  matchedLines: number
  lines: LogLineEntry[]
}

export interface ExportLogsResult {
  /** Renderer-facing responses intentionally hide the real exported file path. */
  path: string
  fileName: string
  sizeBytes: number
}

export type WebSearchProvider = "guanlan" | "exa" | "tavily" | "brave" | "duckduckgo" | "pipellm" | "zhipu" | "bing"

export interface TestSearchBackendInput {
  provider: WebSearchProvider
  apiKey?: string
}

export interface TestSearchBackendResult {
  ok: boolean
  provider: WebSearchProvider
  error?: string
}

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  themeMode: "system",
  themePalette: "mint",
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false,
    showTray: true
  },
  updateSettings: {
    autoCheckUpdates: true,
    notifyAfterDownload: true,
    installOnlyWhenIdle: true,
    lastUpdateCheckAt: null
  },
  agentMessageDisplayMode: "minimal"
}

export const GENERAL_SETTINGS_IPC_CHANNELS = {
  GET: "general-settings:get",
  UPDATE: "general-settings:update",
  OPEN_LOGS_DIR: "general-settings:open-logs-dir",
  CLEAR_CACHE: "general-settings:clear-cache",
  LIST_LOG_FILES: "general-settings:list-log-files",
  READ_LOG_FILE: "general-settings:read-log-file",
  EXPORT_LOGS: "general-settings:export-logs",
  TEST_SEARCH_BACKEND: "general-settings:test-search-backend"
} as const
