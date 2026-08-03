import { useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Database, Loader2, Monitor, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopAppDiscoveryResult,
  type DesktopAssistantSettings as DesktopAssistantSettingsValue,
  type DesktopAssistantStatus,
  type DesktopContextSnapshot,
  type DesktopProactiveProposal,
  type DesktopProactiveProposalStatus,
} from '@lume/shared'
import { activeTabIdAtom, currentWorkspaceIdAtom, tabsAtom, welcomePromptSeedAtom } from '@/atoms'
import { onSidecarEvent, sidecarCall } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  desktopPermissionRequestCompleted,
  desktopPermissionRequestMessage,
  desktopPermissionRequestToastMessage,
} from '@/components/agent/agent-input-desktop-context'
import { buildDesktopAssistantDiagnostics, toggleAllowedDesktopApp } from './desktop-assistant-settings-state'
import { buildDesktopProposalWelcomeState } from './desktop-assistant-proposals-state'

export function DesktopAssistantSettings() {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const [settings, setSettings] = useState<DesktopAssistantSettingsValue | null>(null)
  const [status, setStatus] = useState<DesktopAssistantStatus | null>(null)
  const [activity, setActivity] = useState<DesktopContextSnapshot[]>([])
  const [proposals, setProposals] = useState<DesktopProactiveProposal[]>([])
  const [appDiscovery, setAppDiscovery] = useState<DesktopAppDiscoveryResult>({ status: 'unavailable', apps: [] })
  const [appsDraft, setAppsDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [permissionRequestLoading, setPermissionRequestLoading] = useState(false)

  const refresh = async () => {
    const [nextSettings, nextStatus, nextActivity, nextProposals, nextAppDiscovery] = await Promise.all([
      sidecarCall<DesktopAssistantSettingsValue>(DESKTOP_CONTEXT_IPC_CHANNELS.GET_SETTINGS),
      sidecarCall<DesktopAssistantStatus>(DESKTOP_CONTEXT_IPC_CHANNELS.GET_STATUS),
      sidecarCall<DesktopContextSnapshot[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_ACTIVITY, { limit: 30 }),
      sidecarCall<DesktopProactiveProposal[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS),
      sidecarCall<DesktopAppDiscoveryResult>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_APPS),
    ])
    setSettings(nextSettings)
    setAppsDraft(nextSettings.allowedApps.join(', '))
    setStatus(nextStatus)
    setActivity(nextActivity)
    setProposals(nextProposals)
    setAppDiscovery(nextAppDiscovery)
  }

  useEffect(() => {
    void refresh().catch((error) => toast.error(error instanceof Error ? error.message : '桌面助手加载失败'))
  }, [])

  useEffect(() => {
    const unlisten = onSidecarEvent((method) => {
      if (method !== DESKTOP_CONTEXT_IPC_CHANNELS.PROPOSAL_UPDATED) return
      void sidecarCall<DesktopProactiveProposal[]>(DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS)
        .then(setProposals)
        .catch(() => undefined)
    })
    return () => { void unlisten.then((dispose) => dispose()) }
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

  const setAppAllowed = async (appId: string, allowed: boolean) => {
    if (!settings) return
    await save({ allowedApps: toggleAllowedDesktopApp(settings.allowedApps, appId, allowed) })
  }

  const handleRequestPermissions = async () => {
    setPermissionRequestLoading(true)
    try {
      const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.REQUEST_PERMISSIONS, {})
      if (desktopPermissionRequestCompleted(result)) {
        toast.success(desktopPermissionRequestToastMessage(result))
      } else {
        toast.info(desktopPermissionRequestMessage(result))
      }
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '启动授权引导失败')
    } finally {
      setPermissionRequestLoading(false)
    }
  }

  const openProposal = async (proposal: DesktopProactiveProposal) => {
    try {
      await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_PROPOSAL, {
        id: proposal.id,
        status: proposal.resultStatus === 'ready' ? 'accepted' : 'opened',
      })
      const next = buildDesktopProposalWelcomeState({ proposal, tabs, currentWorkspaceId })
      setTabs(next.tabs)
      setWelcomePromptSeed(next.promptSeed)
      setActiveTabId(next.activeTabId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开建议失败')
    }
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
          description="只对选中的应用进行后台感知；Alt+L 的用户主动读取不受此白名单限制。"
        >
          <div className="w-[min(430px,48vw)] space-y-2.5">
            {appDiscovery.apps.length > 0 ? (
              <div className="max-h-44 overflow-y-auto rounded-xl border border-border/70 bg-background/50 px-3">
                {appDiscovery.apps.map((app) => {
                  const checked = settings.allowedApps.some((item) => item.toLowerCase() === app.id.toLowerCase())
                  return (
                    <div key={app.id} className="flex min-h-11 items-center justify-between gap-3 border-b border-border/50 last:border-b-0">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{app.name}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">{app.id}</p>
                      </div>
                      <Switch
                        checked={checked}
                        disabled={saving}
                        aria-label={`允许后台感知 ${app.name}`}
                        onCheckedChange={(next) => void setAppAllowed(app.id, next)}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
                {appDiscovery.message || '未发现可见应用，可在下方手动填写应用标识。'}
              </p>
            )}
            <div className="flex gap-2">
              <Input value={appsDraft} onChange={(event) => setAppsDraft(event.target.value)} placeholder="WeChat.exe, com.apple.TextEdit" />
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => void save({ allowedApps: appsDraft.split(',').map((item) => item.trim()).filter(Boolean) })}
              >保存</Button>
            </div>
          </div>
        </SettingRow>
        <SettingRow title="主动建议" description="本地事件先筛选候选，不会为每个桌面事件调用模型。">
          <Switch checked={settings.proactiveEnabled === true} disabled={saving} onCheckedChange={(checked) => void save({ proactiveEnabled: checked })} />
        </SettingRow>
        <SettingRow title="每日回顾" description="17:00 后最多生成一条本地回顾建议，不在系统通知中显示桌面正文。">
          <Switch
            checked={settings.dailyWrapEnabled === true}
            disabled={saving || settings.proactiveEnabled !== true}
            onCheckedChange={(checked) => void save({ dailyWrapEnabled: checked })}
          />
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
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{diagnostics.title}</p>
              {status?.host.status === 'permission_denied' && status.host.permissionTarget && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={permissionRequestLoading}
                  onClick={() => void handleRequestPermissions()}
                  className="shrink-0 border-current/30 bg-background/40"
                >
                  {permissionRequestLoading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  {permissionRequestLoading ? '正在打开授权' : '去授权'}
                </Button>
              )}
            </div>
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
                  {proposalKindLabel(item.kind)} · {item.status} · {proposalResultStatusLabel(item.resultStatus)} · {item.app.name}
                </p>
                {item.resultStatus === 'ready' && item.result && (
                  <div className="mt-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2.5">
                    <p className="font-medium text-foreground">{item.result.title}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{item.result.body}</p>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {(item.status === 'pending' || item.status === 'opened') && (
                  <Button type="button" variant="secondary" onClick={() => void openProposal(item)}>
                    {item.resultStatus === 'ready' ? '采用建议' : '开始处理'}
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

function proposalKindLabel(kind: DesktopProactiveProposal['kind']): string {
  return {
    reply: '回复建议',
    conflict: '冲突处理',
    prompt_rescue: '问题救援',
    daily_wrap: '每日回顾',
    follow_up: '事项跟进',
  }[kind]
}

function proposalResultStatusLabel(status: DesktopProactiveProposal['resultStatus']): string {
  return {
    generating: '正在生成',
    ready: '建议已就绪',
    unavailable: '等待手动处理',
    failed: '生成失败',
  }[status ?? 'unavailable']
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
