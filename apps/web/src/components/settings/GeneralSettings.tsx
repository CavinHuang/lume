import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  ChevronDown,
  FileCog,
  Loader2,
  Monitor,
  Moon,
  Network,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentProxyMode,
  AgentProxySettings,
  AgentProxyStatus,
  GeneralSettings as GeneralSettingsModel,
  ThemeMode,
  UpdateGeneralSettingsInput,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom } from '@/atoms'
import { openLumeConfigSourceFile } from '@/lib/desktop-api/lume-config'
import { getGeneralSettings, getProxySettings, saveProxySettings, updateGeneralSettings } from '@/lib/desktop-api'
import { setThemeMode } from '@/lib/theme-mode'
import { cn } from '@/lib/utils'
import {
  GENERAL_SETTINGS_DEFAULTS,
  PROXY_MODE_OPTIONS,
  THEME_MODE_OPTIONS,
  mergeGeneralSettings,
  normalizeProxyDraft,
} from './general-settings-state'

const THEME_ICONS: Record<ThemeMode, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const DEFAULT_PROXY_SETTINGS: AgentProxySettings = {
  version: 1,
  enabled: false,
  mode: 'off',
}

export function GeneralSettings() {
  const [workspaces] = useAtom(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [settings, setSettings] = React.useState<GeneralSettingsModel>(GENERAL_SETTINGS_DEFAULTS)
  const [proxyStatus, setProxyStatus] = React.useState<AgentProxyStatus | null>(null)
  const [proxyDraft, setProxyDraft] = React.useState<AgentProxySettings>(DEFAULT_PROXY_SETTINGS)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const setSettingsTab = useSetAtom(settingsInitialTabAtom)

  const currentWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces]
  )
  const normalizedProxyDraft = React.useMemo(() => normalizeProxyDraft(proxyDraft), [proxyDraft])
  const proxyChanged = React.useMemo(
    () => JSON.stringify(normalizedProxyDraft) !== JSON.stringify(normalizeProxyDraft(proxyStatus?.settings ?? DEFAULT_PROXY_SETTINGS)),
    [normalizedProxyDraft, proxyStatus]
  )

  React.useEffect(() => {
    let cancelled = false

    Promise.all([getGeneralSettings(), getProxySettings()])
      .then(([loaded, loadedProxy]) => {
        if (cancelled) return
        setSettings(loaded)
        setProxyStatus(loadedProxy)
        setProxyDraft(loadedProxy.settings)
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
      if (updates.themeMode) {
        setThemeMode(saved.themeMode)
      }
      toast.success(successMessage)
    } catch (error) {
      console.error('[GeneralSettings] save FAILED:', error)
      setSettings(settings)
      toast.error('保存通用设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleThemeChange = (themeMode: ThemeMode) => {
    if (themeMode === settings.themeMode || saving) return
    void persistSettings({ themeMode }, '外观设置已保存')
  }

  const handleProxyModeChange = (mode: AgentProxyMode) => {
    setProxyDraft((current) => ({
      ...current,
      enabled: mode !== 'off',
      mode,
    }))
  }

  const handleProxyDraftChange = (key: 'httpProxy' | 'httpsProxy' | 'noProxy', value: string) => {
    setProxyDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const handleSaveProxy = async () => {
    if (!proxyChanged || saving) return
    setSaving(true)
    try {
      const saved = await saveProxySettings(normalizedProxyDraft)
      setProxyStatus(saved)
      setProxyDraft(saved.settings)
      toast.success('网络代理设置已保存')
    } catch (error) {
      console.error('[GeneralSettings] save proxy FAILED:', error)
      if (proxyStatus) {
        setProxyDraft(proxyStatus.settings)
      }
      toast.error('保存网络代理失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载通用设置...
      </div>
    )
  }

  return (
    <div className="space-y-3">
        <SettingsCard title="工作区">
          <SettingsRow label="默认工作区" desc="新会话默认使用的本地工作区">
            <SelectShell className="w-[180px]">
              <select
                value={currentWorkspace?.id ?? ''}
                onChange={(event) => setCurrentWorkspaceId(event.target.value || null)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[var(--text-2)] outline-none"
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
            <div className="grid h-9 w-[306px] grid-cols-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
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
                        ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
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
          <div className="divide-y divide-[var(--border)]">
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

        <SettingsCard title="网络代理">
          <div className="space-y-3">
            <SettingsRow label="代理模式" desc="用于 sidecar 中需要联网的工具">
              <div className="grid h-9 w-[306px] grid-cols-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
                {PROXY_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleProxyModeChange(option.value)}
                    disabled={saving}
                    title={option.desc}
                    className={cn(
                      'inline-flex items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-medium transition-colors disabled:opacity-60',
                      proxyDraft.mode === option.value
                        ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                    )}
                  >
                    <Network size={14} />
                    {option.label}
                  </button>
                ))}
              </div>
            </SettingsRow>

            {proxyDraft.mode === 'system' && (
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-5 text-[var(--text-3)]">
                <div>HTTP: {proxyStatus?.systemProxy.httpProxy || '未检测到'}</div>
                <div>HTTPS: {proxyStatus?.systemProxy.httpsProxy || proxyStatus?.systemProxy.httpProxy || '未检测到'}</div>
                <div>NO_PROXY: {proxyStatus?.systemProxy.noProxy || '未设置'}</div>
              </div>
            )}

            {proxyDraft.mode === 'custom' && (
              <div className="grid gap-2">
                <ProxyInput
                  label="HTTP"
                  value={proxyDraft.httpProxy ?? ''}
                  placeholder="http://127.0.0.1:7890"
                  disabled={saving}
                  onChange={(value) => handleProxyDraftChange('httpProxy', value)}
                />
                <ProxyInput
                  label="HTTPS"
                  value={proxyDraft.httpsProxy ?? ''}
                  placeholder="默认使用 HTTP 代理"
                  disabled={saving}
                  onChange={(value) => handleProxyDraftChange('httpsProxy', value)}
                />
                <ProxyInput
                  label="NO_PROXY"
                  value={proxyDraft.noProxy ?? ''}
                  placeholder="localhost,127.0.0.1"
                  disabled={saving}
                  onChange={(value) => handleProxyDraftChange('noProxy', value)}
                />
              </div>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={!proxyChanged || saving}
                onClick={handleSaveProxy}
                className="h-9 rounded-[8px] border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))] bg-[var(--surface-1)] px-4 text-[13px] font-medium text-[var(--brand)] shadow-none hover:bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface-1))] disabled:opacity-50"
              >
                保存代理
              </Button>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="本地数据">
          <div className="grid grid-cols-2 gap-3">
            <QuickAction icon={FileCog} label="打开配置文件" onClick={() => void openLumeConfigSourceFile()} />
            <QuickAction
              icon={Trash2}
              label="数据管理"
              onClick={() => setSettingsTab('data')}
            />
          </div>
        </SettingsCard>
    </div>
  )
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">{title}</h2>
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
        <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">{label}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)]', className)}>
      {children}
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-2)]"
      />
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[25px] data-[size=default]:w-[42px] data-checked:bg-[var(--brand)]',
        '[&_[data-slot=switch-thumb]]:size-[21px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[19px]'
      )}
    />
  )
}

function ProxyInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2 text-[12px] font-medium text-[var(--text-2)]">
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] font-medium text-[var(--text-1)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[color-mix(in_oklab,var(--brand)_50%,var(--border-strong))] disabled:opacity-60"
      />
    </label>
  )
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick?: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className="h-10 gap-2 rounded-[8px] border-[var(--border)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-2)]"
    >
      <Icon size={15} />
      {label}
    </Button>
  )
}
