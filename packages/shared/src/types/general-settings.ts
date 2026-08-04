import type { LumeLoggingSettings } from "./logging"
import { LUME_LOGGING_DEFAULTS } from "./logging"

export type ThemeMode = "system" | "light" | "dark"

export type BuiltInThemePalette = "mint" | "iris" | "clay" | "ocean" | "sakura" | "ember" | "mono" | "lavender" | "olive"

export type CustomThemePaletteId = `custom:${string}`

export type ThemePalette = BuiltInThemePalette | CustomThemePaletteId

export interface CustomThemePaletteColors {
  background: string
  surface: string
  text: string
  muted: string
  accent: string
}

export interface CustomThemePalette {
  id: CustomThemePaletteId
  name: string
  light: CustomThemePaletteColors
  dark: CustomThemePaletteColors
}

export type AgentMessageDisplayMode = "minimal" | "verbose"

export type AgentMessageListDisplayMode = "conversation" | "left_aligned"

export type AgentMessageAvatarMode = "visible" | "hidden"

export interface GeneralSettingsWindowBehavior {
  minimizeToTray: boolean
  closeToTray: boolean
  showTray: boolean
}

export interface GeneralSettingsAgentIsland {
  enabled: boolean
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
  customThemePalettes: CustomThemePalette[]
  windowBehavior: GeneralSettingsWindowBehavior
  updateSettings: GeneralSettingsUpdateSettings
  agentMessageDisplayMode: AgentMessageDisplayMode
  agentMessageListDisplayMode: AgentMessageListDisplayMode
  agentMessageAvatarMode: AgentMessageAvatarMode
  agentIsland: GeneralSettingsAgentIsland
  logging: LumeLoggingSettings
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  themePalette?: ThemePalette
  customThemePalettes?: CustomThemePalette[]
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
  updateSettings?: Partial<GeneralSettingsUpdateSettings>
  agentMessageDisplayMode?: AgentMessageDisplayMode
  agentMessageListDisplayMode?: AgentMessageListDisplayMode
  agentMessageAvatarMode?: AgentMessageAvatarMode
  agentIsland?: Partial<GeneralSettingsAgentIsland>
  logging?: Partial<LumeLoggingSettings>
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
  /** Present when a query spans multiple log segments. */
  fileName?: string
  level: LogViewerLevel
  text: string
  rawJson?: string
  event?: import("./logging").LumeLogEventV2
}

export interface ReadLogFileInput {
  /** Use "*" to query all retained log segments. */
  fileName: string
  levels?: LogViewerLevel[]
  query?: string
  maxLines?: number
  traceId?: string
  source?: import("./logging").LumeLogSource
  kind?: import("./logging").LumeLogKind
  context?: string
  event?: string
  status?: import("./logging").LumeLogStatus
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
  customThemePalettes: [],
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false,
    showTray: true
  },
  agentIsland: {
    enabled: true
  },
  updateSettings: {
    autoCheckUpdates: true,
    notifyAfterDownload: true,
    installOnlyWhenIdle: true,
    lastUpdateCheckAt: null
  },
  agentMessageDisplayMode: "minimal",
  agentMessageListDisplayMode: "conversation",
  agentMessageAvatarMode: "visible",
  logging: { ...LUME_LOGGING_DEFAULTS }
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
