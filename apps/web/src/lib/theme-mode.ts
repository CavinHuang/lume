import {
  GENERAL_SETTINGS_DEFAULTS,
  type CustomThemePalette,
  type ThemeMode,
  type ThemePalette,
} from '@lume/shared'

let initialized = false
let currentThemeMode: ThemeMode = GENERAL_SETTINGS_DEFAULTS.themeMode
const mediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null
const THEME_MODE_STORAGE_KEY = 'lume:theme-mode'
const THEME_PALETTE_STORAGE_KEY = 'lume:theme-palette'
const CUSTOM_THEME_CACHE_STORAGE_KEY = 'lume:custom-theme-cache'
const CUSTOM_THEME_VARIABLES = ['background', 'surface', 'text', 'muted', 'accent'] as const

function isCustomThemePaletteId(value: unknown): value is `custom:${string}` {
  return typeof value === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(value)
}

function readCachedCustomTheme(themePalette: ThemePalette): CustomThemePalette | undefined {
  if (typeof window === 'undefined' || !isCustomThemePaletteId(themePalette)) return undefined
  try {
    const cached = JSON.parse(window.localStorage.getItem(CUSTOM_THEME_CACHE_STORAGE_KEY) ?? 'null') as CustomThemePalette | null
    return cached?.id === themePalette ? cached : undefined
  } catch {
    return undefined
  }
}

function clearCustomThemeRuntime(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(CUSTOM_THEME_CACHE_STORAGE_KEY)
  }
  if (typeof document === 'undefined') return
  delete document.documentElement.dataset.customThemeId
  for (const mode of ['light', 'dark'] as const) {
    for (const variable of CUSTOM_THEME_VARIABLES) {
      document.documentElement.style.removeProperty(`--lume-custom-${mode}-${variable}`)
    }
  }
}

export function resolveShouldUseDark(themeMode: ThemeMode, prefersDark: boolean): boolean {
  return themeMode === 'dark' || (themeMode === 'system' && prefersDark)
}

function applyThemeClass(): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.classList.toggle(
    'dark',
    resolveShouldUseDark(currentThemeMode, mediaQuery?.matches ?? false)
  )
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  if (currentThemeMode === 'system') {
    document.documentElement.classList.toggle('dark', event.matches)
  }
}

export function initThemeModeRuntime(
  initialThemeMode: ThemeMode = GENERAL_SETTINGS_DEFAULTS.themeMode,
  initialThemePalette: ThemePalette = GENERAL_SETTINGS_DEFAULTS.themePalette
): void {
  if (!initialized && mediaQuery) {
    mediaQuery.addEventListener('change', handleSystemThemeChange)
    initialized = true
  }

  setThemeMode(initialThemeMode)
  setThemePalette(initialThemePalette)
}

export function setThemeMode(themeMode: ThemeMode): void {
  currentThemeMode = themeMode
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode)
  }
  applyThemeClass()
}

export function getThemeMode(): ThemeMode {
  return currentThemeMode
}

export function setThemePalette(
  themePalette: ThemePalette,
  customThemePalettes: CustomThemePalette[] = []
): void {
  const customTheme = isCustomThemePaletteId(themePalette)
    ? customThemePalettes.find((theme) => theme.id === themePalette) ?? readCachedCustomTheme(themePalette)
    : undefined
  const appliedPalette = customTheme ? themePalette : isCustomThemePaletteId(themePalette) ? 'mint' : themePalette
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, appliedPalette)
    if (customTheme) {
      window.localStorage.setItem(CUSTOM_THEME_CACHE_STORAGE_KEY, JSON.stringify(customTheme))
    }
  }
  if (typeof document !== 'undefined') {
    if (!customTheme) {
      clearCustomThemeRuntime()
      document.documentElement.dataset.themePalette = appliedPalette
      return
    }
    document.documentElement.dataset.themePalette = 'custom'
    document.documentElement.dataset.customThemeId = customTheme.id
    for (const mode of ['light', 'dark'] as const) {
      for (const variable of CUSTOM_THEME_VARIABLES) {
        document.documentElement.style.setProperty(
          `--lume-custom-${mode}-${variable}`,
          customTheme[mode][variable]
        )
      }
    }
  }
}

export function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return GENERAL_SETTINGS_DEFAULTS.themeMode
  }

  const value = window.localStorage.getItem(THEME_MODE_STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : GENERAL_SETTINGS_DEFAULTS.themeMode
}

export function readStoredThemePalette(): ThemePalette {
  if (typeof window === 'undefined') {
    return GENERAL_SETTINGS_DEFAULTS.themePalette
  }

  const value = window.localStorage.getItem(THEME_PALETTE_STORAGE_KEY)
  return value === 'mint'
    || value === 'iris'
    || value === 'clay'
    || value === 'ocean'
    || value === 'sakura'
    || value === 'ember'
    || value === 'mono'
    || value === 'lavender'
    || value === 'olive'
    || isCustomThemePaletteId(value)
    ? value
    : GENERAL_SETTINGS_DEFAULTS.themePalette
}
