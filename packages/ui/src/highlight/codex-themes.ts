import type { ThemeRegistration } from 'shiki'
import { CODEX_OFFICIAL_DARK_DATA, CODEX_OFFICIAL_LIGHT_DATA } from './codex-official-data'

export const CODEX_LIGHT_THEME_NAME = 'lume-codex-light'
export const CODEX_DARK_THEME_NAME = 'lume-codex-dark'

// invalid.* 数据前景为白且无背景，而 shiki 语法 token 不渲染背景色——白字在浅色
// 面板上不可见，包装层覆盖为可见红（light 取 gitDecoration.deletedResourceForeground，
// dark 取 terminal.ansiBrightRed，均为主题 colors 既有色）
function withInvalidForeground(data: ThemeRegistration, foreground: string): ThemeRegistration {
  return {
    ...data,
    tokenColors: data.tokenColors?.map((rule) =>
      typeof rule.scope === 'string' && rule.scope.startsWith('invalid')
        ? { ...rule, settings: { ...rule.settings, foreground } }
        : rule,
    ),
  }
}

// name 放 spread 之后：数据自带 name（Codex Light/Dark），必须用稳定注册名覆盖
export const CODEX_LIGHT_THEME: ThemeRegistration = withInvalidForeground(
  { ...CODEX_OFFICIAL_LIGHT_DATA, name: CODEX_LIGHT_THEME_NAME },
  '#e02e2a',
)

export const CODEX_DARK_THEME: ThemeRegistration = withInvalidForeground(
  { ...CODEX_OFFICIAL_DARK_DATA, name: CODEX_DARK_THEME_NAME },
  '#F44A4C',
)

export const CODEX_THEMES = [CODEX_LIGHT_THEME, CODEX_DARK_THEME] as const
