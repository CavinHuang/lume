import type { ThemeRegistration } from 'shiki'
import { CODEX_OFFICIAL_DARK_DATA, CODEX_OFFICIAL_LIGHT_DATA } from './codex-official-data'

export const CODEX_LIGHT_THEME_NAME = 'lume-codex-light'
export const CODEX_DARK_THEME_NAME = 'lume-codex-dark'

// name 放 spread 之后：数据自带 name（Codex Light/Dark），必须用稳定注册名覆盖
export const CODEX_LIGHT_THEME: ThemeRegistration = {
  ...CODEX_OFFICIAL_LIGHT_DATA,
  name: CODEX_LIGHT_THEME_NAME,
}

export const CODEX_DARK_THEME: ThemeRegistration = {
  ...CODEX_OFFICIAL_DARK_DATA,
  name: CODEX_DARK_THEME_NAME,
}

export const CODEX_THEMES = [CODEX_LIGHT_THEME, CODEX_DARK_THEME] as const
