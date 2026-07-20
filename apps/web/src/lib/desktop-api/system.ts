import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import { clearHighlightCache } from '@lume/ui'
import {
  AGENT_IPC_CHANNELS,
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  type AgentProxySettings,
  type AgentProxyStatus,
  type ExportLogsResult,
  type GeneralSettings,
  type GitHubRelease,
  type LogFileListResult,
  type ReadLogFileInput,
  type ReadLogFileResult,
  type TestSearchBackendInput,
  type TestSearchBackendResult,
  type UpdateGeneralSettingsInput,
  type LumeLogEventV2,
  type LumeDiagnosticStatus,
} from '@lume/shared'

export const sidecarCall = <T = unknown>(method: string, params?: unknown) =>
  invoke<T>('sidecar_call', { method, params: params ?? null })

const desktopCall = <T = unknown>(command: string, payload?: Record<string, unknown>) =>
  invoke<T>(command, payload)

export interface ClearCacheInput {
  frontendTemp?: boolean
  previewRender?: boolean
  logs?: boolean
  vectorIndex?: boolean
  pluginsCache?: boolean
}

export type ClearCacheKey = keyof ClearCacheInput

export interface ClearCacheResult {
  cleared: ClearCacheKey[]
  skipped: ClearCacheKey[]
}

async function clearBrowserCaches(input: ClearCacheInput): Promise<ClearCacheResult> {
  const result: ClearCacheResult = {
    cleared: [],
    skipped: [],
  }

  if (input.frontendTemp) {
    let touched = false
    if (window.sessionStorage.length > 0) {
      touched = true
      window.sessionStorage.clear()
    }

    if (touched) {
      result.cleared.push('frontendTemp')
    } else {
      result.skipped.push('frontendTemp')
    }
  }

  if (input.previewRender) {
    const touched = clearHighlightCache()
    if (touched) {
      result.cleared.push('previewRender')
    } else {
      result.skipped.push('previewRender')
    }
  }

  return result
}

export const getGeneralSettings = () =>
  sidecarCall<GeneralSettings>(GENERAL_SETTINGS_IPC_CHANNELS.GET, {})

let windowBehaviorRevision = 0

export const updateGeneralSettings = (input: UpdateGeneralSettingsInput) =>
  sidecarCall<GeneralSettings>(GENERAL_SETTINGS_IPC_CHANNELS.UPDATE, input)
    .then(async (settings) => {
      if (input.windowBehavior) {
        const { generation } = await desktopCall<{ generation: number }>('desktop_get_main_window_generation')
        await desktopCall('desktop_sync_window_behavior', {
          windowBehavior: settings.windowBehavior,
          generation,
          revision: ++windowBehaviorRevision,
        })
      }
      return settings
    })

export const getMainWindowGeneration = () =>
  desktopCall<{ generation: number }>('desktop_get_main_window_generation')

export const markDesktopRendererReady = (generation: number) =>
  desktopCall('desktop_renderer_ready', { generation })

export const syncDesktopTrayState = (generation: number, threads: Array<{ id: string; title: string; updatedAt: number }>, currentThreadId: string | null) =>
  desktopCall('desktop_sync_tray_state', { generation, threads, currentThreadId })

export const reportDesktopTrayNavigationConfirmationFailed = (generation: number, threadId: string, reason: 'timeout' | 'query_failed') =>
  desktopCall('desktop_report_tray_navigation_confirmation_failed', { generation, threadId, reason })

export const getProxySettings = () =>
  sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS, {})

export const saveProxySettings = (input: AgentProxySettings) =>
  sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS, input)

export const getLatestGitHubRelease = () =>
  sidecarCall<GitHubRelease | null>(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE, {})

export const openLogsDir = () =>
  desktopCall<{ ok: boolean }>('desktop_open_logs_dir')

export const listLogFiles = () =>
  desktopCall<LogFileListResult>('desktop_list_log_files')

export const readLogFile = (input: ReadLogFileInput) =>
  desktopCall<ReadLogFileResult>('desktop_read_log_file', {
    fileName: input.fileName,
    levels: input.levels,
    keyword: input.query,
    maxLines: input.maxLines,
    traceId: input.traceId,
    source: input.source,
    kind: input.kind,
    context: input.context,
    event: input.event,
    status: input.status,
  })

export const exportLogs = () =>
  desktopCall<ExportLogsResult>('desktop_export_logs')

export const deleteLogs = () =>
  desktopCall<{ deleted: number }>('desktop_delete_logs')

export const subscribeLiveLogs = async (listener: (events: LumeLogEventV2[]) => void) => {
  const unlisten = await listen<{ events: LumeLogEventV2[] }>('logs:live', ({ payload }) => listener(payload.events))
  await desktopCall('desktop_log_live_subscribe')
  return async () => {
    unlisten()
    await desktopCall('desktop_log_live_unsubscribe').catch(() => {})
  }
}

export const getDiagnosticStatus = () =>
  desktopCall<LumeDiagnosticStatus>('desktop_diagnostic_status')

export const startDiagnosticCapture = (input: { threadId?: string; traceId?: string; durationMinutes: number }) =>
  desktopCall<LumeDiagnosticStatus>('desktop_diagnostic_start', input)

export const stopDiagnosticCapture = (deleteContent = false) =>
  desktopCall<LumeDiagnosticStatus>('desktop_diagnostic_stop', { deleteContent })

export const decryptDiagnosticContent = (recordId: string) =>
  desktopCall<{ content: string; captureType: string; threadId: string; traceId: string; messageId: string }>(
    'desktop_diagnostic_decrypt',
    { recordId },
  )

export const deleteDiagnosticContent = () =>
  desktopCall<{ deleted: number }>('desktop_diagnostic_delete')

export const testSearchBackend = (input: TestSearchBackendInput) =>
  sidecarCall<TestSearchBackendResult>(GENERAL_SETTINGS_IPC_CHANNELS.TEST_SEARCH_BACKEND, input)

export const clearCache = async (input: ClearCacheInput): Promise<ClearCacheResult> => {
  const browserResult = await clearBrowserCaches(input)
  const sidecarResult = await sidecarCall<ClearCacheResult>(
    GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE,
    { logs: input.logs, vectorIndex: input.vectorIndex, pluginsCache: input.pluginsCache }
  )

  return {
    cleared: Array.from(new Set([...browserResult.cleared, ...sidecarResult.cleared])),
    skipped: Array.from(new Set([...browserResult.skipped, ...sidecarResult.skipped])),
  }
}
