import type {
  AgentProxyMode,
  AgentProxySettings,
  GeneralSettings,
  BuiltInThemePalette,
  UpdateGeneralSettingsInput,
  ThemeMode,
} from '@lume/shared'
import { GENERAL_SETTINGS_DEFAULTS as SHARED_GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'

export interface ThemeModeOption {
  value: ThemeMode
  label: string
  desc: string
}

export interface ThemePaletteOption {
  value: BuiltInThemePalette
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
  {
    value: 'sakura',
    label: '樱雾',
    desc: '轻盈的瓷粉、莓红与柔和樱色',
    colors: ['#FFF8FA', '#F7E8EE', '#D94F70', '#F29AB2'],
  },
  {
    value: 'ember',
    label: '石墨余烬',
    desc: '克制的石墨黑与明亮余烬橙',
    colors: ['#141414', '#202020', '#F06A3C', '#FFB15C'],
  },
  {
    value: 'mono',
    label: '纸墨极简',
    desc: '近乎无彩色，以留白和层级构成界面',
    colors: ['#FCFCFB', '#F0F0EE', '#D8D8D4', '#222222'],
  },
  {
    value: 'lavender',
    label: '薰衣草灰',
    desc: '低饱和的灰紫与柔和长春花色',
    colors: ['#FAF9FC', '#ECE9F1', '#77709B', '#AAA3C4'],
  },
  {
    value: 'olive',
    label: '橄榄工作室',
    desc: '骨白底色搭配植物橄榄与卡其色',
    colors: ['#FBFAF4', '#EBE9DA', '#777D43', '#AEB27A'],
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
    customThemePalettes: updates.customThemePalettes ?? base.customThemePalettes ?? [],
    agentMessageDisplayMode: updates.agentMessageDisplayMode ?? base.agentMessageDisplayMode,
    logging: {
      ...base.logging,
      ...(updates.logging ?? {}),
    },
    windowBehavior: (() => {
      const showTray = updates.windowBehavior?.showTray ?? base.windowBehavior.showTray
      return {
        minimizeToTray: showTray && (updates.windowBehavior?.minimizeToTray ?? base.windowBehavior.minimizeToTray),
        closeToTray: showTray && (updates.windowBehavior?.closeToTray ?? base.windowBehavior.closeToTray),
        showTray,
      }
    })(),
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
