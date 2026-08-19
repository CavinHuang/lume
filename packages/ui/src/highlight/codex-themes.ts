import type { ThemeRegistration } from 'shiki'
import { CODEX_OFFICIAL_DARK_DATA, CODEX_OFFICIAL_LIGHT_DATA } from './codex-official-data'

export const CODEX_LIGHT_THEME_NAME = 'lume-codex-light'
export const CODEX_DARK_THEME_NAME = 'lume-codex-dark'

// invalid.* 前景为白但无背景——白字在浅色代码面板上不可见，包装层统一补红底兜底
// （色值取主题 colors 的 gitDecoration.deletedResourceForeground，light/dark 同值）
function withInvalidBackground(data: ThemeRegistration): ThemeRegistration {
  return {
    ...data,
    tokenColors: data.tokenColors?.map((rule) =>
      typeof rule.scope === 'string' && rule.scope.startsWith('invalid')
        ? { ...rule, settings: { ...rule.settings, background: '#e02e2a' } }
        : rule,
    ),
  }
}

// name 放 spread 之后：数据自带 name（Codex Light/Dark），必须用稳定注册名覆盖
export const CODEX_LIGHT_THEME: ThemeRegistration = withInvalidBackground({
  ...CODEX_OFFICIAL_LIGHT_DATA,
  name: CODEX_LIGHT_THEME_NAME,
})

export const CODEX_DARK_THEME: ThemeRegistration = withInvalidBackground({
  ...CODEX_OFFICIAL_DARK_DATA,
  name: CODEX_DARK_THEME_NAME,
})

export const CODEX_THEMES = [CODEX_LIGHT_THEME, CODEX_DARK_THEME] as const
