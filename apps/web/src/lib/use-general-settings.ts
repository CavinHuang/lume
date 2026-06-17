import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { generalSettingsAtom } from '@/atoms'
import { getGeneralSettings } from '@/lib/desktop-api'

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
