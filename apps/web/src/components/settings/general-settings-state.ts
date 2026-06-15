import type {
  AgentProxyMode,
  AgentProxySettings,
  GeneralSettings,
  UpdateGeneralSettingsInput,
  ThemeMode,
} from '@lume/shared'
import { GENERAL_SETTINGS_DEFAULTS as SHARED_GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'

export interface ThemeModeOption {
  value: ThemeMode
  label: string
  desc: string
}

export interface ProxyModeOption {
  value: AgentProxyMode
  label: string
  desc: string
}

export const GENERAL_SETTINGS_DEFAULTS = SHARED_GENERAL_SETTINGS_DEFAULTS

export const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  {
    value: 'system',
    label: '跟随系统',
    desc: '根据系统外观自动切换浅色或深色',
  },
  {
    value: 'light',
    label: '浅色',
    desc: '始终使用浅色界面',
  },
  {
    value: 'dark',
    label: '深色',
    desc: '始终使用深色界面',
  },
]

export const PROXY_MODE_OPTIONS: ProxyModeOption[] = [
  {
    value: 'off',
    label: '关闭',
    desc: '不为 sidecar 工具设置代理',
  },
  {
    value: 'system',
    label: '系统',
    desc: '自动读取系统网络代理',
  },
  {
    value: 'custom',
    label: '自定义',
    desc: '手动指定 HTTP/HTTPS 代理',
  },
]

export function mergeGeneralSettings(
  current: GeneralSettings | null | undefined,
  updates: UpdateGeneralSettingsInput
): GeneralSettings {
  const base = current ?? GENERAL_SETTINGS_DEFAULTS

  return {
    themeMode: updates.themeMode ?? base.themeMode,
    windowBehavior: {
      minimizeToTray: updates.windowBehavior?.minimizeToTray ?? base.windowBehavior.minimizeToTray,
      closeToTray: updates.windowBehavior?.closeToTray ?? base.windowBehavior.closeToTray,
    },
    updateSettings: {
      autoCheckUpdates: updates.updateSettings?.autoCheckUpdates ?? base.updateSettings.autoCheckUpdates,
      notifyAfterDownload: updates.updateSettings?.notifyAfterDownload ?? base.updateSettings.notifyAfterDownload,
      installOnlyWhenIdle: updates.updateSettings?.installOnlyWhenIdle ?? base.updateSettings.installOnlyWhenIdle,
      lastUpdateCheckAt:
        updates.updateSettings && 'lastUpdateCheckAt' in updates.updateSettings
          ? updates.updateSettings.lastUpdateCheckAt ?? null
          : base.updateSettings.lastUpdateCheckAt,
    },
  }
}

export function normalizeProxyDraft(settings: AgentProxySettings): AgentProxySettings {
  const mode = settings.mode === 'system' || settings.mode === 'custom' ? settings.mode : 'off'
  const enabled = mode !== 'off' && settings.enabled
  const httpProxy = settings.httpProxy?.trim() || undefined
  const httpsProxy = settings.httpsProxy?.trim() || undefined
  const noProxy = settings.noProxy?.trim() || undefined

  return {
    version: 1,
    enabled,
    mode: enabled ? mode : 'off',
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  }
}
