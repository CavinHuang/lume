import * as React from 'react'
import { useAtom } from 'jotai'
import {
  ChevronDown,
  FileCog,
  Loader2,
  Monitor,
  Moon,
  Sun,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  GeneralSettings as GeneralSettingsModel,
  ThemeMode,
  UpdateGeneralSettingsInput,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { openLumeConfigSourceFile } from '@/lib/desktop-api/lume-config'
import { getGeneralSettings, updateGeneralSettings } from '@/lib/desktop-api'
import { setThemeMode } from '@/lib/theme-mode'
import { cn } from '@/lib/utils'
import { ClearCacheDialog } from './ClearCacheDialog'
import {
  GENERAL_SETTINGS_DEFAULTS,
  THEME_MODE_OPTIONS,
  mergeGeneralSettings,
} from './general-settings-state'

const THEME_ICONS: Record<ThemeMode, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

export function GeneralSettings() {
  const [workspaces] = useAtom(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [settings, setSettings] = React.useState<GeneralSettingsModel>(GENERAL_SETTINGS_DEFAULTS)
  const [displayNameDraft, setDisplayNameDraft] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [clearCacheOpen, setClearCacheOpen] = React.useState(false)

  const currentWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces]
  )
  const trimmedDisplayName = displayNameDraft.trim()
  const effectiveDisplayName = settings.userProfile.displayName || '本地用户'
  const avatarLabel = Array.from(effectiveDisplayName.trim())[0]?.toUpperCase() ?? 'L'
  const displayNameChanged = trimmedDisplayName !== settings.userProfile.displayName

  React.useEffect(() => {
    let cancelled = false

    getGeneralSettings()
      .then((loaded) => {
        if (cancelled) return
        setSettings(loaded)
        setDisplayNameDraft(loaded.userProfile.displayName)
      })
      .catch((error) => {
        console.error('[GeneralSettings] load FAILED:', error)
        toast.error('加载通用设置失败')
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

  const persistSettings = async (updates: UpdateGeneralSettingsInput, successMessage: string) => {
    const optimistic = mergeGeneralSettings(settings, updates)
    setSettings(optimistic)
    setSaving(true)
    try {
      const saved = await updateGeneralSettings(updates)
      setSettings(saved)
      setDisplayNameDraft(saved.userProfile.displayName)
      if (updates.themeMode) {
        setThemeMode(saved.themeMode)
      }
      toast.success(successMessage)
    } catch (error) {
      console.error('[GeneralSettings] save FAILED:', error)
      setSettings(settings)
      setDisplayNameDraft(settings.userProfile.displayName)
      toast.error('保存通用设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleThemeChange = (themeMode: ThemeMode) => {
    if (themeMode === settings.themeMode || saving) return
    void persistSettings({ themeMode }, '外观设置已保存')
  }

  const handleSaveDisplayName = () => {
    if (!displayNameChanged || saving) return
    void persistSettings({
      userProfile: {
        displayName: trimmedDisplayName,
      },
    }, trimmedDisplayName ? '用户名称已保存' : '用户名称已清空')
  }

  if (loading) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-[10px] border border-[#e7e9f1] bg-white text-[13px] text-[#7c8398]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载通用设置...
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        <SettingsCard title="本地用户">
          <div className="flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#ebe7ff] text-[16px] font-semibold text-[#625bff]">
              {avatarLabel}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium leading-5 text-[#4d566f]">
                <UserRound size={15} className="text-[#68718a]" />
                用户名称
              </div>
              <input
                value={displayNameDraft}
                onChange={(event) => setDisplayNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleSaveDisplayName()
                  }
                }}
                placeholder="本地用户"
                className="mt-2 h-9 w-full max-w-[360px] rounded-[8px] border border-[#e3e6ee] bg-white px-3 text-[13px] font-medium text-[#283046] outline-none transition-colors placeholder:text-[#a0a7b8] focus:border-[#b7adff]"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!displayNameChanged || saving}
              onClick={handleSaveDisplayName}
              className="h-9 rounded-[8px] border-[#d8dcff] bg-white px-4 text-[13px] font-medium text-[#625bff] shadow-none hover:bg-[#f6f4ff] disabled:opacity-50"
            >
              保存
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard title="工作区">
          <SettingsRow label="默认工作区" desc="新会话默认使用的本地工作区">
            <SelectShell className="w-[180px]">
              <select
                value={currentWorkspace?.id ?? ''}
                onChange={(event) => setCurrentWorkspaceId(event.target.value || null)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none"
              >
                {workspaces.length === 0 ? (
                  <option value="">未选择</option>
                ) : workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </SelectShell>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title="外观">
          <SettingsRow label="主题">
            <div className="grid h-9 w-[306px] grid-cols-3 rounded-[8px] border border-[#e3e6ee] bg-white p-0.5">
              {THEME_MODE_OPTIONS.map((option) => {
                const Icon = THEME_ICONS[option.value]
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleThemeChange(option.value)}
                    disabled={saving}
                    className={cn(
                      'inline-flex items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-medium transition-colors disabled:opacity-60',
                      settings.themeMode === option.value
                        ? 'border border-[#9f91ff] bg-[#f5f2ff] text-[#625bff]'
                        : 'text-[#667089] hover:bg-[#f7f8fb]'
                    )}
                  >
                    <Icon size={14} />
                    {option.label}
                  </button>
                )
              })}
            </div>
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title="窗口行为">
          <div className="divide-y divide-[#eef0f5]">
            <SettingsRow
              label="最小化到托盘"
              desc="点击最小化时保留后台运行"
            >
              <LumeSwitch
                checked={settings.windowBehavior.minimizeToTray}
                disabled={saving}
                onCheckedChange={(checked) => void persistSettings({
                  windowBehavior: {
                    minimizeToTray: checked,
                  },
                }, '窗口行为已保存')}
              />
            </SettingsRow>
            <SettingsRow
              label="关闭到托盘"
              desc="关闭窗口时不退出应用"
            >
              <LumeSwitch
                checked={settings.windowBehavior.closeToTray}
                disabled={saving}
                onCheckedChange={(checked) => void persistSettings({
                  windowBehavior: {
                    closeToTray: checked,
                  },
                }, '窗口行为已保存')}
              />
            </SettingsRow>
          </div>
        </SettingsCard>

        <SettingsCard title="本地数据">
          <div className="grid grid-cols-2 gap-3">
            <QuickAction icon={FileCog} label="打开配置文件" onClick={() => void openLumeConfigSourceFile()} />
            <QuickAction
              icon={Trash2}
              label="清理缓存"
              tone="danger"
              onClick={() => setClearCacheOpen(true)}
            />
          </div>
        </SettingsCard>
      </div>

      <ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />
    </>
  )
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[#e7e9f1] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[#202338]">{title}</h2>
      {children}
    </section>
  )
}

function SettingsRow({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5 text-[#4d566f]">{label}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-4 text-[#9aa1b3]">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-9 rounded-[8px] border border-[#e3e6ee] bg-white', className)}>
      {children}
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#778096]"
      />
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[25px] data-[size=default]:w-[42px] data-checked:bg-[#625bff]',
        '[&_[data-slot=switch-thumb]]:size-[21px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[19px]'
      )}
    />
  )
}

function QuickAction({
  icon: Icon,
  label,
  tone = 'default',
  onClick,
}: {
  icon: LucideIcon
  label: string
  tone?: 'default' | 'danger'
  onClick?: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        'h-10 gap-2 rounded-[8px] border-[#e3e6ee] bg-white text-[13px] font-medium text-[#4d566f] shadow-none hover:bg-[#f8f9fc]',
        tone === 'danger' && 'border-[#ff9fa8] text-[#ff4d57] hover:bg-[#fff5f6] hover:text-[#ff4d57]'
      )}
    >
      <Icon size={15} />
      {label}
    </Button>
  )
}
