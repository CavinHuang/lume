import { useEffect, useState } from 'react'
import { Database, Loader2, Monitor, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopAssistantSettings as DesktopAssistantSettingsValue,
  type DesktopAssistantStatus,
  type DesktopContextSnapshot,
  type DesktopProactiveProposal,
  type DesktopProactiveProposalStatus,
} from '@lume/shared'
import { sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { buildDesktopAssistantDiagnostics } from './desktop-assistant-settings-state'

export function DesktopAssistantSettings() {
  const [settings, setSettings] = useState<DesktopAssistantSettingsValue | null>(null)
  const [status, setStatus] = useState<DesktopAssistantStatus | null>(null)
  const [activity, setActivity] = useState<DesktopContextSnapshot[]>([])
  const [proposals, setProposals] = useState<DesktopProactiveProposal[]>([])
  const [appsDraft, setAppsDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    const [nextSettings, nextStatus, nextActivity, nextProposals] = await Promise.all([
      sidecarCall<DesktopAssistantSettingsValue>(DESKTOP_CONTEXT_IPC_CHANNELS.GET_SETTINGS),
      sidecarCall<DesktopAssistantStatus>(DESKTOP_CONTEXT_IPC_CHANNELS.GET_STATUS),
      sidecarCall<DesktopContextSnapshot[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_ACTIVITY, { limit: 30 }),
      sidecarCall<DesktopProactiveProposal[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS),
    ])
    setSettings(nextSettings)
    setAppsDraft(nextSettings.allowedApps.join(', '))
    setStatus(nextStatus)
    setActivity(nextActivity)
    setProposals(nextProposals)
  }

  useEffect(() => {
    void refresh().catch((error) => toast.error(error instanceof Error ? error.message : '桌面助手加载失败'))
  }, [])

  const save = async (patch: Partial<DesktopAssistantSettingsValue>) => {
    if (!settings) return
    setSaving(true)
    try {
      const saved = await sidecarCall<DesktopAssistantSettingsValue>(
        DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_SETTINGS,
        { ...settings, ...patch },
      )
      setSettings(saved)
      setAppsDraft(saved.allowedApps.join(', '))
      toast.success('桌面助手设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const updateProposal = async (id: string, status: DesktopProactiveProposalStatus) => {
    await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_PROPOSAL, { id, status })
    await refresh()
  }

  if (!settings) {
    return <div className="lume-panel flex h-60 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载桌面助手...</div>
  }
  const diagnostics = status
    ? buildDesktopAssistantDiagnostics({ settings, status })
    : null

  return (
    <div className="space-y-3">
      <section className="lume-panel overflow-hidden">
        <SettingRow
          icon={<Monitor className="size-4" />}
          title="启用桌面助手"
          description="仅采集白名单应用；默认关闭。Alt+L 会绑定触发前的桌面快照。"
        >
          <Switch checked={settings.enabled} disabled={saving} onCheckedChange={(checked) => void save({ enabled: checked })} />
        </SettingRow>
        <SettingRow
          icon={<ShieldCheck className="size-4" />}
          title="允许的应用"
          description="填写进程名，以逗号分隔，例如 WeChat.exe, Slack.exe。空白名单不会采集。"
        >
          <div className="flex w-[330px] gap-2">
            <Input value={appsDraft} onChange={(event) => setAppsDraft(event.target.value)} placeholder="WeChat.exe, chrome.exe" />
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => void save({ allowedApps: appsDraft.split(',').map((item) => item.trim()).filter(Boolean) })}
            >保存</Button>
          </div>
        </SettingRow>
        <SettingRow title="主动建议" description="本地事件先筛选候选，不会为每个桌面事件调用模型。">
          <Switch checked={settings.proactiveEnabled === true} disabled={saving} onCheckedChange={(checked) => void save({ proactiveEnabled: checked })} />
        </SettingRow>
        <SettingRow title="系统通知" description="通知只显示建议类型和应用名，不显示聊天正文。">
          <Switch checked={settings.notificationsEnabled !== false} disabled={saving} onCheckedChange={(checked) => void save({ notificationsEnabled: checked })} />
        </SettingRow>
      </section>

      <section className="lume-panel p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">运行状态</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Host {status?.host.status ?? 'unavailable'} · 本地加密存储 {formatBytes(status?.store.bytes ?? 0)} · {status?.store.items ?? 0} 条
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => void refresh()}>重新诊断</Button>
        </div>
        {diagnostics && (
          <div className={`mt-3 rounded-xl border px-3 py-2.5 ${diagnosticToneClassName(diagnostics.tone)}`}>
            <p className="text-sm font-medium">{diagnostics.title}</p>
            <ul className="mt-1 space-y-1 text-xs leading-5">
              {diagnostics.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        )}
        {status?.host.message && <p className="mt-3 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{status.host.message}</p>}
      </section>

      <section className="lume-panel p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">主动建议收件箱</h3>
            <p className="mt-1 text-xs text-muted-foreground">只显示建议类型、应用和状态；不显示聊天正文。</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void refresh()}>刷新</Button>
        </div>
        <div className="mt-3 divide-y divide-border/60">
          {proposals.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">暂无主动建议</p>}
          {proposals.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 py-3 text-xs">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{item.summary}</p>
                <p className="mt-1 truncate text-muted-foreground">
                  {item.kind} · {item.status} · {item.app.name}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {item.status === 'pending' && (
                  <Button type="button" variant="secondary" onClick={() => void updateProposal(item.id, 'opened')}>
                    标记已读
                  </Button>
                )}
                {item.status !== 'dismissed' && (
                  <Button type="button" variant="ghost" onClick={() => void updateProposal(item.id, 'dismissed')}>
                    忽略
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lume-panel p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">最近 24 小时活动</h3>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            onClick={() => void sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CLEAR).then(refresh)}
          ><Trash2 className="mr-1.5 size-4" />清除</Button>
        </div>
        <div className="mt-3 divide-y divide-border/60">
          {activity.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">暂无已采集活动</p>}
          {activity.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 py-2.5 text-xs">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{item.app.name} · {item.window.title}</p>
                <p className="truncate text-muted-foreground">{item.eventType}</p>
              </div>
              <time className="shrink-0 text-muted-foreground">{new Date(item.capturedAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function SettingRow({ icon, title, description, children }: {
  icon?: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-20 items-center justify-between gap-6 border-b border-border/60 px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 text-muted-foreground">{icon}</span>}
        <div><p className="text-sm font-medium text-foreground">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function diagnosticToneClassName(tone: 'ok' | 'warning' | 'error'): string {
  if (tone === 'ok') {
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (tone === 'warning') {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300'
  }
  return 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300'
}
