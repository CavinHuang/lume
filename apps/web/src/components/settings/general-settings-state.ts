import type {
  AgentProxyMode,
  AgentProxySettings,
  GeneralSettings,
  UpdateGeneralSettingsInput,
  ThemeMode,
} from '@lume/shared'
import { GENERAL_SETTINGS_DEFAULTS as SHARED_GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'

export type SettingsTab = 'general' | 'channels' | 'agent' | 'mcp' | 'skills' | 'automation' | 'about'

export type CacheCleanupKey = 'frontendTemp' | 'previewRender' | 'logs'

export type CacheCleanupSelection = Record<CacheCleanupKey, boolean>

export interface SettingsNavItem {
  id: SettingsTab
  label: string
}

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

export interface CacheCleanupOption {
  key: CacheCleanupKey
  label: string
  desc: string
}

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', label: '常规设置' },
  { id: 'channels', label: '供应商配置' },
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'automation', label: '自动化' },
  { id: 'about', label: '关于' },
]

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

export const CACHE_CLEANUP_OPTIONS: CacheCleanupOption[] = [
  {
    key: 'frontendTemp',
    label: '前端临时缓存',
    desc: '移除本地界面临时文件与派生缓存',
  },
  {
    key: 'previewRender',
    label: '预览/渲染缓存',
    desc: '清理预览图、渲染结果等可重建内容',
  },
  {
    key: 'logs',
    label: '日志缓存',
    desc: '删除本地日志缓存文件，不影响配置和会话数据',
  },
]

export function mergeGeneralSettings(
  current: GeneralSettings | null | undefined,
  updates: UpdateGeneralSettingsInput
): GeneralSettings {
  const base = current ?? GENERAL_SETTINGS_DEFAULTS
  const nextDisplayName = updates.userProfile?.displayName

  return {
    themeMode: updates.themeMode ?? base.themeMode,
    userProfile: {
      displayName: typeof nextDisplayName === 'string'
        ? nextDisplayName.trim()
        : base.userProfile.displayName,
    },
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

export function createDefaultCacheCleanupSelection(): CacheCleanupSelection {
  return {
    frontendTemp: true,
    previewRender: true,
    logs: true,
  }
}

export function hasSelectedCacheCleanup(selection: CacheCleanupSelection): boolean {
  return Object.values(selection).some(Boolean)
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
