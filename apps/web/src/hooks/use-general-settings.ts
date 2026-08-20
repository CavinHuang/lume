import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import type { LumeRuntimeEvent } from '@lume/shared'
import { generalSettingsAtom } from '@/atoms'
import { getGeneralSettings } from '@/lib/desktop-api'
import { setThemeMode, setThemePalette } from '@/lib/theme-mode'

let bootstrapped = false

/** 加载通用设置到全局 atom，每个 session 仅执行一次。 */
export function useBootstrapGeneralSettings() {
  const setGeneralSettings = useSetAtom(generalSettingsAtom)

  useEffect(() => {
    if (bootstrapped) return
    bootstrapped = true
    getGeneralSettings()
      .then((settings) => setGeneralSettings(settings))
      .catch((error) => console.error('[generalSettings] 加载失败:', error))
  }, [setGeneralSettings])
}

export function getLatestPersonalizeUiCompletionId(events: LumeRuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool.completed' && event.toolName === 'personalize_ui') {
      return event.id
    }
  }
  return null
}

/** 对话中的 personalize_ui 完成后，立即刷新设置和当前主题。 */
export function useSyncGeneralSettingsAfterPersonalize(events: LumeRuntimeEvent[]): void {
  const setGeneralSettings = useSetAtom(generalSettingsAtom)
  const lastCompletionIdRef = useRef<string | null>(null)
  const completionId = getLatestPersonalizeUiCompletionId(events)

  useEffect(() => {
    if (!completionId || completionId === lastCompletionIdRef.current) return
    lastCompletionIdRef.current = completionId
    getGeneralSettings()
      .then((settings) => {
        setGeneralSettings(settings)
        setThemeMode(settings.themeMode)
        setThemePalette(settings.themePalette, settings.customThemePalettes)
      })
      .catch((error) => console.error('[generalSettings] 个性化设置同步失败:', error))
  }, [completionId, setGeneralSettings])
}
