import type {
  GeneralSettings,
  UpdateGeneralSettingsInput,
  ThemeMode,
} from '@lume/shared'
import { GENERAL_SETTINGS_DEFAULTS as SHARED_GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'

export type SettingsTab = 'general' | 'channels' | 'agent' | 'mcp' | 'skills' | 'about'

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

  return {
    themeMode: updates.themeMode ?? base.themeMode,
    windowBehavior: {
      minimizeToTray: updates.windowBehavior?.minimizeToTray ?? base.windowBehavior.minimizeToTray,
      closeToTray: updates.windowBehavior?.closeToTray ?? base.windowBehavior.closeToTray,
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
