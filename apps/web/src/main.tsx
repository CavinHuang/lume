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
import { PierreDiffProvider } from './components/diff/PierreDiffProvider'
import { BrowserWebviewPoolProvider } from './components/browser/BrowserWebviewPool'

// Release 构建无 DevTools：尽早注册全局未处理拒绝监听，让被静默吞掉的 sidecar/异步错误以 toast 可见。
installGlobalErrorToast()

async function bootstrap() {
  const storedThemeMode = readStoredThemeMode()
  const storedThemePalette = readStoredThemePalette()
  initThemeModeRuntime(storedThemeMode, storedThemePalette)

  let themeMode = storedThemeMode || GENERAL_SETTINGS_DEFAULTS.themeMode
  let themePalette = storedThemePalette || GENERAL_SETTINGS_DEFAULTS.themePalette
  let customThemePalettes = GENERAL_SETTINGS_DEFAULTS.customThemePalettes

  try {
    const settings = await getGeneralSettings()
    themeMode = settings.themeMode
    themePalette = settings.themePalette
    customThemePalettes = settings.customThemePalettes
  } catch {
    // Fall back to the last locally stored theme mode during bootstrap.
  }

  setThemeMode(themeMode)
  setThemePalette(themePalette, customThemePalettes)

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PierreDiffProvider>
        <BrowserWebviewPoolProvider>
          <App />
        </BrowserWebviewPoolProvider>
      </PierreDiffProvider>
    </React.StrictMode>
  )
}

void bootstrap()
