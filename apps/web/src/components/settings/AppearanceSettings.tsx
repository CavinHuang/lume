import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Monitor, Moon, Sparkles, Sun, Trash2, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentMessageDisplayMode,
  AgentMessageAvatarMode,
  AgentMessageListDisplayMode,
  ChatFontScale,
  CustomThemePalette,
  ThemeMode,
  ThemePalette,
  UpdateGeneralSettingsInput,
} from '@lume/shared'
import { updateGeneralSettings } from '@/lib/desktop-api'
import {
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  generalSettingsAtom,
  tabsAtom,
  welcomePromptSeedAtom,
} from '@/atoms'
import { setThemeMode, setThemePalette } from '@/lib/theme-mode'
import { setChatFontScale } from '@/lib/chat-font-scale'
import { useBootstrapGeneralSettings } from '@/hooks/use-general-settings'
import { cn } from '@/lib/utils'
import {
  THEME_MODE_OPTIONS,
  THEME_PALETTE_OPTIONS,
  mergeGeneralSettings,
} from './general-settings-state'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { upsertWelcomeTab } from '@/components/app-shell/LeftSidebar'
const THEME_ICONS: Record<ThemeMode, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const DISPLAY_MODE_OPTIONS: Array<{ value: AgentMessageDisplayMode; label: string; desc: string }> = [
  { value: 'minimal', label: '极简', desc: '只显示文字结论，过程收进可展开的一行' },
  { value: 'verbose', label: '明细', desc: '每个工具/思考/子代理独立折叠展示' },
]

const MESSAGE_LIST_DISPLAY_MODE_OPTIONS: Array<{ value: AgentMessageListDisplayMode; label: string; desc: string }> = [
  { value: 'conversation', label: '气泡模式', desc: '用户消息显示在右侧，保持当前对话形式' },
  { value: 'left_aligned', label: '文档模式', desc: '参考飞书，用户和助手消息统一从左侧开始' },
]

const MESSAGE_AVATAR_MODE_OPTIONS: Array<{ value: AgentMessageAvatarMode; label: string; desc: string }> = [
  { value: 'visible', label: '显示头像', desc: '显示用户和助手消息头像' },
  { value: 'hidden', label: '不显示头像', desc: '隐藏消息头像，保留消息内容' },
]

const CHAT_FONT_SCALE_OPTIONS: Array<{ value: ChatFontScale; label: string }> = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
]

