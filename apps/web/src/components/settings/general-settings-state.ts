import type {
  AgentProxyMode,
  AgentProxySettings,
  GeneralSettings,
  UpdateGeneralSettingsInput,
  ThemeMode,
  ThemePalette,
} from '@lume/shared'
import { GENERAL_SETTINGS_DEFAULTS as SHARED_GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'

export interface ThemeModeOption {
  value: ThemeMode
  label: string
  desc: string
}

export interface ThemePaletteOption {
  value: ThemePalette
  label: string
  desc: string
  colors: readonly [string, string, string, string]
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

export const THEME_PALETTE_OPTIONS: ThemePaletteOption[] = [
  {
    value: 'mint',
    label: '薄荷极光',
    desc: '清爽的青绿与柔和薄荷色',
    colors: ['#F7FAF9', '#E7F0EC', '#168C88', '#5BBF9F'],
  },
  {
    value: 'iris',
    label: '暮光鸢尾',
    desc: '沉静的靛蓝与明亮紫罗兰',
    colors: ['#11131C', '#1B1D2B', '#7C5CFC', '#B49CFF'],
  },
  {
    value: 'clay',
    label: '落日陶土',
    desc: '温暖的砂岩、陶土与蜂蜜色',
    colors: ['#FBF7F1', '#EFE5D8', '#C96445', '#E5A84B'],
  },
  {
    value: 'ocean',
    label: '深海蓝',
    desc: '克制的深海蓝与清透青色',
    colors: ['#0B1420', '#132337', '#2879FF', '#35C4D8'],
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
    themePalette: updates.themePalette ?? base.themePalette,
    agentMessageDisplayMode: updates.agentMessageDisplayMode ?? base.agentMessageDisplayMode,
    windowBehavior: {
      minimizeToTray: updates.windowBehavior?.minimizeToTray ?? base.windowBehavior.minimizeToTray,
      closeToTray: updates.windowBehavior?.closeToTray ?? base.windowBehavior.closeToTray,
      showTray: updates.windowBehavior?.showTray ?? base.windowBehavior.showTray,
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
