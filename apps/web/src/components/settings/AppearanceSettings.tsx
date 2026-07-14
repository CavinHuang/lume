import * as React from 'react'
import { useAtom } from 'jotai'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentMessageDisplayMode,
  ThemeMode,
  ThemePalette,
  UpdateGeneralSettingsInput,
} from '@lume/shared'
import { updateGeneralSettings } from '@/lib/desktop-api'
import { generalSettingsAtom } from '@/atoms'
import { setThemeMode, setThemePalette } from '@/lib/theme-mode'
import { useBootstrapGeneralSettings } from '@/lib/use-general-settings'
import { cn } from '@/lib/utils'
import {
  THEME_MODE_OPTIONS,
  THEME_PALETTE_OPTIONS,
  mergeGeneralSettings,
} from './general-settings-state'

import { Button } from '@/components/ui/button'
const THEME_ICONS: Record<ThemeMode, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const DISPLAY_MODE_OPTIONS: Array<{ value: AgentMessageDisplayMode; label: string; desc: string }> = [
  { value: 'minimal', label: '极简', desc: '只显示文字结论，过程收进可展开的一行' },
  { value: 'verbose', label: '明细', desc: '每个工具/思考/子代理独立折叠展示' },
]

export function AppearanceSettings() {
  useBootstrapGeneralSettings()
  const [settings, setSettings] = useAtom(generalSettingsAtom)
  const [saving, setSaving] = React.useState(false)

  const persistSettings = async (updates: UpdateGeneralSettingsInput, successMessage: string) => {
    const optimistic = mergeGeneralSettings(settings, updates)
    setSettings(optimistic)
    setSaving(true)
    try {
      const saved = await updateGeneralSettings(updates)
      setSettings(saved)
      if (updates.themeMode) {
        setThemeMode(saved.themeMode)
      }
      if (updates.themePalette) {
        setThemePalette(saved.themePalette)
      }
      toast.success(successMessage)
    } catch (error) {
      console.error('[AppearanceSettings] 保存失败:', error)
      setSettings(settings)
      toast.error('保存外观设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleThemeChange = (themeMode: ThemeMode) => {
    if (themeMode === settings.themeMode || saving) return
    void persistSettings({ themeMode }, '外观设置已保存')
  }

  const handleThemePaletteChange = (themePalette: ThemePalette) => {
    if (themePalette === settings.themePalette || saving) return
    void persistSettings({ themePalette }, '主题配色已保存')
  }

  const handleDisplayModeChange = (mode: AgentMessageDisplayMode) => {
    if (mode === settings.agentMessageDisplayMode || saving) return
    void persistSettings({ agentMessageDisplayMode: mode }, '外观设置已保存')
  }

  return (
    <div className="space-y-3">
      <section className="lume-panel-padded">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">主题与配色</h2>
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">主题</div>
          <div className="lume-segmented grid w-[306px] grid-cols-3">
            {THEME_MODE_OPTIONS.map((option) => {
              const Icon = THEME_ICONS[option.value]
              return (
                <Button
                  variant="ghost"
                  key={option.value}
                  type="button"
                  onClick={() => handleThemeChange(option.value)}
                  disabled={saving}
                  className={cn(
                    'lume-segmented-item disabled:opacity-60',
                    settings.themeMode === option.value
                      ? 'lume-segmented-item-active'
                      : ''
                  )}
                >
                  <Icon size={14} />
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">配色</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              亮度模式与配色可以独立组合
            </div>
          </div>
          <div className="grid w-[306px] grid-cols-2 gap-2">
            {THEME_PALETTE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                aria-pressed={settings.themePalette === option.value}
                title={option.desc}
                onClick={() => handleThemePaletteChange(option.value)}
                disabled={saving}
                className={cn(
                  'h-auto min-w-0 justify-start gap-2 rounded-[8px] border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-3)]',
                  settings.themePalette === option.value
                    ? 'border-[var(--brand)] text-[var(--text-1)] ring-1 ring-[var(--brand)]'
                    : ''
                )}
              >
                <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                  {option.colors.map((color) => (
                    <span
                      key={color}
                      className="size-3 rounded-full border border-black/10 dark:border-white/15"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
                <span className="truncate">{option.label}</span>
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="lume-panel-padded">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">Agent 消息显示</h2>
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">显示方式</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              控制 agent 回合中工具调用 / 思考 / 子代理的展示密度
            </div>
          </div>
          <div className="lume-segmented grid w-[220px] grid-cols-2">
            {DISPLAY_MODE_OPTIONS.map((option) => (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => handleDisplayModeChange(option.value)}
                disabled={saving}
                title={option.desc}
                className={cn(
                  'lume-segmented-item disabled:opacity-60',
                  settings.agentMessageDisplayMode === option.value
                    ? 'lume-segmented-item-active'
                    : '',
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
