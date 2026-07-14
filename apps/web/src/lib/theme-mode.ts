import {
  GENERAL_SETTINGS_DEFAULTS,
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

export function setThemePalette(themePalette: ThemePalette): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, themePalette)
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.themePalette = themePalette
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
  return value === 'mint' || value === 'iris' || value === 'clay' || value === 'ocean'
    ? value
    : GENERAL_SETTINGS_DEFAULTS.themePalette
}
