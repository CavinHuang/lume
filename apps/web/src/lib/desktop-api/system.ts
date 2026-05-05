import { invoke } from '@tauri-apps/api/core'
import { clearHighlightCache } from '@lume/ui'
import {
  AGENT_IPC_CHANNELS,
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  type AgentProxySettings,
  type AgentProxyStatus,
  type GeneralSettings,
  type GitHubRelease,
  type UpdateGeneralSettingsInput,
} from '@lume/shared'

export const sidecarCall = <T = unknown>(method: string, params?: unknown) =>
  invoke<T>('sidecar_call', { method, params: params ?? null })

const desktopCall = <T = unknown>(command: string, payload?: Record<string, unknown>) =>
  invoke<T>(command, payload)

export interface ClearCacheInput {
  frontendTemp?: boolean
  previewRender?: boolean
  logs?: boolean
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

export const updateGeneralSettings = (input: UpdateGeneralSettingsInput) =>
  sidecarCall<GeneralSettings>(GENERAL_SETTINGS_IPC_CHANNELS.UPDATE, input)
    .then(async (settings) => {
      if (input.windowBehavior) {
        await desktopCall('desktop_sync_window_behavior', {
          windowBehavior: settings.windowBehavior,
        })
      }
      return settings
    })

export const getProxySettings = () =>
  sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS, {})

export const saveProxySettings = (input: AgentProxySettings) =>
  sidecarCall<AgentProxyStatus>(AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS, input)

export const getLatestGitHubRelease = () =>
  sidecarCall<GitHubRelease | null>(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE, {})

export const openLogsDir = () =>
  sidecarCall<{ ok: boolean }>(GENERAL_SETTINGS_IPC_CHANNELS.OPEN_LOGS_DIR, {})

export const clearCache = async (input: ClearCacheInput): Promise<ClearCacheResult> => {
  const browserResult = await clearBrowserCaches(input)
  const sidecarResult = await sidecarCall<ClearCacheResult>(
    GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE,
    { logs: input.logs }
  )

  return {
    cleared: Array.from(new Set([...browserResult.cleared, ...sidecarResult.cleared])),
    skipped: Array.from(new Set([...browserResult.skipped, ...sidecarResult.skipped])),
  }
}