export function AppearanceSettings() {
  useBootstrapGeneralSettings()
  const [settings, setSettings] = useAtom(generalSettingsAtom)
  const [saving, setSaving] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<CustomThemePalette | null>(null)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)

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
      if (updates.themePalette || updates.customThemePalettes) {
        setThemePalette(saved.themePalette, saved.customThemePalettes)
      }
      if (updates.chatFontScale) {
        setChatFontScale(saved.chatFontScale)
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

  const handleMessageListDisplayModeChange = (mode: AgentMessageListDisplayMode) => {
    if (mode === settings.agentMessageListDisplayMode || saving) return
    void persistSettings({ agentMessageListDisplayMode: mode }, '外观设置已保存')
  }

  const handleMessageAvatarModeChange = (mode: AgentMessageAvatarMode) => {
    if (mode === settings.agentMessageAvatarMode || saving) return
    void persistSettings({ agentMessageAvatarMode: mode }, '外观设置已保存')
  }

  const handleChatFontScaleChange = (scale: ChatFontScale) => {
    const current = settings.chatFontScale ?? 'md'
    if (scale === current || saving) return
    void persistSettings({ chatFontScale: scale }, '外观设置已保存')
  }

  const handleAskLumeToConfigure = () => {
    setWelcomePromptSeed(
      '请帮我为 Lume 设计一套自定义主题。先询问我的风格、色彩和使用场景偏好；确认方案后，使用 personalize_ui 的 upsert_theme 操作创建并立即启用主题。主题需要同时提供浅色与深色配色，并确保文字与背景有足够对比度。'
    )
    setTabs((current) => upsertWelcomeTab(current, currentWorkspaceId))
    setActiveTabId('__welcome__')
  }

  const handleDeleteCustomTheme = (theme: CustomThemePalette) => {
    const customThemePalettes = settings.customThemePalettes.filter((item) => item.id !== theme.id)
    void persistSettings({
      customThemePalettes,
      ...(settings.themePalette === theme.id ? { themePalette: 'mint' } : {}),
    }, '自定义主题已删除')
  }

  return (
    <div className="space-y-3">
      <section className="lume-panel-padded">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">主题与配色</h2>
          <Button type="button" variant="outline" size="sm" onClick={handleAskLumeToConfigure}>
            <Sparkles size={14} />
            让 Lume 配置
          </Button>
        </div>
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
        <div className="py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">配色</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              亮度模式与配色可以独立组合
            </div>
          </div>
          <div className="mt-3 grid w-full grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
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
            {settings.customThemePalettes.map((theme) => {
              const selected = settings.themePalette === theme.id
              const colors = [theme.light.background, theme.light.surface, theme.light.accent, theme.light.text]
              return (
                <div
                  key={theme.id}
                  className={cn(
                    'flex min-w-0 items-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)]',
                    selected ? 'border-[var(--brand)] ring-1 ring-[var(--brand)]' : ''
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    title={theme.name}
                    onClick={() => handleThemePaletteChange(theme.id)}
                    disabled={saving}
                    className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-r-none px-3 py-2 text-[12px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-3)]"
                  >
                    <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                      {colors.map((color, index) => (
                        <span
                          key={`${color}-${index}`}
                          className="size-3 rounded-full border border-black/10 dark:border-white/15"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </span>
                    <span className="truncate">{theme.name}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除主题 ${theme.name}`}
                    title="删除自定义主题"
                    disabled={saving}
                    onClick={() => setDeleteTarget(theme)}
                    className="mr-1 size-7 shrink-0 text-[var(--text-3)] hover:text-destructive"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">消息头像</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              控制用户和助手消息是否显示头像
            </div>
          </div>
          <div className="lume-segmented grid w-[220px] grid-cols-2">
            {MESSAGE_AVATAR_MODE_OPTIONS.map((option) => (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => handleMessageAvatarModeChange(option.value)}
                disabled={saving}
                title={option.desc}
                className={cn(
                  'lume-segmented-item disabled:opacity-60',
                  settings.agentMessageAvatarMode === option.value
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

      <section className="lume-panel-padded">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">Agent 消息显示</h2>
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-body font-medium leading-5 text-[var(--text-2)]">对话字号</div>
            <div className="mt-0.5 text-ui leading-4 text-[var(--text-3)]">
              调整消息正文与代码块字号，界面其他部分不受影响
            </div>
          </div>
          <div className="lume-segmented grid w-[220px] grid-cols-3">
            {CHAT_FONT_SCALE_OPTIONS.map((option) => (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => handleChatFontScaleChange(option.value)}
                disabled={saving}
                className={cn(
                  'lume-segmented-item disabled:opacity-60',
                  (settings.chatFontScale ?? 'md') === option.value
                    ? 'lume-segmented-item-active'
                    : '',
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
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
        <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">消息列表样式</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
              选择消息在对话中的排列方式
            </div>
          </div>
          <div className="lume-segmented grid w-[220px] grid-cols-2">
            {MESSAGE_LIST_DISPLAY_MODE_OPTIONS.map((option) => (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => handleMessageListDisplayModeChange(option.value)}
                disabled={saving}
                title={option.desc}
                className={cn(
                  'lume-segmented-item disabled:opacity-60',
                  settings.agentMessageListDisplayMode === option.value
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除自定义主题？"
        description={`“${deleteTarget?.name ?? ''}”将从 Lume 中移除。此操作无法撤销。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deleteTarget) handleDeleteCustomTheme(deleteTarget)
        }}
      />
    </div>
  )
}
