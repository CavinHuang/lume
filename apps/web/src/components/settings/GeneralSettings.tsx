import * as React from 'react'
import {
  FolderOpen,
  Laptop,
  Loader2,
  MoonStar,
  MonitorCog,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getGeneralSettings,
  openLogsDir,
  updateGeneralSettings,
  type GeneralSettings as GeneralSettingsValue,
  type ThemeMode,
} from '@/lib/desktop-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ClearCacheDialog } from './ClearCacheDialog'
import {
  GENERAL_SETTINGS_DEFAULTS,
  THEME_MODE_OPTIONS,
  mergeGeneralSettings,
} from './general-settings-state'
import { getThemeMode, setThemeMode } from '@/lib/theme-mode'

const THEME_MODE_ICONS: Record<ThemeMode, LucideIcon> = {
  system: Laptop,
  light: Sun,
  dark: MoonStar,
}

export function GeneralSettings() {
  const [settings, setSettings] = React.useState<GeneralSettingsValue>({
    ...GENERAL_SETTINGS_DEFAULTS,
    themeMode: getThemeMode(),
  })
  const [loading, setLoading] = React.useState(true)
  const [themeSaving, setThemeSaving] = React.useState<ThemeMode | null>(null)
  const [windowSaving, setWindowSaving] = React.useState<Partial<Record<keyof GeneralSettingsValue['windowBehavior'], boolean>>>({})
  const [maintenanceLoading, setMaintenanceLoading] = React.useState<{ logs: boolean }>({ logs: false })
  const [clearCacheOpen, setClearCacheOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false

    getGeneralSettings()
      .then((value) => {
        if (cancelled) {
          return
        }

        const nextSettings = mergeGeneralSettings(undefined, value)
        setSettings(nextSettings)
        setThemeMode(nextSettings.themeMode)
      })
      .catch((error) => {
        console.error('[GeneralSettings] 加载常规设置失败:', error)
        setSettings((current) => ({
          ...current,
          themeMode: getThemeMode(),
        }))
        toast.error('加载常规设置失败')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleThemeModeChange = async (themeMode: ThemeMode) => {
    if (themeSaving || settings.themeMode === themeMode) {
      return
    }

    const previous = settings
    const optimistic = mergeGeneralSettings(previous, { themeMode })
    setSettings(optimistic)
    setThemeMode(themeMode)
    setThemeSaving(themeMode)

    try {
      const persisted = mergeGeneralSettings(undefined, await updateGeneralSettings({ themeMode }))
      setSettings(persisted)
      setThemeMode(persisted.themeMode)
      toast.success('主题已更新')
    } catch (error) {
      console.error('[GeneralSettings] 更新主题失败:', error)
      setSettings(previous)
      setThemeMode(previous.themeMode)
      toast.error('主题更新失败')
    } finally {
      setThemeSaving(null)
    }
  }

  const handleWindowBehaviorChange = async (
    key: keyof GeneralSettingsValue['windowBehavior'],
    checked: boolean
  ) => {
    const previous = settings
    const optimistic = mergeGeneralSettings(previous, {
      windowBehavior: {
        [key]: checked,
      },
    })

    setSettings(optimistic)
    setWindowSaving((current) => ({ ...current, [key]: true }))

    try {
      const persisted = mergeGeneralSettings(undefined, await updateGeneralSettings({
        windowBehavior: {
          [key]: checked,
        },
      }))
      setSettings(persisted)
    } catch (error) {
      console.error('[GeneralSettings] 更新窗口行为失败:', error)
      setSettings(previous)
      toast.error('窗口行为更新失败')
    } finally {
      setWindowSaving((current) => ({ ...current, [key]: false }))
    }
  }

  const handleOpenLogsDir = async () => {
    setMaintenanceLoading({ logs: true })

    try {
      await openLogsDir()
    } catch (error) {
      console.error('[GeneralSettings] 打开日志目录失败:', error)
      toast.error('打开日志目录失败')
    } finally {
      setMaintenanceLoading({ logs: false })
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载常规设置...
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="p-6 space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">常规设置</h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              管理界面偏好、窗口行为和本地维护操作。
            </p>
          </div>
          <Badge variant="outline" className="h-6 rounded-full px-2.5 text-[11px] text-muted-foreground">
            应用级
          </Badge>
        </div>

        <SectionCard
          icon={MonitorCog}
          title="界面"
          desc="这些偏好作用于整个应用，而不是当前工作区。"
        >
          <div className="grid gap-3 md:grid-cols-3">
            {THEME_MODE_OPTIONS.map((option) => {
              const Icon = THEME_MODE_ICONS[option.value]
              const selected = settings.themeMode === option.value
              const saving = themeSaving === option.value

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleThemeModeChange(option.value)}
                  disabled={Boolean(themeSaving)}
                  className={cn(
                    'rounded-2xl border px-4 py-4 text-left transition-all',
                    selected
                      ? 'border-primary/30 bg-primary/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'border-border/60 bg-background/70 hover:bg-muted/30',
                    themeSaving && !selected && 'opacity-70'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="inline-flex size-9 items-center justify-center rounded-xl bg-muted/50">
                      <Icon size={16} className={selected ? 'text-primary' : 'text-muted-foreground'} />
                    </div>
                    {saving && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
                  </div>
                  <div className="mt-4 text-[13px] font-medium">{option.label}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{option.desc}</div>
                </button>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard
          icon={Laptop}
          title="窗口行为"
          desc="托盘相关行为会在桌面壳层读取并长期生效。"
        >
          <div className="space-y-3">
            <SettingRow
              title="最小化到系统托盘"
              desc="开启后，最小化窗口时会隐藏到系统托盘，而不是只保留在任务栏。"
              action={(
                <div className="flex items-center gap-2">
                  {windowSaving.minimizeToTray && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
                  <Switch
                    checked={settings.windowBehavior.minimizeToTray}
                    onCheckedChange={(checked) => handleWindowBehaviorChange('minimizeToTray', checked)}
                    disabled={Boolean(windowSaving.minimizeToTray)}
                  />
                </div>
              )}
            />

            <SettingRow
              title="关闭到系统托盘"
              desc="开启后，点击关闭按钮不会退出应用，而是隐藏到系统托盘。"
              action={(
                <div className="flex items-center gap-2">
                  {windowSaving.closeToTray && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
                  <Switch
                    checked={settings.windowBehavior.closeToTray}
                    onCheckedChange={(checked) => handleWindowBehaviorChange('closeToTray', checked)}
                    disabled={Boolean(windowSaving.closeToTray)}
                  />
                </div>
              )}
            />
          </div>
        </SectionCard>

        <SectionCard
          icon={Trash2}
          title="维护"
          desc="执行本地维护动作，不会影响工作区、线程和配置。"
        >
          <div className="space-y-3">
            <SettingRow
              title="打开日志目录"
              desc="在系统文件管理器中打开本地日志目录，便于排查运行问题。"
              action={(
                <Button variant="outline" size="sm" onClick={handleOpenLogsDir} disabled={maintenanceLoading.logs}>
                  {maintenanceLoading.logs ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                  打开
                </Button>
              )}
            />

            <SettingRow
              title="清理缓存"
              desc="仅清理安全缓存项。会话、线程、工作区和配置保持不变。"
              action={(
                <Button variant="outline" size="sm" onClick={() => setClearCacheOpen(true)}>
                  <Trash2 size={13} />
                  清理
                </Button>
              )}
            />
          </div>
        </SectionCard>
      </div>

      <ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />
    </>
  )
}

function SectionCard({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon
  title: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4 rounded-2xl border bg-background/70 p-5">
      <div className="flex items-start gap-3">
        <div className="inline-flex size-10 items-center justify-center rounded-2xl bg-muted/40">
          <Icon size={17} className="text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

function SettingRow({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{desc}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}
