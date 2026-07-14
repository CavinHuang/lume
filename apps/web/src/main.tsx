import React from 'react'
import ReactDOM from 'react-dom/client'
import { GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'
import { App } from './App'
import { getGeneralSettings } from './lib/desktop-api'
import { installGlobalErrorToast } from './lib/global-error-toast'
import {
  initThemeModeRuntime,
  readStoredThemeMode,
  readStoredThemePalette,
  setThemeMode,
  setThemePalette,
} from './lib/theme-mode'
import './index.css'

// Release 构建无 DevTools：尽早注册全局未处理拒绝监听，让被静默吞掉的 sidecar/异步错误以 toast 可见。
installGlobalErrorToast()

async function bootstrap() {
  const storedThemeMode = readStoredThemeMode()
  const storedThemePalette = readStoredThemePalette()
  initThemeModeRuntime(storedThemeMode, storedThemePalette)

  let themeMode = storedThemeMode || GENERAL_SETTINGS_DEFAULTS.themeMode
  let themePalette = storedThemePalette || GENERAL_SETTINGS_DEFAULTS.themePalette

  try {
    const settings = await getGeneralSettings()
    themeMode = settings.themeMode
    themePalette = settings.themePalette
  } catch {
    // Fall back to the last locally stored theme mode during bootstrap.
  }

  setThemeMode(themeMode)
  setThemePalette(themePalette)

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
