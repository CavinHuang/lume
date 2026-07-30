import { useSyncExternalStore } from 'react'
import { CODEX_DARK_THEME_NAME, CODEX_LIGHT_THEME_NAME } from './codex-themes'

export type CodeThemeName = typeof CODEX_LIGHT_THEME_NAME | typeof CODEX_DARK_THEME_NAME

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

export function getCodeThemeName(): CodeThemeName {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? CODEX_DARK_THEME_NAME
    : CODEX_LIGHT_THEME_NAME
}

export function getCodeThemeType(): 'light' | 'dark' {
  return getCodeThemeName() === CODEX_DARK_THEME_NAME ? 'dark' : 'light'
}

function subscribeCodeTheme(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

export function useCodeTheme(): { name: CodeThemeName; type: 'light' | 'dark' } {
  const name = useSyncExternalStore<CodeThemeName>(
    subscribeCodeTheme,
    getCodeThemeName,
    () => CODEX_LIGHT_THEME_NAME,
  )
  return { name, type: name === CODEX_DARK_THEME_NAME ? 'dark' : 'light' }
}
