import React from 'react'
import ReactDOM from 'react-dom/client'
import { GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'
import { App } from './App'
import { getGeneralSettings } from './lib/desktop-api'
import { installGlobalErrorToast } from './lib/global-error-toast'
import { initThemeModeRuntime, readStoredThemeMode, setThemeMode } from './lib/theme-mode'
import './index.css'

// Release 构建无 DevTools：尽早注册全局未处理拒绝监听，让被静默吞掉的 sidecar/异步错误以 toast 可见。
installGlobalErrorToast()

async function bootstrap() {
  const storedThemeMode = readStoredThemeMode()
  initThemeModeRuntime(storedThemeMode)

  let themeMode = storedThemeMode || GENERAL_SETTINGS_DEFAULTS.themeMode

  try {
    const settings = await getGeneralSettings()
    themeMode = settings.themeMode
  } catch {
    // Fall back to the last locally stored theme mode during bootstrap.
  }

  setThemeMode(themeMode)

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
